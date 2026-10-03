import type { VoiceAudioSession } from "../../../packages/adapters/src/aec-session.js";
import type { Capture, PlaybackProgress } from "../../../packages/adapters/src/audio-process.js";
import type { SpeechReference, SpeechSegment, WaitingClip } from "../../../packages/contracts/src/speech.js";
import type { VoiceSnapshot } from "../../../packages/contracts/src/voice.js";
import { initialVoice, type VoiceEvent, voiceTransition } from "../../../packages/domain/src/voice.js";

export type VoicePorts = Readonly<{
  capture: (signal: AbortSignal, onLevel: (level: number) => void) => Capture;
  transcribe: (wav: Buffer, signal: AbortSignal) => Promise<string>;
  present?: (segment: SpeechSegment) => void;
  waitingClip?: () => WaitingClip | undefined;
  recordedClip?: (id: string) => Buffer | undefined;
  interruptReply?: () => Promise<void>;
  synthesize: (text: string, signal: AbortSignal, referenceId?: string, reference?: SpeechReference) => Promise<Buffer>;
  play: (wav: Buffer, signal: AbortSignal, onProgress: (progress: PlaybackProgress) => void) => Promise<void>;
  submit: (text: string) => Promise<void>;
  canAutoSubmit?: () => boolean;
  publish: (state: VoiceSnapshot) => void;
  openSession?: (signal: AbortSignal) => Promise<VoiceAudioSession>;
}>;

/** Effect boundary: every async callback carries the generation that created it. */
export class VoiceController {
  private state: VoiceSnapshot;
  private controller = new AbortController();
  private recording: Capture | undefined;
  private pending: Promise<void> = Promise.resolve();
  private audioAbort: AbortController | undefined;
  private session: VoiceAudioSession | undefined;
  private closing: Promise<void> = Promise.resolve();
  private waiting: { controller: AbortController; timer: NodeJS.Timeout; pending: Promise<void> } | undefined;
  private lastWaiting = -Infinity;
  private interruptedGeneration = -1;

  constructor(
    private readonly ports: VoicePorts,
    inputAvailable: boolean,
    private readonly outputAvailable: boolean | (() => boolean),
    private readonly bargeIn = false,
  ) {
    this.state = initialVoice(
      inputAvailable,
      typeof outputAvailable === "function" ? outputAvailable() : outputAvailable,
      bargeIn,
      !!ports.openSession,
    );
  }
  get snapshot(): VoiceSnapshot {
    return {
      ...this.state,
      outputAvailable: typeof this.outputAvailable === "function" ? this.outputAvailable() : this.outputAvailable,
    };
  }
  private dispatch(event: VoiceEvent): void {
    const next = voiceTransition(this.state, event);
    if (next !== this.state) {
      this.state = next;
      this.ports.publish(this.snapshot);
    }
  }
  private current(generation: number): boolean {
    return this.state.generation === generation && !this.controller.signal.aborted;
  }
  private async fail(error: unknown, generation: number): Promise<void> {
    if (this.current(generation)) {
      this.controller.abort();
      const closed = this.closeSession();
      this.dispatch({ type: "cancel", error: error instanceof Error ? error.message : String(error) });
      const cancelled = this.state.generation;
      await closed;
      this.dispatch({ type: "stage", generation: cancelled, phase: "idle" });
    }
  }
  private begin(phase: "preparing" | "listening" | "thinking", continuous: boolean): number {
    this.controller = new AbortController();
    this.dispatch({ type: "begin", phase, continuous });
    return this.state.generation;
  }

  listen(continuous = false): void {
    if (!this.state.inputAvailable) throw new Error("请先配置本地 ASR 服务");
    if (!["idle", "review"].includes(this.state.phase)) throw new Error("请先停止当前语音轮次");
    const generation = this.begin(this.ports.openSession && !this.session ? "preparing" : "listening", continuous);
    this.pending = this.captureTurn(generation);
  }
  finish(): void {
    this.recording?.finish();
  }
  private async captureTurn(generation: number): Promise<void> {
    const signal = this.controller.signal;
    try {
      if (this.ports.openSession && !this.session) {
        this.audioAbort = new AbortController();
        const session = await this.ports.openSession(this.audioAbort.signal);
        if (!this.current(generation)) {
          await session.close();
          return;
        }
        this.session = session;
        if (session.signal.aborted) throw session.signal.reason;
        session.signal.addEventListener(
          "abort",
          () => {
            if (this.session === session && !this.audioAbort?.signal.aborted)
              void this.fail(session.signal.reason, this.state.generation);
          },
          { once: true },
        );
      }
      if (!this.current(generation)) return;
      this.dispatch({ type: "stage", generation, phase: "listening" });
      const recording = (this.session?.capture ?? this.ports.capture)(signal, (level) =>
        this.dispatch({ type: "level", generation, level }),
      );
      this.recording = recording;
      const wav = await recording.result;
      if (!this.current(generation)) return;
      this.recording = undefined;
      if (!this.state.continuous) await this.closeSession();
      if (!this.current(generation)) return;
      this.dispatch({ type: "stage", generation, phase: "transcribing" });
      const text = await this.ports.transcribe(wav, signal);
      if (!this.current(generation)) return;
      if (!text) throw new Error("未识别出文字，请重试");
      const automatic = this.state.continuous && (this.ports.canAutoSubmit?.() ?? true);
      if (this.state.continuous && !automatic) await this.closeSession();
      if (!this.current(generation)) return;
      this.dispatch({ type: "stage", generation, phase: "review", transcript: text, continuous: automatic });
      if (this.state.continuous) {
        // submit owns the next generation; do not make cancel await the entire chat turn.
        const submitted = this.ports.submit(text);
        const submittedGeneration = this.state.generation;
        void submitted.catch((error: unknown) => this.fail(error, submittedGeneration));
      }
    } catch (error) {
      await this.fail(error, generation);
    }
  }

  private closeSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.audioAbort?.abort();
    this.audioAbort = undefined;
    this.closing = Promise.all([this.closing, session?.close()]).then(() => undefined);
    return this.closing;
  }

  beginReply(): number {
    if (!["idle", "review"].includes(this.state.phase)) throw new Error("语音处理尚未结束");
    const generation = this.begin("thinking", this.state.continuous);
    if (this.ports.waitingClip && this.snapshot.outputAvailable && Date.now() - this.lastWaiting >= 30_000) {
      const waiting = {
        controller: new AbortController(),
        timer: setTimeout(() => {
          waiting.pending = this.playWaiting(generation, waiting.controller.signal);
        }, 2000),
        pending: Promise.resolve(),
      };
      this.waiting = waiting;
    }
    return generation;
  }
  replyArriving(): void {
    if (!this.waiting) return;
    clearTimeout(this.waiting.timer);
    this.waiting.controller.abort();
  }
  wasInterrupted(generation: number): boolean {
    return this.interruptedGeneration === generation;
  }
  private async finishWaiting(): Promise<void> {
    const waiting = this.waiting;
    this.replyArriving();
    await waiting?.pending;
    if (this.waiting === waiting) this.waiting = undefined;
  }
  private async playWaiting(generation: number, waitingSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([this.controller.signal, waitingSignal]);
    let unwatch: (() => void) | undefined;
    try {
      if (
        signal.aborted ||
        !this.current(generation) ||
        this.state.phase !== "thinking" ||
        !this.snapshot.outputAvailable
      )
        return;
      const clip = this.ports.waitingClip?.();
      if (!clip) return;
      this.lastWaiting = Date.now();
      this.dispatch({ type: "stage", generation, phase: "speaking", subtitle: clip.subtitle });
      if (this.state.continuous && this.bargeIn && this.session) {
        unwatch = this.session.watchBarge(signal, () => {
          if (signal.aborted || !this.current(generation)) return;
          this.interruptedGeneration = generation;
          this.replyArriving();
          this.dispatch({ type: "stage", generation, phase: "interrupting", subtitle: "" });
          void this.ports.interruptReply?.().catch(() => undefined);
        });
      }
      await this.ports.play(clip.wav, signal, (progress) => {
        if (!signal.aborted) this.dispatch({ type: "progress", generation, ...progress });
      });
    } catch {
      // Optional recorded acknowledgement must never fail the actual model reply.
    } finally {
      unwatch?.();
      if (this.current(generation) && this.state.phase === "speaking")
        this.dispatch({ type: "stage", generation, phase: "thinking", subtitle: "" });
    }
  }
  async speak(
    segments: readonly SpeechSegment[],
    generation: number,
    references: readonly SpeechReference[] = [],
  ): Promise<void> {
    if (!this.current(generation)) return;
    this.pending = this.speakTurn(segments, generation, references);
    await this.pending;
  }
  private async speakTurn(
    segments: readonly SpeechSegment[],
    generation: number,
    references: readonly SpeechReference[],
  ): Promise<void> {
    const prefetch = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, prefetch.signal]);
    type Prepared = { ok: true; wav: Buffer } | { ok: false; error: unknown };
    // Capture rejections immediately, even when the next segment fails during playback.
    const prepare = async (segment: SpeechSegment): Promise<Prepared> => {
      try {
        signal.throwIfAborted();
        if (segment.clipId) {
          const wav = this.ports.recordedClip?.(segment.clipId);
          if (!wav) throw new Error("句首原声不可用");
          return { ok: true, wav };
        }
        return {
          ok: true,
          wav: await this.ports.synthesize(
            segment.text,
            signal,
            segment.referenceId,
            references.find((r) => r.id === segment.referenceId),
          ),
        };
      } catch (error) {
        return { ok: false, error };
      }
    };
    let pending: Promise<Prepared> | undefined;
    try {
      await this.finishWaiting();
      if (!this.current(generation) || this.wasInterrupted(generation)) return;
      const audible = this.snapshot.outputAvailable;
      if (segments.length) {
        if (!this.current(generation)) return;
        if (!audible) {
          const last = segments.at(-1);
          if (last) this.ports.present?.(last);
          return;
        }
        pending = prepare(segments[0] as SpeechSegment);
        for (const [index, segment] of segments.entries()) {
          if (!this.current(generation)) return;
          this.dispatch({ type: "stage", generation, phase: "synthesizing", subtitle: segment.subtitle });
          const prepared = await pending;
          if (!this.current(generation)) return;
          if (!prepared?.ok) throw prepared?.error ?? new Error("缺少已合成音频");
          const next = segments[index + 1];
          // One synthesis at a time; overlap only the next sentence with current playback.
          pending = next ? prepare(next) : undefined;
          this.ports.present?.(segment);
          this.dispatch({ type: "stage", generation, phase: "speaking" });
          const playback = new AbortController();
          let interrupted = false;
          let watching = true;
          const stopWatching =
            this.state.continuous && this.bargeIn && this.session
              ? this.session.watchBarge(signal, () => {
                  if (!watching || !this.current(generation) || this.state.phase !== "speaking") return;
                  interrupted = true;
                  playback.abort();
                  this.dispatch({ type: "stage", generation, phase: "interrupting", subtitle: "" });
                })
              : undefined;
          try {
            await this.ports.play(prepared.wav, AbortSignal.any([signal, playback.signal]), (progress) =>
              this.dispatch({ type: "progress", generation, ...progress }),
            );
          } catch (error) {
            if (!interrupted || signal.aborted) throw error;
          } finally {
            watching = false;
            stopWatching?.();
          }
          if (interrupted) break;
        }
      }
    } catch (error) {
      await this.fail(error, generation);
    } finally {
      prefetch.abort();
      await pending;
      if (this.current(generation)) this.dispatch({ type: "stage", generation, phase: "idle", subtitle: "" });
    }
  }
  resumeListening(): void {
    if (this.state.continuous && this.state.phase === "idle") this.listen(true);
  }
  async cancel(error?: string): Promise<void> {
    this.controller.abort();
    const waiting = this.finishWaiting();
    const closed = this.closeSession();
    this.recording = undefined;
    this.dispatch(error === undefined ? { type: "cancel" } : { type: "cancel", error });
    const generation = this.state.generation;
    await Promise.all([this.pending, closed, waiting]);
    this.dispatch({ type: "stage", generation, phase: "idle" });
  }
}
