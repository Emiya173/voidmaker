import type { ComposerSnapshot } from "../../contracts/src/composer.js";
import type { VoiceSnapshot } from "../../contracts/src/voice.js";

export const initialComposer: ComposerSnapshot = { text: "", revision: 0, desktopId: null, transcript: null };
export type ComposerEvent =
  | { type: "edit"; source: "text" | "transcript"; text: string; generation: number }
  | { type: "attach"; id: string | null }
  | { type: "voice"; voice: VoiceSnapshot }
  | { type: "resolve"; generation: number; action: "replace" | "append" | "discard" }
  | { type: "consumed"; submission: Submission };
export type Submission = Readonly<{
  source: "text" | "transcript";
  text: string;
  revision: number;
  generation: number;
  desktopId: string | null;
}>;

export function compose(state: ComposerSnapshot, event: ComposerEvent): ComposerSnapshot {
  switch (event.type) {
    case "edit":
      if (event.source === "text") return { ...state, text: event.text, revision: state.revision + 1 };
      if (!state.transcript || state.transcript.generation !== event.generation) throw new Error("这次转写已结束");
      return {
        ...state,
        transcript: { ...state.transcript, text: event.text, revision: state.transcript.revision + 1 },
      };
    case "attach":
      return { ...state, desktopId: event.id, revision: state.revision + 1 };
    case "voice": {
      const voice = event.voice;
      if (voice.phase === "review" && state.transcript?.generation !== voice.generation)
        return { ...state, transcript: { text: voice.transcript, generation: voice.generation, revision: 0 } };
      if (
        ((voice.phase === "stopping" && !voice.error) || ["listening", "preparing"].includes(voice.phase)) &&
        state.transcript
      )
        return { ...state, transcript: null };
      return state;
    }
    case "resolve": {
      const transcript = state.transcript;
      if (!transcript || transcript.generation !== event.generation) throw new Error("这次转写已结束");
      if (event.action === "discard") return { ...state, transcript: null };
      const text =
        event.action === "replace" ? transcript.text : [state.text, transcript.text].filter(Boolean).join("\n");
      if (text.length > 10_000) throw new Error("合并后的文字超过 10000 字，请先精简");
      return { ...state, text, revision: state.revision + 1, transcript: null };
    }
    case "consumed": {
      const sent = event.submission;
      if (sent.source === "text")
        return state.revision === sent.revision
          ? { ...state, text: "", desktopId: null, revision: state.revision + 1 }
          : state;
      return state.transcript?.generation === sent.generation && state.transcript.revision === sent.revision
        ? { ...state, transcript: null }
        : state;
    }
  }
}

export function submission(state: ComposerSnapshot, source: "text" | "transcript", generation: number): Submission {
  if (source === "transcript" && (!state.transcript || state.transcript.generation !== generation))
    throw new Error("这次转写已结束");
  const field = source === "text" ? state : state.transcript;
  const text = field?.text.trim() ?? "";
  if (!text) throw new Error("请输入要发送的文字");
  return {
    source,
    text,
    revision: field?.revision ?? 0,
    generation,
    desktopId: source === "text" ? state.desktopId : null,
  };
}

export function canAutoSubmit(state: ComposerSnapshot): boolean {
  return !state.text.trim() && !state.desktopId;
}
