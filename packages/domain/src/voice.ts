import type { VoicePhase, VoiceSnapshot } from "../../contracts/src/voice.js";

export type VoiceEvent =
  | { type: "begin"; phase: "listening" | "thinking"; continuous: boolean }
  | { type: "stage"; generation: number; phase: VoicePhase; transcript?: string; subtitle?: string }
  | { type: "progress"; generation: number; position: number; duration: number; level: number }
  | { type: "level"; generation: number; level: number }
  | { type: "cancel"; error?: string };

export function initialVoice(inputAvailable: boolean, outputAvailable: boolean): VoiceSnapshot {
  return {
    phase: "idle",
    generation: 0,
    continuous: false,
    transcript: "",
    error: "",
    subtitle: "",
    position: 0,
    duration: 0,
    level: 0,
    inputAvailable,
    outputAvailable,
  };
}

export function voiceTransition(state: VoiceSnapshot, event: VoiceEvent): VoiceSnapshot {
  if (event.type === "cancel")
    return {
      ...initialVoice(state.inputAvailable, state.outputAvailable),
      generation: state.generation + 1,
      phase: "stopping",
      error: event.error ?? "",
    };
  if (event.type === "begin")
    return {
      ...state,
      phase: event.phase,
      generation: state.generation + 1,
      continuous: event.continuous,
      transcript: "",
      error: "",
      subtitle: "",
      position: 0,
      duration: 0,
      level: 0,
    };
  if (event.generation !== state.generation) return state;
  switch (event.type) {
    case "stage":
      return {
        ...state,
        phase: event.phase,
        transcript: event.transcript ?? state.transcript,
        subtitle: event.subtitle ?? state.subtitle,
        level: 0,
      };
    case "progress":
      return state.phase === "speaking"
        ? { ...state, position: event.position, duration: event.duration, level: event.level }
        : state;
    case "level":
      return state.phase === "listening" ? { ...state, level: event.level } : state;
  }
}

export type VadState = Readonly<{ speechMs: number; silenceMs: number; elapsedMs: number }>;
export const initialVad: VadState = { speechMs: 0, silenceMs: 0, elapsedMs: 0 };
export type VadSettings = Readonly<{
  threshold: number;
  silenceMs: number;
  minSpeechMs: number;
  maxRecordingMs: number;
}>;
export function advanceVad(state: VadState, level: number, frameMs: number, config: VadSettings) {
  const speech = level >= config.threshold;
  const next: VadState = {
    elapsedMs: state.elapsedMs + frameMs,
    speechMs: state.speechMs + (speech ? frameMs : 0),
    silenceMs: speech ? 0 : state.silenceMs + frameMs,
  };
  return {
    state: next,
    done:
      next.elapsedMs >= config.maxRecordingMs ||
      (next.speechMs >= config.minSpeechMs && next.silenceMs >= config.silenceMs),
    hasSpeech: next.speechMs >= config.minSpeechMs,
  };
}

export function speechSegments(text: string): string[] {
  // Bound synthesis size, keep sentence punctuation, never read fenced code aloud.
  const plain = text
    .replace(/```[\s\S]*?```/g, "代码已显示在对话中。")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*#`_]/g, "")
    .trim();
  return (plain.match(/[^。！？!?\n]{1,180}[。！？!?\n]?/gu) ?? []).filter((part) => part.trim());
}
