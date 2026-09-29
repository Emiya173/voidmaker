import { describe, expect, it, vi } from "vitest";
import { VoiceController, type VoicePorts } from "../apps/host/src/voice.js";
import { readWav, wavFromPcm } from "../packages/adapters/src/pcm.js";
import type { SpeechSegment } from "../packages/contracts/src/speech.js";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";
import { advanceVad, initialVad, initialVoice, voiceTransition } from "../packages/domain/src/voice.js";

const wav = wavFromPcm(Buffer.alloc(3200));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(overrides: Partial<VoicePorts> = {}, input = true, output = true) {
  const ports: VoicePorts = {
    capture: vi.fn(() => ({ result: Promise.resolve(wav), finish: vi.fn() })),
    transcribe: vi.fn(async () => "测试文字"),
    synthesize: vi.fn(async () => wav),
    play: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    publish: vi.fn(),
    ...overrides,
  };
  return { voice: new VoiceController(ports, input, output), ports };
}

describe("voice lifecycle", () => {
  it("presents one contextual expression without enabling audio for a text-only character", async () => {
    const first = { subtitle: "嗯。", text: "嗯。", referenceId: "neutral", portraitId: "thoughtful" };
    const last = { subtitle: "一起试试看吧。", text: "一起试试看吧。", referenceId: "neutral", portraitId: "gentle" };
    const { voice, ports } = setup(
      {
        visualAvailable: () => true,
        prepareSpeech: async () => [first, last],
        present: vi.fn(),
      },
      false,
      false,
    );
    await voice.speak("嗯。一起试试看吧。", voice.beginReply());
    expect(ports.present).toHaveBeenCalledExactlyOnceWith(last);
    expect(ports.synthesize).not.toHaveBeenCalled();
    expect(ports.play).not.toHaveBeenCalled();
    expect(ports.capture).not.toHaveBeenCalled();
    expect(voice.snapshot.phase).toBe("idle");
  });
  it("speaks Japanese with a selected reference while keeping Chinese subtitles", async () => {
    const { voice, ports } = setup({
      prepareSpeech: async () => [
        { subtitle: "不用着急。", text: "焦らなくていいよ。", referenceId: "warm", portraitId: "gentle" },
      ],
      present: vi.fn(),
    });
    await voice.speak("不用着急。", voice.beginReply());
    expect(ports.synthesize).toHaveBeenCalledWith("焦らなくていいよ。", expect.any(AbortSignal), "warm");
    expect(ports.publish).toHaveBeenCalledWith(expect.objectContaining({ phase: "speaking", subtitle: "不用着急。" }));
    expect(ports.present).toHaveBeenCalledWith(expect.objectContaining({ portraitId: "gentle" }));
  });
  it("does not synthesize or play a translation completed after cancellation", async () => {
    const pending = deferred<readonly SpeechSegment[]>();
    const { voice, ports } = setup({ prepareSpeech: () => pending.promise, present: vi.fn() });
    const speaking = voice.speak("旧回复。", voice.beginReply());
    const stopped = voice.cancel();
    pending.resolve([{ subtitle: "旧回复。", text: "古い返事。", referenceId: "neutral", portraitId: "gentle" }]);
    await Promise.all([speaking, stopped]);
    expect(ports.synthesize).not.toHaveBeenCalled();
    expect(ports.play).not.toHaveBeenCalled();
    expect(ports.present).not.toHaveBeenCalled();
    expect(voice.snapshot.phase).toBe("idle");
  });
  it("keeps text usable when speech preparation fails", async () => {
    const { voice, ports } = setup({
      prepareSpeech: async () => {
        throw new Error("翻译服务离线");
      },
    });
    await voice.speak("已显示的中文。", voice.beginReply());
    expect(voice.snapshot.phase).toBe("idle");
    expect(voice.snapshot.error).toBe("翻译服务离线");
    expect(ports.synthesize).not.toHaveBeenCalled();
  });
  it("pauses continuous capture for draft conflicts instead of submitting unseen text", async () => {
    const { voice, ports } = setup({ canAutoSubmit: () => false });
    voice.listen(true);
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("review"));
    expect(voice.snapshot.continuous).toBe(false);
    expect(voice.snapshot.transcript).toBe("测试文字");
    expect(ports.submit).not.toHaveBeenCalled();
    voice.resumeListening();
    expect(ports.capture).toHaveBeenCalledOnce();
    await voice.cancel();
  });
  it("tracks role-specific speech availability and discards synthesis completed after stop", async () => {
    let enabled = false;
    const pending = deferred<Buffer>();
    const { ports } = setup({ synthesize: () => pending.promise, present: vi.fn() });
    const voice = new VoiceController(ports, false, () => enabled);
    expect(voice.snapshot.outputAvailable).toBe(false);
    enabled = true;
    expect(voice.snapshot.outputAvailable).toBe(true);
    const speaking = voice.speak("你好。", voice.beginReply());
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("synthesizing"));
    const stopped = voice.cancel();
    pending.resolve(wav);
    await Promise.all([stopped, speaking]);
    expect(ports.play).not.toHaveBeenCalled();
    expect(ports.present).not.toHaveBeenCalled();
    expect(voice.snapshot.phase).toBe("idle");
    expect(voice.snapshot.level).toBe(0);
    enabled = false;
    await voice.speak("无语音角色。", voice.beginReply());
    expect(ports.play).not.toHaveBeenCalled();
    expect(voice.snapshot.outputAvailable).toBe(false);
  });
  it("keeps a transcript editable until explicit submission", async () => {
    const { voice, ports } = setup();
    voice.listen();
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("review"));
    expect(voice.snapshot.transcript).toBe("测试文字");
    expect(ports.submit).not.toHaveBeenCalled();
    const generation = voice.beginReply();
    await voice.speak("回复。", generation);
    expect(ports.play).toHaveBeenCalledOnce();
    expect(voice.snapshot.phase).toBe("idle");
  });

  it("discards ASR results arriving after cancellation and keeps the microphone off", async () => {
    const response = deferred<string>();
    const { voice, ports } = setup({ transcribe: () => response.promise });
    voice.listen(true);
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("transcribing"));
    const stopped = voice.cancel();
    expect(voice.snapshot.phase).toBe("stopping");
    expect(() => voice.listen()).toThrow();
    response.resolve("过期结果");
    await stopped;
    expect(voice.snapshot.phase).toBe("idle");
    expect(ports.submit).not.toHaveBeenCalled();
    voice.resumeListening();
    expect(ports.capture).toHaveBeenCalledOnce();
  });

  it("does not play a synthesis that finishes after stop", async () => {
    const response = deferred<Buffer>();
    const { voice, ports } = setup({ synthesize: () => response.promise });
    const generation = voice.beginReply();
    const speaking = voice.speak("旧回复。", generation);
    const stopped = voice.cancel();
    response.resolve(wav);
    await Promise.all([speaking, stopped]);
    expect(ports.play).not.toHaveBeenCalled();
    const next = voice.beginReply();
    await voice.speak("新回复。", next);
    expect(ports.play).toHaveBeenCalledOnce();
  });

  it("aborts playback and does not synthesize queued segments", async () => {
    const playing = deferred<void>();
    const { voice, ports } = setup({
      play: (_wav, signal) => {
        signal.addEventListener("abort", () => playing.resolve(), { once: true });
        return playing.promise;
      },
    });
    const speaking = voice.speak("第一句。第二句。", voice.beginReply());
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("speaking"));
    await voice.cancel();
    await speaking;
    expect(ports.synthesize).toHaveBeenCalledOnce();
  });

  it("resumes half-duplex capture only after playback completes", async () => {
    const { voice, ports } = setup();
    voice.listen(true);
    await vi.waitFor(() => expect(ports.submit).toHaveBeenCalledOnce());
    const generation = voice.beginReply();
    voice.resumeListening();
    expect(ports.capture).toHaveBeenCalledOnce();
    await voice.speak("收到。", generation);
    expect(ports.capture).toHaveBeenCalledOnce();
    voice.resumeListening();
    expect(ports.capture).toHaveBeenCalledTimes(2);
    await voice.cancel();
  });

  it("leaves text usable after service errors or without any voice services", async () => {
    const { voice } = setup({
      synthesize: async () => {
        throw new Error("服务离线");
      },
    });
    await voice.speak("回复", voice.beginReply());
    expect(voice.snapshot.error).toBe("服务离线");
    expect(voice.snapshot.phase).toBe("idle");
    expect(() => voice.beginReply()).not.toThrow();
    const disabled = setup({}, false, false);
    expect(() => disabled.voice.listen()).toThrow("ASR");
    await disabled.voice.speak("文字", disabled.voice.beginReply());
    expect(disabled.ports.synthesize).not.toHaveBeenCalled();
  });
});

it("rejects stale volume/playback events", () => {
  const playing = voiceTransition(initialVoice(true, true), { type: "begin", phase: "thinking", continuous: false });
  const stopped = voiceTransition(playing, { type: "cancel" });
  expect(
    voiceTransition(stopped, { type: "progress", generation: playing.generation, position: 1, duration: 2, level: 1 }),
  ).toBe(stopped);
});

it("segments speech after trailing silence but never treats silence alone as speech", () => {
  const config = voiceConfigSchema.parse({}).vad;
  let state = initialVad;
  for (let i = 0; i < 50; i++) {
    const next = advanceVad(state, 0, 30, config);
    state = next.state;
    expect(next.done).toBe(false);
  }
  for (let i = 0; i < 10; i++) state = advanceVad(state, 0.2, 30, config).state;
  let done = false;
  for (let i = 0; i < 27; i++) {
    const next = advanceVad(state, 0, 30, config);
    state = next.state;
    done = next.done;
  }
  expect(done).toBe(true);
});

it("validates PCM WAV and rejects truncated audio", () => {
  expect(readWav(wav).duration).toBe(0.1);
  expect(() => readWav(wav.subarray(0, 60))).toThrow("不完整");
});

it("requires explicit local non-Whisper ASR configuration", () => {
  expect(() => voiceConfigSchema.parse({ asr: { url: "https://example.com/asr", model: "sensevoice" } })).toThrow();
  expect(() => voiceConfigSchema.parse({ asr: { url: "http://127.0.0.1:8000/asr", model: "whisper-1" } })).toThrow();
});
