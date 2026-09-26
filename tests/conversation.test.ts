import { describe, expect, it } from "vitest";
import { initialConversation, transition } from "../packages/domain/src/conversation.js";

describe("conversation transition", () => {
  it("ignores late events after cancellation", () => {
    const thinking = transition(initialConversation, { type: "send" });
    const stopped = transition(thinking, { type: "stop" });
    const late = transition(stopped, { type: "delta", generation: 1, text: "stale" });
    expect(late).toEqual(stopped);
    expect(transition(stopped, { type: "complete", generation: 1 })).toEqual(stopped);
  });
});
