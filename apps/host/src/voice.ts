import type { VoiceAudioSession } from "../../../packages/adapters/src/aec-session.js";
import type { Capture, PlaybackProgress } from "../../../packages/adapters/src/audio-process.js";
import type { SpeechSegment } from "../../../packages/contracts/src/speech.js";
import type { VoiceSnapshot } from "../../../packages/contracts/src/voice.js";
import { initialVoice, speechSegments, type VoiceEvent, voiceTransition } from "../../../packages/domain/src/voice.js";

export type VoicePorts = Readonly<{
  capture: (signal: AbortSignal, onLevel: (level: number) => void) => Capture;
  transcribe: (wav: Buffer, signal: AbortSignal) => Promise<string>;
  prepareSpeech?: (text: string, signal: AbortSignal) => Promise<readonly SpeechSegment[]>;
  visualAvailable?: () => boolean;
  present?: (segment: SpeechSegment) => void;
  synthesize: (text: string, signal: AbortSignal, referenceId?: string) => Promise<Buffer>;
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
    return this.begin("thinking", this.state.continuous);
  }
  async speak(text: string, generation: number): Promise<void> {
    if (!this.current(generation)) return;
    this.pending = this.speakTurn(text, generation);
    await this.pending;
  }
  private async speakTurn(text: string, generation: number): Promise<void> {
    try {
      const audible = this.snapshot.outputAvailable;
      if (audible || this.ports.visualAvailable?.()) {
        const signal = this.controller.signal;
        this.dispatch({ type: "stage", generation, phase: "synthesizing" });
        const segments = this.ports.prepareSpeech
          ? await this.ports.prepareSpeech(text, signal)
          : speechSegments(text).map((subtitle) => ({ subtitle, text: subtitle, referenceId: "neutral" }));
        if (!this.current(generation)) return;
        if (!audible) {
          const last = segments.at(-1);
          if (last) this.ports.present?.(last);
          return;
        }
        for (const segment of segments) {
          if (!this.current(generation)) return;
          this.dispatch({ type: "stage", generation, phase: "synthesizing", subtitle: segment.subtitle });
          const wav = await this.ports.synthesize(segment.text, signal, segment.referenceId);
          if (!this.current(generation)) return;
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
            await this.ports.play(wav, AbortSignal.any([signal, playback.signal]), (progress) =>
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
      if (this.current(generation)) this.dispatch({ type: "stage", generation, phase: "idle", subtitle: "" });
    }
  }
  resumeListening(): void {
    if (this.state.continuous && this.state.phase === "idle") this.listen(true);
  }
  async cancel(error?: string): Promise<void> {
    this.controller.abort();
    const closed = this.closeSession();
    this.recording = undefined;
    this.dispatch(error === undefined ? { type: "cancel" } : { type: "cancel", error });
    const generation = this.state.generation;
    await Promise.all([this.pending, closed]);
    this.dispatch({ type: "stage", generation, phase: "idle" });
  }
}
