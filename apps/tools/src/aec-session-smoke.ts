import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  type AudioDiagnostics,
  openAecSession,
  type VoiceAudioSession,
} from "../../../packages/adapters/src/aec-session.js";
import { type Capture, playAudio } from "../../../packages/adapters/src/audio-process.js";
import type { AudioLane } from "../../../packages/adapters/src/audio-tap.js";
import { readWav, wavFromPcm } from "../../../packages/adapters/src/pcm.js";
import { voiceConfigSchema } from "../../../packages/contracts/src/voice.js";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    directory: { type: "string" },
    seconds: { type: "string", default: "20" },
    reference: { type: "string" },
    "confirm-microphone": { type: "boolean", default: false },
  },
});
const seconds = Number(values.seconds);
if (
  !values["confirm-microphone"] ||
  !values.config ||
  !values.directory ||
  !Number.isInteger(seconds) ||
  seconds < 3 ||
  seconds > 60
)
  throw new Error(
    "有人值守：--confirm-microphone --config FILE --directory NEW_DIR [--seconds 3..60] [--reference WAV]",
  );
const config = voiceConfigSchema.parse(JSON.parse(await readFile(values.config, "utf8")));
if (!config.aec || !config.inputTarget) throw new Error("诊断配置需要显式 AEC 和设备，无需修改运行中的 Host 配置");
const reference = values.reference ? await readFile(values.reference) : undefined;
if (reference && readWav(reference).duration > seconds) throw new Error("参考音频比诊断时长长");
process.umask(0o077);
const directory = resolve(values.directory);
await mkdir(directory, { mode: 0o700 });
const controller = new AbortController();
process.once("SIGINT", () => controller.abort(new Error("用户取消")));
process.once("SIGTERM", () => controller.abort(new Error("用户取消")));
const playbackAbort = new AbortController();
const chunks: Record<AudioLane, Buffer[]> = { raw: [], clean: [], reference: [] };
const bytes: Record<AudioLane, number> = { raw: 0, clean: 0, reference: 0 };
const timeline: unknown[] = [];
const snapshots: AudioDiagnostics[] = [];
let session: VoiceAudioSession | undefined;
let playback: Promise<void> | undefined;
let stopWatching: (() => void) | undefined;
let capture: Capture | undefined;
let captured: Promise<void> | undefined;
let recognitionWav: Buffer | undefined;
let failure: string | undefined;
let interruptionMs: number | undefined;
const startedMs = Number(process.hrtime.bigint()) / 1e6;
const noteFailure = (error: unknown) => {
  failure ??= error instanceof Error ? error.message : String(error);
};
try {
  console.log(`开始 ${seconds} 秒三路音频诊断；录音只保存在指定本地目录。`);
  session = await openAecSession(config, controller.signal, {
    diagnosticDirectory: directory,
    onPacket(packet) {
      bytes[packet.lane] += packet.pcm.length;
      if (bytes[packet.lane] > (seconds + 10) * 32000 || timeline.length >= 100000) throw new Error("诊断数据超限");
      chunks[packet.lane].push(packet.pcm);
      const { pcm, ...metadata } = packet;
      timeline.push({ ...metadata, samples: pcm.length / 2 });
    },
    onDiagnostics(value) {
      snapshots.push(value);
    },
  });
  if (reference) {
    stopWatching = session.watchBarge(controller.signal, () => {
      interruptionMs = Number(process.hrtime.bigint()) / 1e6 - startedMs;
      playbackAbort.abort();
      captured = (async () => {
        await playback;
        if (!session) throw new Error("音频会话未就绪");
        capture = session.capture(controller.signal, () => {});
        recognitionWav = await capture.result;
      })().catch(noteFailure);
    });
    playback = playAudio(reference, AbortSignal.any([controller.signal, playbackAbort.signal]), () => {}, {
      outputTarget: config.aec.outputTarget,
    }).catch((error: unknown) => {
      if (!playbackAbort.signal.aborted) {
        noteFailure(error);
        controller.abort(error);
      }
    });
    void playback.finally(() => stopWatching?.());
  }
  await delay(seconds * 1000, undefined, { signal: session.signal });
} catch (error) {
  noteFailure(error);
} finally {
  playbackAbort.abort();
  stopWatching?.();
  await playback;
  capture?.finish();
  if (captured) await captured;
  if (session?.diagnostics) snapshots.push(session.diagnostics());
  await session?.close();
  for (const lane of ["raw", "clean", "reference"] as const)
    if (bytes[lane])
      await writeFile(join(directory, `${lane}.wav`), wavFromPcm(Buffer.concat(chunks[lane])), {
        mode: 0o600,
        flag: "wx",
      });
  if (recognitionWav) await writeFile(join(directory, "recognition.wav"), recognitionWav, { mode: 0o600, flag: "wx" });
  await writeFile(join(directory, "timing.jsonl"), timeline.map((value) => JSON.stringify(value)).join("\n"), {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(
      {
        requestedSeconds: seconds,
        startedMonotonicMs: startedMs,
        failure: failure ?? null,
        interruptionMs: interruptionMs ?? null,
        recognitionSeconds: recognitionWav ? readWav(recognitionWav).duration : null,
        laneSeconds: Object.fromEntries(Object.entries(bytes).map(([lane, size]) => [lane, size / 32000])),
        snapshots,
        note: "独立时间线，WAV 起点不保证同步；回放音频未调用 ASR/Codex。内部 ERLE 不是实测消除量。",
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  console.log(`采集已关闭，诊断已保存：${directory}${failure ? `；${failure}` : ""}`);
}
if (failure) process.exitCode = 1;
