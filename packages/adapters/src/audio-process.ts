import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { VoiceConfig } from "../../contracts/src/voice.js";
import { advanceVad, initialVad } from "../../domain/src/voice.js";
import { FRAME_BYTES, readWav, rms, wavFromPcm } from "./pcm.js";

function processHandle(executable: string, args: string[]) {
  const child = spawn(executable, args, { stdio: "pipe" });
  let error: Error | undefined;
  let stderr = "";
  child.on("error", (value) => {
    error = value;
  });
  child.stdin.on("error", () => undefined);
  child.stderr.on("data", (value: Buffer) => {
    stderr = (stderr + value.toString()).slice(-2000);
  });
  const exited = new Promise<{ code: number | null; error: Error | undefined }>((resolve) => {
    child.once("close", (code) =>
      resolve({ code, error: error ?? (code ? new Error(`${executable}: ${stderr}`) : undefined) }),
    );
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    try {
      return await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  return { child, exited, stop };
}

export type Capture = { result: Promise<Buffer>; finish: () => void };
export function captureAudio(
  config: VoiceConfig,
  signal: AbortSignal,
  onLevel: (level: number) => void,
  executable = "pw-record",
  prefixArgs: string[] = [],
): Capture {
  signal.throwIfAborted();
  const args = ["--raw", "--format", "s16", "--rate", "16000", "--channels", "1"];
  if (config.inputTarget) args.push("--target", config.inputTarget);
  const handle = processHandle(executable, [...prefixArgs, ...args, "-"]);
  const chunks: Buffer[] = [];
  let remainder: Buffer = Buffer.alloc(0);
  let vad = initialVad;
  let finishing = false;
  let failure: Error | undefined;
  let received = false;
  const finish = () => {
    if (!finishing) {
      finishing = true;
      void handle.stop();
    }
  };
  const abort = () => {
    failure = new Error("录音已取消");
    finish();
  };
  signal.addEventListener("abort", abort, { once: true });
  const deviceTimer = setTimeout(() => {
    if (!received) {
      failure = new Error("麦克风没有输出，请检查 PipeWire 默认输入或 inputTarget");
      finish();
    }
  }, 5000);
  const limitTimer = setTimeout(finish, config.vad.maxRecordingMs + 1000);
  handle.child.stdout.on("data", (chunk: Buffer) => {
    if (finishing) return;
    received = true;
    remainder = Buffer.concat([remainder, chunk]);
    while (remainder.length >= FRAME_BYTES && !finishing) {
      const frame = remainder.subarray(0, FRAME_BYTES);
      remainder = remainder.subarray(FRAME_BYTES);
      chunks.push(frame);
      const level = rms(frame);
      const step = advanceVad(vad, level, 30, config.vad);
      vad = step.state;
      if (vad.elapsedMs % 120 === 0) onLevel(level);
      if (step.done) finish();
    }
  });
  const result = (async () => {
    try {
      const exit = await handle.exited;
      signal.throwIfAborted();
      if (failure) throw failure;
      if (!finishing) throw exit.error ?? new Error("录音设备意外停止");
      if (vad.speechMs < config.vad.minSpeechMs) throw new Error("未检测到足够语音，请检查麦克风和输入音量");
      return wavFromPcm(Buffer.concat(chunks));
    } finally {
      clearTimeout(deviceTimer);
      clearTimeout(limitTimer);
      signal.removeEventListener("abort", abort);
      await handle.stop();
    }
  })();
  return { result, finish };
}

async function connectIpc(path: string, signal: AbortSignal): Promise<Socket> {
  for (let i = 0; i < 100; i++) {
    signal.throwIfAborted();
    const socket = createConnection(path);
    const connected = await new Promise<boolean>((resolve) => {
      socket.once("connect", () => resolve(true));
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return socket;
    await delay(30, undefined, { signal });
  }
  throw new Error("无法连接播放器进度接口");
}

export type PlaybackProgress = Readonly<{ position: number; duration: number; level: number }>;
export async function playAudio(
  wav: Buffer,
  signal: AbortSignal,
  onProgress: (progress: PlaybackProgress) => void,
  options: { executable?: string; prefixArgs?: string[]; runtimeDirectory?: string } = {},
): Promise<void> {
  signal.throwIfAborted();
  const audio = readWav(wav);
  const runtime = options.runtimeDirectory ?? process.env.XDG_RUNTIME_DIR;
  if (!runtime) throw new Error("XDG_RUNTIME_DIR 未设置");
  const directory = await mkdtemp(join(runtime, "voidmaker-audio-"));
  let handle: ReturnType<typeof processHandle> | undefined;
  let socket: Socket | undefined;
  const abort = () => {
    socket?.destroy();
    if (handle) void handle.stop();
  };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(audio.duration * 1000) + 15_000)]);
  try {
    const filename = join(directory, "speech.wav");
    const ipc = join(directory, "mpv.sock");
    await writeFile(filename, wav, { mode: 0o600 });
    deadline.throwIfAborted();
    handle = processHandle(options.executable ?? "mpv", [
      ...(options.prefixArgs ?? []),
      "--no-config",
      "--no-terminal",
      "--no-video",
      "--force-window=no",
      "--keep-open=no",
      "--idle=no",
      "--pause",
      `--input-ipc-server=${ipc}`,
      filename,
    ]);
    handle.child.stdout.resume();
    deadline.addEventListener("abort", abort, { once: true });
    socket = await connectIpc(ipc, deadline);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (data: string) => {
      buffer += data;
      if (buffer.length > 64 * 1024) {
        socket?.destroy();
        void handle?.stop();
        return;
      }
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let event: { event?: string; name?: string; data?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event?.event !== "property-change" || event.name !== "time-pos" || typeof event.data !== "number") continue;
        const position = Math.max(0, Math.min(audio.duration, event.data));
        const start = Math.floor(position * audio.rate) * audio.channels * 2;
        const end = Math.min(audio.pcm.length, start + Math.floor(audio.rate * 0.04) * audio.channels * 2);
        onProgress({ position, duration: audio.duration, level: rms(audio.pcm.subarray(start, end)) });
      }
    });
    socket.write(`${JSON.stringify({ command: ["observe_property", 1, "time-pos"] })}\n`);
    socket.write(`${JSON.stringify({ command: ["set_property", "pause", false] })}\n`);
    const exit = await handle.exited;
    deadline.throwIfAborted();
    if (exit.error || exit.code !== 0) throw exit.error ?? new Error("播放器异常退出");
  } finally {
    deadline.removeEventListener("abort", abort);
    socket?.destroy();
    if (handle) await handle.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
