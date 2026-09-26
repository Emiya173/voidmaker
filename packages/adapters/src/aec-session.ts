import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { aecArguments } from "../../contracts/src/aec.js";
import type { VoiceConfig } from "../../contracts/src/voice.js";
import { type AudioTiming, advanceAudioTiming, initialAudioTiming } from "../../domain/src/audio-timing.js";
import { advanceBarge, initialBarge } from "../../domain/src/barge-in.js";
import { advanceVad, initialVad } from "../../domain/src/voice.js";
import {
  appendVoiceFrame,
  initialVoiceBuffer,
  interruptVoiceBuffer,
  takeVoiceBuffer,
  voiceBufferLimits,
} from "../../domain/src/voice-buffer.js";
import type { Capture } from "./audio-process.js";
import { type AudioLane, type AudioPacket, createAudioDecoder } from "./audio-tap.js";
import { FRAME_BYTES, rms, wavFromPcm } from "./pcm.js";
import { monitorReferenceGain, pipeWireGraphSchema } from "./pipewire-graph.js";

export type VoiceAudioSession = Readonly<{
  signal: AbortSignal;
  capture: (signal: AbortSignal, onLevel: (level: number) => void) => Capture;
  watchBarge: (signal: AbortSignal, onSpeech: () => void) => () => void;
  close: () => Promise<void>;
  diagnostics?: () => AudioDiagnostics;
}>;

export type AudioDiagnostics = Readonly<{
  input: "raw";
  referenceGain: number;
  streams: Readonly<Record<AudioLane, AudioTiming>>;
  bufferedRawMs: number;
  interruptedRawMs: number;
}>;

/** Created only by an explicit voice_start. Owns the graph until stop/last UI close. */
export async function openAecSession(
  config: VoiceConfig,
  signal: AbortSignal,
  options: Readonly<{
    onDiagnostics?: (value: AudioDiagnostics) => void;
    onPacket?: (packet: AudioPacket) => void;
    diagnosticDirectory?: string;
  }> = {},
): Promise<VoiceAudioSession> {
  const aec = config.aec;
  if (!aec || !config.inputTarget) throw new Error("AEC 需要显式输入和输出设备");
  if (options.diagnosticDirectory && !isAbsolute(options.diagnosticDirectory))
    throw new Error("诊断目录必须为绝对路径");
  signal.throwIfAborted();
  const library = join(aec.pluginDirectory, "aec/libspa-aec-voidmaker.so");
  await access(library);
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  const exec = promisify(execFile);
  const graph = async () =>
    pipeWireGraphSchema.parse(
      JSON.parse(
        (
          await exec("pw-dump", [], {
            signal: active,
            timeout: 2000,
            maxBuffer: 8 * 1024 * 1024,
          })
        ).stdout,
      ),
    );
  const initial = await graph();
  const input = initial.find((node) => node.info?.props?.["node.name"] === config.inputTarget);
  const output = initial.find((node) => node.info?.props?.["node.name"] === aec.outputTarget);
  if (input?.info?.props?.["media.class"] !== "Audio/Source" || output?.info?.props?.["media.class"] !== "Audio/Sink")
    throw new Error("AEC 指定设备不可用，禁止回退默认设备");
  let gain = monitorReferenceGain(output);
  const name = `voidmaker-session-${process.pid}-${crypto.randomUUID()}`;
  const children: { child: ChildProcessWithoutNullStreams; done: Promise<void> }[] = [];
  const listeners = new Set<(frame: Buffer) => void>();
  const cleanListeners = new Set<(frame: Buffer) => void>();
  let referenceLevel = 0;
  let referenceAt = 0;
  let settleUntil = 0;
  let rawAt = 0;
  let rawLevel = 0;
  let buffer = initialVoiceBuffer<Buffer>();
  const bufferLimits = voiceBufferLimits(aec.confirmationMs);
  let timing: Readonly<Record<AudioLane, AudioTiming>> = {
    raw: initialAudioTiming,
    clean: initialAudioTiming,
    reference: initialAudioTiming,
  };
  const diagnostics = (): AudioDiagnostics => ({
    input: "raw",
    referenceGain: gain,
    streams: timing,
    bufferedRawMs: buffer.recent.length * 30,
    interruptedRawMs: (buffer.interrupted?.length ?? 0) * 30,
  });
  let capturing = false;
  let closed: Promise<void> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: unknown) => controller.abort(error instanceof Error ? error : new Error(String(error)));
  const launch = (executable: string, args: string[], onData?: (data: Buffer) => void) => {
    active.throwIfAborted();
    const child = spawn(executable, args, { stdio: "pipe" });
    let stderr = "";
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", onData ?? (() => undefined));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const done = new Promise<void>((resolve) => {
      child.once("error", fail);
      child.once("close", () => {
        if (!active.aborted) fail(new Error(`${executable} 意外退出: ${stderr}`));
        resolve();
      });
    });
    children.push({ child, done });
    return child;
  };
  const close = () => {
    if (closed) return closed;
    controller.abort(new Error("AEC 会话已关闭"));
    clearTimeout(poll);
    buffer = initialVoiceBuffer();
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    closed = (async () => {
      const kill = setTimeout(() => {
        for (const { child } of children)
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1000);
      await Promise.all(children.map(({ done }) => done));
      clearTimeout(kill);
      listeners.clear();
      cleanListeners.clear();
    })();
    return closed;
  };
  // Defer close to avoid recursion while close itself aborts the controller.
  active.addEventListener("abort", () => queueMicrotask(() => void close()), { once: true });
  const strictTarget = { "node.dont-fallback": true, "node.dont-reconnect": true, "state.restore-props": false };
  try {
    launch(join(aec.pluginDirectory, "../../bin/voidmaker-aec-pw-cli"), [
      "--monitor",
      "load-module",
      "libpipewire-module-echo-cancel",
      JSON.stringify({
        "library.name": "aec/libspa-aec-voidmaker",
        "audio.rate": 48000,
        "audio.channels": 1,
        "audio.position": ["MONO"],
        "node.latency": "480/48000",
        "monitor.mode": true,
        "aec.args": {
          ...aecArguments(aec.settings),
          ...(options.diagnosticDirectory
            ? {
                "webrtc.aec3.stats-dump": join(options.diagnosticDirectory, "aec-statistics.jsonl"),
                "webrtc.aec3.linear-dump": join(options.diagnosticDirectory, "linear.f32"),
              }
            : {}),
        },
        "capture.props": {
          ...strictTarget,
          "node.name": `${name}.capture`,
          "target.object": config.inputTarget,
          "node.passive": true,
        },
        "source.props": { ...strictTarget, "node.name": `${name}.source`, "priority.session": 0 },
        "sink.props": {
          ...strictTarget,
          "node.name": `${name}.reference`,
          "target.object": aec.outputTarget,
          "node.param.Props": { volume: gain },
        },
      }),
    ]);
    let referenceId: number | undefined;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      active.throwIfAborted();
      const nodes = await graph();
      referenceId = nodes.find((node) => node.info?.props?.["node.name"] === `${name}.reference`)?.id;
      if (referenceId !== undefined && nodes.some((node) => node.info?.props?.["node.name"] === `${name}.source`)) {
        ready = true;
        break;
      }
      await delay(100, undefined, { signal: active });
    }
    if (!ready) throw new Error("AEC 节点未就绪");
    const remainder: Record<AudioLane, Buffer> = {
      raw: Buffer.alloc(0),
      clean: Buffer.alloc(0),
      reference: Buffer.alloc(0),
    };
    const decoder = createAudioDecoder((packet) => {
      if (active.aborted) return;
      const now = Number(process.hrtime.bigint()) / 1e6;
      const previous = timing[packet.lane];
      const next = advanceAudioTiming(previous, { ...packet, samples: packet.pcm.length / 2, receivedMs: now });
      timing = { ...timing, [packet.lane]: next };
      options.onPacket?.(packet);
      if (next.sequenceGaps || next.corrupted || (previous.packets && packet.flags & 1))
        throw new Error(`${packet.lane} 音频发生不连续或损坏，已停止会话`);
      if (now - packet.callbackMs > 500) throw new Error("音频 IPC 积压，已停止会话");
      remainder[packet.lane] = Buffer.concat([remainder[packet.lane], packet.pcm]);
      while (!active.aborted && remainder[packet.lane].length >= FRAME_BYTES) {
        const frame = Buffer.from(remainder[packet.lane].subarray(0, FRAME_BYTES));
        remainder[packet.lane] = remainder[packet.lane].subarray(FRAME_BYTES);
        if (packet.lane === "reference") {
          referenceLevel = rms(frame) * gain;
          referenceAt = performance.now();
        } else if (packet.lane === "raw") {
          rawAt = performance.now();
          rawLevel = rms(frame);
          buffer = appendVoiceFrame(buffer, frame, bufferLimits);
          for (const listener of listeners) listener(frame);
        } else {
          for (const listener of cleanListeners) listener(frame);
        }
      }
    });
    launch(
      join(aec.pluginDirectory, "../../bin/voidmaker-audio-capture"),
      [config.inputTarget, `${name}.source`, aec.outputTarget],
      (chunk) => {
        try {
          decoder.feed(chunk);
        } catch (error) {
          fail(error);
        }
      },
    );
    for (let i = 0; !Object.values(timing).every((value) => value.samples >= 480) && i < 50; i++)
      await delay(100, undefined, { signal: active });
    if (!Object.values(timing).every((value) => value.samples >= 480)) throw new Error("三路音频未就绪，检查路由");
    const updateVolume = async () => {
      try {
        active.throwIfAborted();
        const nodes = await graph();
        if (
          !nodes.some(
            (node) =>
              node.id === input.id && node.info?.props?.["object.serial"] === input.info?.props?.["object.serial"],
          )
        )
          throw new Error("AEC 输入设备已断开");
        const current = nodes.find(
          (node) =>
            node.id === output.id && node.info?.props?.["object.serial"] === output.info?.props?.["object.serial"],
        );
        if (!current) throw new Error("AEC 输出设备已断开");
        const next = monitorReferenceGain(current);
        if (next !== gain) {
          settleUntil = performance.now() + 500;
          referenceAt = 0;
          buffer = { ...buffer, recent: [] };
          await exec("pw-cli", ["set-param", String(referenceId), "Props", JSON.stringify({ volume: next })], {
            signal: active,
            timeout: 2000,
          });
          gain = next;
        }
        const now = Number(process.hrtime.bigint()) / 1e6;
        for (const [lane, value] of Object.entries(timing))
          if (!value.latest || now - value.latest.callbackMs > 500) throw new Error(`${lane} 音频停止更新`);
        options.onDiagnostics?.(diagnostics());
        if (!active.aborted) poll = setTimeout(() => void updateVolume(), 250);
      } catch (error) {
        if (!active.aborted) fail(error);
      }
    };
    poll = setTimeout(() => void updateVolume(), 250);
    return {
      signal: active,
      close,
      diagnostics,
      capture(captureSignal, onLevel) {
        active.throwIfAborted();
        captureSignal.throwIfAborted();
        if (capturing) throw new Error("AEC 已在录制轮次");
        const pending = takeVoiceBuffer(buffer);
        buffer = pending.state;
        let frames = [...pending.frames];
        if (frames.length * 30 >= config.vad.maxRecordingMs)
          throw new Error("插话缓冲超过最大录音时长，请增大 maxRecordingMs");
        capturing = true;
        let vad = initialVad;
        for (const frame of frames) vad = advanceVad(vad, rms(frame), 30, config.vad).state;
        let finish: () => void = () => undefined;
        const result = new Promise<Buffer>((resolve, reject) => {
          let settled = false;
          const done = (error?: unknown) => {
            if (settled) return;
            settled = true;
            capturing = false;
            clearTimeout(timer);
            listeners.delete(onFrame);
            active.removeEventListener("abort", abort);
            captureSignal.removeEventListener("abort", abort);
            if (error) reject(error);
            else if (vad.speechMs < config.vad.minSpeechMs) reject(new Error("未检测到足够语音"));
            else resolve(wavFromPcm(Buffer.concat(frames)));
            frames = [];
          };
          const abort = () => done(active.reason ?? captureSignal.reason ?? new Error("录音已取消"));
          const onFrame = (frame: Buffer) => {
            frames.push(frame);
            const level = rms(frame),
              step = advanceVad(vad, level, 30, config.vad);
            vad = step.state;
            if (vad.elapsedMs % 120 === 0) onLevel(level);
            if (step.done) done();
          };
          const timer = setTimeout(() => done(), config.vad.maxRecordingMs + 1000);
          finish = () => done();
          listeners.add(onFrame);
          active.addEventListener("abort", abort, { once: true });
          captureSignal.addEventListener("abort", abort, { once: true });
        });
        return { result, finish };
      },
      watchBarge(watchSignal, onSpeech) {
        active.throwIfAborted();
        watchSignal.throwIfAborted();
        let state = initialBarge;
        const onFrame = (frame: Buffer) => {
          if (watchSignal.aborted || active.aborted || state.triggered) return;
          const now = performance.now();
          const rawTiming = timing.raw.latest?.graph;
          const cleanTiming = timing.clean.latest?.graph;
          const delayDifference =
            rawTiming && cleanTiming
              ? Math.abs(cleanTiming.delayMs + cleanTiming.bufferedMs - rawTiming.delayMs - rawTiming.bufferedMs)
              : Number.POSITIVE_INFINITY;
          state = advanceBarge(
            state,
            {
              rawLevel,
              cleanLevel: rms(frame),
              referenceLevel,
              referenceFresh:
                now - referenceAt < 150 && now - rawAt < 150 && now >= settleUntil && delayDifference <= 300,
              durationMs: 30,
            },
            aec,
          );
          if (state.triggered) {
            buffer = interruptVoiceBuffer(buffer);
            onSpeech();
          }
        };
        const stop = () => {
          cleanListeners.delete(onFrame);
          watchSignal.removeEventListener("abort", stop);
        };
        cleanListeners.add(onFrame);
        watchSignal.addEventListener("abort", stop, { once: true });
        return stop;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
