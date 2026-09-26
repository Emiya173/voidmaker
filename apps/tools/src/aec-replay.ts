import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { wavFromPcm } from "../../../packages/adapters/src/pcm.js";
import { aecArguments, aecSettingsSchema } from "../../../packages/contracts/src/aec.js";

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    internal: { type: "string" },
    directory: { type: "string" },
    settings: { type: "string", default: "{}" },
  },
});
if (!values.package || !values.internal || !values.directory)
  throw new Error(
    "用法: pnpm aec:replay --package /nix/store/package --internal internal.wav --directory NEW_DIR [--settings JSON]",
  );
const settings = aecSettingsSchema.parse(JSON.parse(values.settings));
const directory = resolve(values.directory);
const pkg = resolve(values.package);
const wav = await readFile(values.internal);
if (wav.length > 32 * 1024 * 1024 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
  throw new Error("内部录音格式或大小无效");
let validFormat = false;
let data: Buffer | undefined;
for (let offset = 12; offset + 8 <= wav.length; ) {
  const start = offset + 8;
  const tag = wav.toString("ascii", offset, offset + 4);
  const declaredSize = wav.readUInt32LE(offset + 4);
  // PipeWire's diagnostic writer uses the streaming sentinel until a graceful close.
  const size = tag === "data" && declaredSize === 0xffffffff ? wav.length - start : declaredSize;
  if (start + size > wav.length) throw new Error("内部录音截断");
  if (tag === "fmt ")
    validFormat =
      size >= 16 &&
      wav.readUInt16LE(start) === 3 &&
      wav.readUInt16LE(start + 2) === 3 &&
      wav.readUInt32LE(start + 4) === 48000 &&
      wav.readUInt16LE(start + 14) === 32;
  if (tag === "data") data = wav.subarray(start, start + size);
  offset = start + size + (size % 2);
}
if (!validFormat || !data?.length || data.length % (480 * 3 * 4))
  throw new Error("需要完整 10 ms 帧的 48 kHz float32 三声道内部录音");
const channels = Array.from({ length: 3 }, () => Buffer.alloc((data?.length ?? 0) / 3));
for (let frame = 0; frame < data.length / 12; frame++)
  for (const [index, channel] of channels.entries()) {
    const value = data.readFloatLE(frame * 12 + index * 4);
    if (!Number.isFinite(value) || Math.abs(value) > 16) throw new Error("录音包含无效浮点样本");
    channel.writeFloatLE(value, frame * 4);
  }
await mkdir(directory, { mode: 0o700 });
const names = ["reference", "capture", "original-output"];
for (const [index, channel] of channels.entries())
  await writeFile(join(directory, `${names[index]}.f32`), channel, { mode: 0o600, flag: "wx" });
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
await promisify(execFile)(
  join(pkg, "bin/voidmaker-aec-replay"),
  [
    join(pkg, "lib/spa-0.2/aec/libspa-aec-voidmaker.so"),
    join(directory, "capture.f32"),
    join(directory, "reference.f32"),
    join(directory, "output.f32"),
    ...Object.entries(aecArguments(settings)).map(([key, value]) => `${key}=${value}`),
    `webrtc.aec3.linear-dump=${join(directory, "linear.f32")}`,
    `webrtc.aec3.stats-dump=${join(directory, "statistics.jsonl")}`,
  ],
  { signal: controller.signal, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 },
);
// Keep float32 stages for analysis. PCM16 WAVs are listening/ASR derivatives.
for (const name of ["reference", "capture", "original-output", "output", "linear"]) {
  const bytes = await readFile(join(directory, `${name}.f32`));
  const expected = name === "linear" ? data.length / 9 : data.length / 3;
  if (bytes.length !== expected) throw new Error(`${name} 样本数不完整`);
  const pcm = Buffer.alloc(bytes.length / 2);
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const value = bytes.readFloatLE(offset);
    if (!Number.isFinite(value)) throw new Error("插件产生无效浮点样本");
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32768))), offset / 2);
  }
  await writeFile(join(directory, `${name}.wav`), wavFromPcm(pcm, name === "linear" ? 16000 : 48000), {
    mode: 0o600,
    flag: "wx",
  });
}
await writeFile(
  join(directory, "report.json"),
  JSON.stringify(
    {
      settings,
      plugin: pkg,
      seconds: data.length / 12 / 48000,
      stages: ["capture", "linear", "output"],
      source: resolve(values.internal),
    },
    null,
    2,
  ),
  { mode: 0o600, flag: "wx" },
);
console.log(`离线重放完成：${directory}；未连接音频设备`);
