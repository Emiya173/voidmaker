export type ConversationState = Readonly<
  | { phase: "idle"; generation: number }
  | { phase: "thinking"; generation: number; draft: string; turnId: string | null }
  | { phase: "stopping"; generation: number; turnId: string | null }
>;

export type ConversationEvent = Readonly<
  | { type: "send" }
  | { type: "started"; turnId: string; generation: number }
  | { type: "delta"; text: string; generation: number }
  | { type: "stop" }
  | { type: "complete"; generation: number }
>;

export const initialConversation: ConversationState = { phase: "idle", generation: 0 };

export function transition(state: ConversationState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case "send":
      return state.phase === "idle"
        ? { phase: "thinking", generation: state.generation + 1, draft: "", turnId: null }
        : state;
    case "started":
      return state.phase === "thinking" && state.generation === event.generation
        ? { ...state, turnId: event.turnId }
        : state;
    case "delta":
      return state.phase === "thinking" && state.generation === event.generation
        ? { ...state, draft: state.draft + event.text }
        : state;
    case "stop":
      return state.phase === "thinking"
        ? { phase: "stopping", generation: state.generation + 1, turnId: state.turnId }
        : state;
    case "complete":
      return state.generation === event.generation ? { phase: "idle", generation: state.generation } : state;
  }
}
