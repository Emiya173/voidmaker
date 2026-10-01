import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { AudioDevice, DiagnosticResult } from "../../contracts/src/settings.js";
import { speechModelSchema, type VoiceConfig } from "../../contracts/src/voice.js";
import { pipeWireGraphSchema } from "./pipewire-graph.js";

const exec = promisify(execFile);
export function audioDevices(value: unknown): readonly AudioDevice[] {
  return pipeWireGraphSchema
    .parse(value)
    .flatMap((node): AudioDevice[] => {
      const props = node.info?.props;
      const name = props?.["node.name"],
        kind = props?.["media.class"];
      if (typeof name !== "string" || !["Audio/Source", "Audio/Sink"].includes(String(kind))) return [];
      return [
        {
          name,
          kind: kind === "Audio/Source" ? "input" : "output",
          description: String(props?.["node.description"] ?? name),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function inspectDevices(signal: AbortSignal): Promise<readonly AudioDevice[]> {
  const result = await exec("pw-dump", [], { signal, timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
  return audioDevices(JSON.parse(result.stdout));
}
async function json(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("响应为空");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 1024 * 1024) throw new Error("响应超过 1 MiB");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function inspectModel(
  id: "asr" | "tts",
  config: VoiceConfig,
  signal: AbortSignal,
): Promise<DiagnosticResult> {
  const endpoint = config[id],
    label = id.toUpperCase();
  if (!endpoint) return { id, label, status: "unconfigured", detail: "未启用" };
  const url = endpoint.healthUrl ?? new URL(id === "asr" ? "/health" : "/openapi.json", endpoint.url).href;
  const value = await json(url, signal);
  if (id === "tts" && !endpoint.healthUrl) {
    const doc = z.object({ paths: z.record(z.string(), z.unknown()) }).parse(value);
    if (!(new URL(endpoint.url).pathname in doc.paths)) throw new Error("服务未声明配置的合成接口");
    return { id, label, status: "reachable", detail: "合成接口可连接；未生成音频，模型预热与参考声音未验证" };
  }
  const health = z
    .object({
      ready: z.boolean().optional(),
      model: id === "tts" ? z.union([z.string(), speechModelSchema]).nullish() : z.string().optional(),
    })
    .parse(value);
  if (id === "asr" && health.model && health.model !== config.asr?.model) throw new Error("服务报告的模型与配置不一致");
  return {
    id,
    label,
    status: health.ready === true ? "ready" : health.ready === false ? "warming" : "reachable",
    detail:
      health.ready === true
        ? "服务报告模型已就绪；未进行推理"
        : health.ready === false
          ? "服务在线，模型尚未就绪或正在预热"
          : "接口可连接，未报告模型就绪状态",
  };
}
export async function inspectAec(config: VoiceConfig): Promise<DiagnosticResult> {
  if (!config.aec) return { id: "aec", label: "AEC 插件", status: "unconfigured", detail: "未启用" };
  await access(join(config.aec.pluginDirectory, "aec/libspa-aec-voidmaker.so"));
  return { id: "aec", label: "AEC 插件", status: "reachable", detail: "插件文件可访问；未启动音频图或验证声学效果" };
}
