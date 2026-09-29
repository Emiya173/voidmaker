import { describe, expect, it, vi } from "vitest";
import { VoiceController, type VoicePorts } from "../apps/host/src/voice.js";
import type { VoiceAudioSession } from "../packages/adapters/src/aec-session.js";
import { advanceBarge, initialBarge } from "../packages/domain/src/barge-in.js";
import { speechSegments } from "../packages/domain/src/voice.js";

const reply = (text: string) =>
  speechSegments(text).map((subtitle) => ({ subtitle, text: subtitle, referenceId: "neutral" }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const device = new AbortController();
  let speech = () => {};
  const unwatch = vi.fn();
  const session: VoiceAudioSession = {
    signal: device.signal,
    capture: vi.fn(() => ({ result: Promise.resolve(Buffer.alloc(0)), finish: vi.fn() })),
    watchBarge: vi.fn((_signal, callback) => {
      speech = callback;
      return unwatch;
    }),
    close: vi.fn(async () => {}),
  };
  const ports: VoicePorts = {
    capture: vi.fn(() => {
      throw new Error("必须使用会话录音");
    }),
    openSession: vi.fn(async () => session),
    transcribe: vi.fn(async () => "检查数据库"),
    synthesize: vi.fn(async () => Buffer.alloc(0)),
    play: vi.fn(async () => {}),
    submit: vi.fn(async () => {}),
    publish: vi.fn(),
  };
  return { device, session, ports, unwatch, speech: () => speech() };
}
describe("persistent voice sessions", () => {
  it("allows barge-in during a model-selected opener and drops the prefetched continuation", async () => {
    const { ports, speech, session } = fixture();
    const recording = Buffer.from("original");
    const play = vi.fn(
      (_wav: Buffer, signal: AbortSignal) =>
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    );
    const voice = new VoiceController({ ...ports, play, recordedClip: () => recording }, true, true, true);
    voice.listen(true);
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("review"));
    const speaking = voice.speak(
      [
        { subtitle: "对不起。", text: "ごめんなさい。", referenceId: "neutral", clipId: "apology" },
        ...reply("后续。再后续。"),
      ],
      voice.beginReply(),
    );
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(play.mock.calls[0]?.[0]).toBe(recording);
    speech();
    await speaking;
    expect(ports.synthesize).toHaveBeenCalledOnce();
    expect(vi.mocked(ports.synthesize).mock.calls[0]?.[1].aborted).toBe(true);
    expect(play).toHaveBeenCalledOnce();
    voice.resumeListening();
    expect(session.capture).toHaveBeenCalledTimes(2);
    expect(ports.openSession).toHaveBeenCalledOnce();
    await voice.cancel();
  });
  it("interrupts the model during a waiting clip and resumes the existing session without stale speech", async () => {
    const { ports, speech, session } = fixture();
    const interruptReply = vi.fn(async () => {});
    const play = vi.fn(
      (_wav: Buffer, signal: AbortSignal) =>
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    );
    const voice = new VoiceController(
      { ...ports, play, interruptReply, waitingClip: () => ({ wav: Buffer.alloc(0), subtitle: "嗯……" }) },
      true,
      true,
      true,
    );
    voice.listen(true);
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("review"));
    vi.useFakeTimers();
    try {
      const generation = voice.beginReply();
      await vi.advanceTimersByTimeAsync(2000);
      expect(play).toHaveBeenCalledOnce();
      speech();
      expect(interruptReply).toHaveBeenCalledOnce();
      expect(voice.wasInterrupted(generation)).toBe(true);
      await voice.speak(reply("过期回复。"), generation);
      expect(ports.synthesize).not.toHaveBeenCalled();
      expect(voice.snapshot.phase).toBe("idle");
      voice.resumeListening();
      expect(session.capture).toHaveBeenCalledTimes(2);
      await voice.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
  it("never opens a microphone for a text reply and closes single-turn input before ASR", async () => {
    const { ports, session } = fixture();
    const voice = new VoiceController(ports, true, true, true);
    await voice.speak(reply("文字回复"), voice.beginReply());
    expect(ports.openSession).not.toHaveBeenCalled();
    voice.listen();
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("review"));
    expect(session.close).toHaveBeenCalledOnce();
    expect(vi.mocked(session.close).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ports.transcribe).mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("waits for a cancelled session startup and discards its late completion", async () => {
    const { ports, session } = fixture();
    const opened = deferred<VoiceAudioSession>();
    const voice = new VoiceController({ ...ports, openSession: () => opened.promise }, true, true, true);
    voice.listen(true);
    expect(voice.snapshot.phase).toBe("preparing");
    const stopped = voice.cancel();
    expect(() => voice.listen()).toThrow();
    opened.resolve(session);
    await stopped;
    expect(session.close).toHaveBeenCalledOnce();
    expect(session.capture).not.toHaveBeenCalled();
    expect(ports.submit).not.toHaveBeenCalled();
    expect(voice.snapshot.phase).toBe("idle");
  });
  it("interrupts playback, skips queued speech and reuses the session only after host resume", async () => {
    const { ports, session, speech, unwatch } = fixture();
    const play = vi.fn(
      (_wav: Buffer, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const voice = new VoiceController({ ...ports, play }, true, true, true);
    voice.listen(true);
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("review"));
    const speaking = voice.speak(reply("第一句。第二句。第三句。"), voice.beginReply());
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
    speech();
    expect(voice.snapshot.phase).toBe("interrupting");
    await speaking;
    expect(ports.synthesize).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ports.synthesize).mock.calls[1]?.[1].aborted).toBe(true);
    expect(unwatch).toHaveBeenCalledOnce();
    expect(session.capture).toHaveBeenCalledOnce();
    speech(); // already removed watcher must not change the completed turn
    expect(voice.snapshot.phase).toBe("idle");
    voice.resumeListening();
    expect(session.capture).toHaveBeenCalledTimes(2);
    expect(ports.openSession).toHaveBeenCalledOnce();
    await voice.cancel();
    speech();
    voice.resumeListening();
    expect(session.capture).toHaveBeenCalledTimes(2);
    expect(session.close).toHaveBeenCalledOnce();
  });
  it("keeps stopping until device cleanup completes, then allows a fresh session", async () => {
    const { ports, device, session } = fixture();
    const cleanup = deferred<void>();
    vi.mocked(session.close).mockImplementation(() => cleanup.promise);
    const voice = new VoiceController(ports, true, true, true);
    voice.listen(true);
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("review"));
    device.abort(new Error("设备断开"));
    expect(voice.snapshot.phase).toBe("stopping");
    expect(() => voice.listen()).toThrow();
    const cancelled = voice.cancel();
    cleanup.resolve();
    await cancelled;
    expect(voice.snapshot.continuous).toBe(false);
    expect(voice.snapshot.phase).toBe("idle");
    expect(session.close).toHaveBeenCalledOnce();
  });
  it("rejects a session that failed just before startup resolved", async () => {
    const { ports, device, session } = fixture();
    device.abort(new Error("启动失败"));
    const voice = new VoiceController(ports, true, true, true);
    voice.listen(true);
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("idle"));
    expect(voice.snapshot.error).toBe("启动失败");
    expect(session.capture).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledOnce();
  });
});

it("requires sustained near-end energy and a fresh reference for barge-in", () => {
  const config = { threshold: 0.015, referenceRatio: 3, confirmationMs: 300 };
  const speech = { rawLevel: 0.06, cleanLevel: 0.05, referenceLevel: 0.001, referenceFresh: true, durationMs: 30 };
  for (const frame of [
    { ...speech, rawLevel: 0.001, cleanLevel: 0.001 },
    { ...speech, referenceFresh: false },
    { ...speech, referenceLevel: 0.05 },
    { ...speech, cleanLevel: Number.NaN },
  ]) {
    let state = initialBarge;
    for (let i = 0; i < 20; i++) state = advanceBarge(state, frame, config);
    expect(state.triggered).toBe(false);
  }
  let state = initialBarge;
  for (let i = 0; i < 9; i++) state = advanceBarge(state, speech, config);
  expect(state.triggered).toBe(false);
  state = advanceBarge(state, { ...speech, referenceFresh: false }, config);
  expect(state.qualifyingMs).toBe(0);
  for (let i = 0; i < 10; i++) state = advanceBarge(state, speech, config);
  expect(state.triggered).toBe(true);
  expect(advanceBarge(state, speech, config)).toBe(state);
});

it("tolerates brief word gaps and AEC suppression without accumulating isolated clicks", () => {
  const config = { threshold: 0.015, referenceRatio: 3, confirmationMs: 300 };
  const frame = { rawLevel: 0.05, cleanLevel: 0.001, referenceLevel: 0.001, referenceFresh: true, durationMs: 30 };
  let state = initialBarge;
  for (let i = 0; i < 12; i++)
    state = advanceBarge(state, i === 4 || i === 8 ? { ...frame, rawLevel: 0.001 } : frame, config);
  expect(state.triggered).toBe(true);
  state = initialBarge;
  for (let i = 0; i < 300; i++)
    state = advanceBarge(state, i % 10 === 0 ? frame : { ...frame, rawLevel: 0.001 }, config);
  expect(state.triggered).toBe(false);
  expect(state.evidence.length).toBeLessThanOrEqual(15);
  // Clean output alone cannot cause an interrupt without dominant raw input.
  for (let i = 0; i < 30; i++) state = advanceBarge(state, { ...frame, rawLevel: 0.005, cleanLevel: 0.1 }, config);
  expect(state.triggered).toBe(false);
});
