import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceController, type VoicePorts } from "../apps/host/src/voice.js";
import { readWav, wavFromPcm } from "../packages/adapters/src/pcm.js";
import type { SpeechSegment } from "../packages/contracts/src/speech.js";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";
import {
  advanceVad,
  initialVad,
  initialVoice,
  selectWaitingClip,
  speechSegments,
  voiceTransition,
} from "../packages/domain/src/voice.js";

const wav = wavFromPcm(Buffer.alloc(3200));
const reply = (text: string): readonly SpeechSegment[] =>
  speechSegments(text).map((subtitle) => ({ subtitle, text: subtitle, referenceId: "neutral" }));
afterEach(() => vi.useRealTimers());
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
  it("plays a selected opener verbatim while synthesizing only its continuation", async () => {
    const recording = wavFromPcm(Buffer.alloc(6400));
    const playing = deferred<void>();
    const { voice, ports } = setup({
      recordedClip: vi.fn(() => recording),
      play: vi
        .fn()
        .mockImplementationOnce(() => playing.promise)
        .mockResolvedValue(undefined),
      present: vi.fn(),
    });
    const opener = {
      subtitle: "对不起。",
      text: "ごめんなさい。",
      referenceId: "neutral",
      portraitId: "gentle",
      clipId: "apology",
    };
    const rest = { subtitle: "我重新确认一下。", text: "もう一度確認するね。", referenceId: "warm" };
    const speaking = voice.speak([opener, rest], voice.beginReply());
    await vi.waitFor(() => expect(ports.play).toHaveBeenCalledOnce());
    expect(ports.play).toHaveBeenCalledWith(recording, expect.any(AbortSignal), expect.any(Function));
    expect(ports.synthesize).toHaveBeenCalledExactlyOnceWith(rest.text, expect.any(AbortSignal), "warm");
    expect(ports.present).toHaveBeenCalledExactlyOnceWith(opener);
    expect(voice.snapshot.subtitle).toBe("对不起。");
    playing.resolve();
    await speaking;
    expect(vi.mocked(ports.play).mock.calls[1]?.[0]).toBe(wav);
    expect(voice.snapshot.error).toBe("");
    expect(ports.capture).not.toHaveBeenCalled();
  });
  it("cancels original audio and discards a late prefetched continuation", async () => {
    const synthesized = deferred<Buffer>();
    const { voice, ports } = setup({
      recordedClip: () => wav,
      synthesize: vi.fn(() => synthesized.promise),
      play: vi.fn(
        (_wav, signal) =>
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
      ),
    });
    const speaking = voice.speak(
      [
        { subtitle: "不行哦。", text: "ダメだよ。", referenceId: "neutral", clipId: "refusal" },
        ...reply("后续。再后续。"),
      ],
      voice.beginReply(),
    );
    await vi.waitFor(() => expect(ports.play).toHaveBeenCalledOnce());
    const cancelled = voice.cancel();
    expect(vi.mocked(ports.play).mock.calls[0]?.[1].aborted).toBe(true);
    expect(vi.mocked(ports.synthesize).mock.calls[0]?.[1].aborted).toBe(true);
    synthesized.resolve(wav);
    await Promise.all([speaking, cancelled]);
    expect(ports.play).toHaveBeenCalledOnce();
    expect(ports.synthesize).toHaveBeenCalledOnce();
    expect(voice.snapshot.phase).toBe("idle");
  });
  it("does not synthesize an unavailable opener or use audio for text-only replies", async () => {
    for (const audible of [true, false]) {
      const { voice, ports } = setup({}, false, audible);
      await voice.speak(
        [{ subtitle: "对不起。", text: "ごめんなさい。", referenceId: "neutral", clipId: "missing" }],
        voice.beginReply(),
      );
      expect(ports.synthesize).not.toHaveBeenCalled();
      expect(ports.play).not.toHaveBeenCalled();
      expect(voice.snapshot.error).toBe(audible ? "句首原声不可用" : "");
    }
  });
  it("randomly selects an available recording without repeating the previous one or getting stuck on a fixed order", () => {
    const clips = ["etto", "sono", "thinking", "etto-soft"];
    for (const previous of [...clips, undefined]) {
      const selected = Array.from({ length: 100 }, (_, index) => selectWaitingClip(clips, previous, index / 100));
      expect(new Set(selected)).toEqual(new Set(clips.filter((clip) => clip !== previous)));
    }
    expect(selectWaitingClip([], "old", 0.5)).toBeUndefined();
    expect(selectWaitingClip(["only"], "only", 0.5)).toBe("only");
    expect(clips).toEqual(["etto", "sono", "thinking", "etto-soft"]);
  });
  it("plays exactly one selected source recording per wait, without synthesis or microphone use", async () => {
    vi.useFakeTimers();
    const clips = [
      { wav, subtitle: "唔……" },
      { wav: wavFromPcm(Buffer.alloc(6400)), subtitle: "那个……" },
      { wav: wavFromPcm(Buffer.alloc(9600)), subtitle: "嗯……" },
    ];
    let previous: (typeof clips)[number] | undefined;
    const chosen: Buffer[] = [];
    const { voice, ports } = setup({
      waitingClip: () => {
        previous = selectWaitingClip(clips, previous, 0.6);
        if (previous) chosen.push(previous.wav);
        return previous;
      },
    });
    for (let turn = 0; turn < 3; turn++) {
      const generation = voice.beginReply();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ports.play).toHaveBeenCalledTimes(turn + 1);
      expect(vi.mocked(ports.play).mock.calls[turn]?.[0]).toBe(chosen[turn]);
      if (turn) expect(chosen[turn]).not.toBe(chosen[turn - 1]);
      await voice.speak([], generation);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(ports.synthesize).not.toHaveBeenCalled();
    expect(ports.capture).not.toHaveBeenCalled();
    expect(ports.submit).not.toHaveBeenCalled();
    await voice.cancel();
  });
  it("prefetches one sentence during playback without changing the active subtitle or expression", async () => {
    const firstPlayback = deferred<void>();
    const { voice, ports } = setup({
      play: vi
        .fn()
        .mockImplementationOnce(() => firstPlayback.promise)
        .mockResolvedValue(undefined),
      present: vi.fn(),
    });
    const speaking = voice.speak(reply("第一句。第二句。第三句。"), voice.beginReply());
    await vi.waitFor(() => expect(ports.play).toHaveBeenCalledOnce());
    expect(ports.synthesize).toHaveBeenCalledTimes(2);
    expect(voice.snapshot.phase).toBe("speaking");
    expect(voice.snapshot.subtitle).toBe("第一句。");
    expect(ports.present).toHaveBeenCalledOnce();
    firstPlayback.resolve();
    await speaking;
    expect(ports.synthesize).toHaveBeenCalledTimes(3);
    expect(ports.play).toHaveBeenCalledTimes(3);
    expect(voice.snapshot.phase).toBe("idle");
  });
  it("finishes current playback before reporting a failed prefetched synthesis", async () => {
    const playing = deferred<void>();
    const { voice, ports } = setup({
      synthesize: vi.fn().mockResolvedValueOnce(wav).mockRejectedValue(new Error("下一句失败")),
      play: vi.fn(() => playing.promise),
    });
    const speaking = voice.speak(reply("第一句。第二句。第三句。"), voice.beginReply());
    await vi.waitFor(() => expect(ports.synthesize).toHaveBeenCalledTimes(2));
    expect(voice.snapshot.phase).toBe("speaking");
    expect(voice.snapshot.error).toBe("");
    playing.resolve();
    await speaking;
    expect(ports.play).toHaveBeenCalledOnce();
    expect(voice.snapshot.error).toBe("下一句失败");
    expect(voice.snapshot.phase).toBe("idle");
  });
  it("plays a cached waiting clip once, stops it before the reply and applies a cooldown", async () => {
    vi.useFakeTimers();
    let waitingSignal: AbortSignal | undefined;
    const { voice, ports } = setup({
      waitingClip: () => ({ wav, subtitle: "嗯……" }),
      play: vi
        .fn()
        .mockImplementationOnce((_wav: Buffer, signal: AbortSignal) => {
          waitingSignal = signal;
          return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        })
        .mockResolvedValue(undefined),
    });
    const generation = voice.beginReply();
    await vi.advanceTimersByTimeAsync(1999);
    expect(ports.play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ports.play).toHaveBeenCalledOnce();
    expect(ports.synthesize).not.toHaveBeenCalled();
    expect(ports.capture).not.toHaveBeenCalled();
    expect(voice.snapshot.subtitle).toBe("嗯……");
    voice.replyArriving();
    await voice.speak(reply("正式回复。"), generation);
    expect(waitingSignal?.aborted).toBe(true);
    expect(ports.play).toHaveBeenCalledTimes(2);
    voice.beginReply();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ports.play).toHaveBeenCalledTimes(2);
    await voice.cancel();
  });
  it("skips waiting audio for fast replies, cancellation and text-only output", async () => {
    vi.useFakeTimers();
    for (const action of ["reply", "cancel", "text"] as const) {
      const { voice, ports } = setup({ waitingClip: () => ({ wav, subtitle: "嗯……" }) }, false, action !== "text");
      const generation = voice.beginReply();
      if (action === "reply") await voice.speak([], generation);
      if (action === "cancel") await voice.cancel();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ports.play).not.toHaveBeenCalled();
      await voice.cancel();
    }
  });
  it("keeps the real reply usable if waiting audio playback fails", async () => {
    vi.useFakeTimers();
    const { voice, ports } = setup({
      waitingClip: () => ({ wav, subtitle: "嗯……" }),
      play: vi.fn().mockRejectedValueOnce(new Error("可选音频失败")).mockResolvedValue(undefined),
    });
    const generation = voice.beginReply();
    await vi.advanceTimersByTimeAsync(2000);
    expect(voice.snapshot.phase).toBe("thinking");
    expect(voice.snapshot.error).toBe("");
    await voice.speak(reply("正式回复。"), generation);
    expect(ports.play).toHaveBeenCalledTimes(2);
    expect(voice.snapshot.phase).toBe("idle");
  });
  it("presents one contextual expression without enabling audio for a text-only character", async () => {
    const first = { subtitle: "嗯。", text: "嗯。", referenceId: "neutral", portraitId: "thoughtful" };
    const last = { subtitle: "一起试试看吧。", text: "一起试试看吧。", referenceId: "neutral", portraitId: "gentle" };
    const { voice, ports } = setup(
      {
        present: vi.fn(),
      },
      false,
      false,
    );
    await voice.speak([first, last], voice.beginReply());
    expect(ports.present).toHaveBeenCalledExactlyOnceWith(last);
    expect(ports.synthesize).not.toHaveBeenCalled();
    expect(ports.play).not.toHaveBeenCalled();
    expect(ports.capture).not.toHaveBeenCalled();
    expect(voice.snapshot.phase).toBe("idle");
  });
  it("speaks Japanese with a selected reference while keeping Chinese subtitles", async () => {
    const { voice, ports } = setup({ present: vi.fn() });
    await voice.speak(
      [{ subtitle: "不用着急。", text: "焦らなくていいよ。", referenceId: "warm", portraitId: "gentle" }],
      voice.beginReply(),
    );
    expect(ports.synthesize).toHaveBeenCalledWith("焦らなくていいよ。", expect.any(AbortSignal), "warm");
    expect(ports.publish).toHaveBeenCalledWith(expect.objectContaining({ phase: "speaking", subtitle: "不用着急。" }));
    expect(ports.present).toHaveBeenCalledWith(expect.objectContaining({ portraitId: "gentle" }));
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
    const speaking = voice.speak(reply("你好。"), voice.beginReply());
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("synthesizing"));
    const stopped = voice.cancel();
    pending.resolve(wav);
    await Promise.all([stopped, speaking]);
    expect(ports.play).not.toHaveBeenCalled();
    expect(ports.present).not.toHaveBeenCalled();
    expect(voice.snapshot.phase).toBe("idle");
    expect(voice.snapshot.level).toBe(0);
    enabled = false;
    await voice.speak(reply("无语音角色。"), voice.beginReply());
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
    await voice.speak(reply("回复。"), generation);
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
    const speaking = voice.speak(reply("旧回复。"), generation);
    const stopped = voice.cancel();
    response.resolve(wav);
    await Promise.all([speaking, stopped]);
    expect(ports.play).not.toHaveBeenCalled();
    const next = voice.beginReply();
    await voice.speak(reply("新回复。"), next);
    expect(ports.play).toHaveBeenCalledOnce();
  });

  it("aborts playback and drops the one prefetched segment without synthesizing later ones", async () => {
    const playing = deferred<void>();
    const { voice, ports } = setup({
      play: (_wav, signal) => {
        signal.addEventListener("abort", () => playing.resolve(), { once: true });
        return playing.promise;
      },
    });
    const speaking = voice.speak(reply("第一句。第二句。第三句。"), voice.beginReply());
    await vi.waitFor(() => expect(voice.snapshot.phase).toBe("speaking"));
    await voice.cancel();
    await speaking;
    expect(ports.synthesize).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ports.synthesize).mock.calls[1]?.[1].aborted).toBe(true);
  });

  it("resumes half-duplex capture only after playback completes", async () => {
    const { voice, ports } = setup();
    voice.listen(true);
    await vi.waitFor(() => expect(ports.submit).toHaveBeenCalledOnce());
    const generation = voice.beginReply();
    voice.resumeListening();
    expect(ports.capture).toHaveBeenCalledOnce();
    await voice.speak(reply("收到。"), generation);
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
    await voice.speak(reply("回复"), voice.beginReply());
    expect(voice.snapshot.error).toBe("服务离线");
    expect(voice.snapshot.phase).toBe("idle");
    expect(() => voice.beginReply()).not.toThrow();
    const disabled = setup({}, false, false);
    expect(() => disabled.voice.listen()).toThrow("ASR");
    await disabled.voice.speak(reply("文字"), disabled.voice.beginReply());
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
