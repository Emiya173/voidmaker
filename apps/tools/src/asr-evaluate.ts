import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { readWav } from "../../../packages/adapters/src/pcm.js";
import { transcribe } from "../../../packages/adapters/src/speech-http.js";
import { voiceConfigSchema } from "../../../packages/contracts/src/voice.js";
import { characterErrors, normalizeTranscript } from "../../../packages/domain/src/asr-metrics.js";

const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    config: { type: "string" },
    output: { type: "string" },
    warmup: { type: "boolean", default: false },
  },
});
if (!values.manifest || !values.config || !values.output)
  throw new Error(
    "用法: pnpm asr:evaluate --manifest /path/corpus.json --config /path/voice.json --output /path/report.json [--warmup]",
  );
const manifest = z
  .object({
    cases: z
      .array(
        z.object({
          id: z.string(),
          audio: z.string(),
          reference: z.string().max(10_000),
          keywords: z.array(z.string().min(1)).default([]),
        }),
      )
      .min(1),
  })
  .parse(JSON.parse(await readFile(values.manifest, "utf8")));
const config = voiceConfigSchema.parse(JSON.parse(await readFile(values.config, "utf8")));
if (!config.asr) throw new Error("评测配置缺少 ASR");
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const samples = [];
for (const [index, sample] of manifest.cases.entries()) {
  const wav = await readFile(resolve(dirname(values.manifest), sample.audio));
  if (wav.length > 4 * 1024 * 1024) throw new Error(`录音超过 4 MiB: ${sample.id}`);
  const audio = readWav(wav);
  if (index === 0 && values.warmup) await transcribe(wav, config.asr, controller.signal);
  const start = performance.now();
  try {
    const text = await transcribe(wav, config.asr, controller.signal);
    const latencyMs = performance.now() - start;
    const metric = characterErrors(sample.reference, text);
    const keywordsHit = sample.keywords.filter((keyword) =>
      normalizeTranscript(text).includes(normalizeTranscript(keyword)),
    ).length;
    samples.push({
      id: sample.id,
      reference: sample.reference,
      text,
      ...metric,
      latencyMs,
      duration: audio.duration,
      rtf: latencyMs / (audio.duration * 1000),
      keywordsHit,
      keywords: sample.keywords.length,
      silenceHallucination: metric.characters === 0 && metric.errors > 0,
    });
  } catch (error) {
    controller.signal.throwIfAborted();
    samples.push({
      id: sample.id,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: performance.now() - start,
    });
  }
}
const success = samples.filter((sample) => "characters" in sample);
const characters = success.reduce((sum, sample) => sum + (sample.characters ?? 0), 0);
const errors = success.filter((sample) => sample.characters).reduce((sum, sample) => sum + (sample.errors ?? 0), 0);
const keywords = success.reduce((sum, sample) => sum + (sample.keywords ?? 0), 0);
const keywordsHit = success.reduce((sum, sample) => sum + (sample.keywordsHit ?? 0), 0);
const latency = success.map((sample) => sample.latencyMs).sort((a, b) => a - b);
const report = {
  model: config.asr.model,
  measuredAt: new Date().toISOString(),
  warmed: values.warmup,
  summary: {
    samples: samples.length,
    failures: samples.length - success.length,
    failureRate: (samples.length - success.length) / samples.length,
    cer: characters ? errors / characters : null,
    keywordRecall: keywords ? keywordsHit / keywords : null,
    p50LatencyMs: latency[Math.max(0, Math.ceil(latency.length * 0.5) - 1)] ?? null,
    p95LatencyMs: latency[Math.max(0, Math.ceil(latency.length * 0.95) - 1)] ?? null,
    silenceHallucinations: success.filter((sample) => sample.silenceHallucination).length,
  },
  unmeasured: [
    "streaming first stable token",
    "VAD endpoint delay",
    "GPU memory",
    "process RSS",
    "human perceived quality",
  ],
  samples,
};
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(`已写入 ${values.output}；${success.length}/${samples.length} 条成功`);
if (success.length !== samples.length) process.exitCode = 1;
