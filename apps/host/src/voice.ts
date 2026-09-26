import type { Capture, PlaybackProgress } from "../../../packages/adapters/src/audio-process.js";
import type { VoiceSnapshot } from "../../../packages/contracts/src/voice.js";
import { initialVoice, speechSegments, type VoiceEvent, voiceTransition } from "../../../packages/domain/src/voice.js";

export type VoicePorts = Readonly<{
  capture: (signal: AbortSignal, onLevel: (level: number) => void) => Capture;
  transcribe: (wav: Buffer, signal: AbortSignal) => Promise<string>;
  synthesize: (text: string, signal: AbortSignal) => Promise<Buffer>;
  play: (wav: Buffer, signal: AbortSignal, onProgress: (progress: PlaybackProgress) => void) => Promise<void>;
  submit: (text: string) => Promise<void>;
  publish: (state: VoiceSnapshot) => void;
}>;

/** Effect boundary: every async callback carries the generation that created it. */
export class VoiceController {
  private state: VoiceSnapshot;
  private controller = new AbortController();
  private recording: Capture | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly ports: VoicePorts,
    inputAvailable: boolean,
    outputAvailable: boolean,
  ) {
    this.state = initialVoice(inputAvailable, outputAvailable);
  }
  get snapshot(): VoiceSnapshot {
    return this.state;
  }
  private dispatch(event: VoiceEvent): void {
    const next = voiceTransition(this.state, event);
    if (next !== this.state) {
      this.state = next;
      this.ports.publish(next);
    }
  }
  private current(generation: number): boolean {
    return this.state.generation === generation && !this.controller.signal.aborted;
  }
  private fail(error: unknown, generation: number): void {
    if (this.current(generation)) {
      this.controller.abort();
      this.dispatch({ type: "cancel", error: error instanceof Error ? error.message : String(error) });
      this.dispatch({ type: "stage", generation: this.state.generation, phase: "idle" });
    }
  }
  private begin(phase: "listening" | "thinking", continuous: boolean): number {
    this.controller = new AbortController();
    this.dispatch({ type: "begin", phase, continuous });
    return this.state.generation;
  }

  listen(continuous = false): void {
    if (!this.state.inputAvailable) throw new Error("请先配置本地 ASR 服务");
    if (!["idle", "review"].includes(this.state.phase)) throw new Error("请先停止当前语音轮次");
    const generation = this.begin("listening", continuous);
    this.pending = this.captureTurn(generation);
  }
  finish(): void {
    this.recording?.finish();
  }
  private async captureTurn(generation: number): Promise<void> {
    const signal = this.controller.signal;
    try {
      const recording = this.ports.capture(signal, (level) => this.dispatch({ type: "level", generation, level }));
      this.recording = recording;
      const wav = await recording.result;
      if (!this.current(generation)) return;
      this.recording = undefined;
      this.dispatch({ type: "stage", generation, phase: "transcribing" });
      const text = await this.ports.transcribe(wav, signal);
      if (!this.current(generation)) return;
      if (!text) throw new Error("未识别出文字，请重试");
      this.dispatch({ type: "stage", generation, phase: "review", transcript: text });
      if (this.state.continuous) {
        // submit owns the next generation; do not make cancel await the entire chat turn.
        void this.ports.submit(text).catch((error: unknown) => this.fail(error, generation + 1));
      }
    } catch (error) {
      this.fail(error, generation);
    }
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
      if (this.state.outputAvailable) {
        const signal = this.controller.signal;
        for (const segment of speechSegments(text)) {
          if (!this.current(generation)) return;
          this.dispatch({ type: "stage", generation, phase: "synthesizing", subtitle: segment });
          const wav = await this.ports.synthesize(segment, signal);
          if (!this.current(generation)) return;
          this.dispatch({ type: "stage", generation, phase: "speaking" });
          await this.ports.play(wav, signal, (progress) =>
            this.dispatch({ type: "progress", generation, ...progress }),
          );
        }
      }
    } catch (error) {
      this.fail(error, generation);
    } finally {
      if (this.current(generation)) this.dispatch({ type: "stage", generation, phase: "idle", subtitle: "" });
    }
  }
  resumeListening(): void {
    if (this.state.continuous && this.state.phase === "idle") this.listen(true);
  }
  async cancel(error?: string): Promise<void> {
    this.controller.abort();
    this.recording = undefined;
    this.dispatch(error === undefined ? { type: "cancel" } : { type: "cancel", error });
    const generation = this.state.generation;
    await this.pending;
    this.dispatch({ type: "stage", generation, phase: "idle" });
  }
}
