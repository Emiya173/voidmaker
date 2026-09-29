import { describe, expect, it } from "vitest";
import { clientCommand } from "../packages/contracts/src/protocol.js";
import { canAutoSubmit, compose, initialComposer, submission } from "../packages/domain/src/composer.js";
import { initialVoice } from "../packages/domain/src/voice.js";

const review = { ...initialVoice(true, false), phase: "review" as const, generation: 12, transcript: "语音转写" };
const edited = compose(initialComposer, { type: "edit", source: "text", text: "保留的草稿", generation: 0 });
const attached = compose(edited, { type: "attach", id: "context" });
const ready = compose(attached, { type: "voice", voice: review });

describe("independent composer sources", () => {
  it("sends only the edited transcript and retains the typed draft and attachment", () => {
    const state = compose(ready, { type: "edit", source: "transcript", text: "修正后的语音", generation: 12 });
    const sent = submission(state, "transcript", 12);
    expect(sent.text).toBe("修正后的语音");
    expect(sent.desktopId).toBeNull();
    expect(compose(state, { type: "consumed", submission: sent })).toEqual(attached);
  });
  it("keeps an intentionally empty transcript editable without falling back to the typed draft", () => {
    const empty = compose(ready, { type: "edit", source: "transcript", text: "", generation: 12 });
    expect(empty.transcript?.text).toBe("");
    expect(() => submission(empty, "transcript", 12)).toThrow("请输入");
    expect(compose(empty, { type: "voice", voice: review })).toBe(empty);
    const retyped = compose(empty, { type: "edit", source: "transcript", text: "重新输入", generation: 12 });
    expect(submission(retyped, "transcript", 12).text).toBe("重新输入");
  });
  it("does not erase edits made while a message is being persisted", () => {
    const sent = submission(ready, "text", 0);
    const next = compose(ready, { type: "edit", source: "text", text: "下一条草稿", generation: 0 });
    expect(compose(next, { type: "consumed", submission: sent })).toBe(next);
  });
  it("rejects edits, sends and merges from a cancelled generation", () => {
    const stopped = compose(ready, { type: "voice", voice: { ...review, phase: "stopping", generation: 13 } });
    expect(stopped).toEqual(attached);
    expect(() => submission(stopped, "transcript", 12)).toThrow("结束");
    expect(() => compose(stopped, { type: "edit", source: "transcript", text: "旧内容", generation: 12 })).toThrow(
      "结束",
    );
    expect(() => compose(stopped, { type: "resolve", action: "replace", generation: 12 })).toThrow("结束");
  });
  it("retains unsent content on service failure, and merges only when requested", () => {
    const failed = compose(ready, { type: "voice", voice: { ...review, phase: "stopping", error: "数据库不可用" } });
    expect(failed).toBe(ready);
    const merged = compose(failed, { type: "resolve", action: "append", generation: 12 });
    expect(merged.text).toBe("保留的草稿\n语音转写");
    expect(merged.desktopId).toBe("context");
    expect(merged.transcript).toBeNull();
  });
  it("stops continuous submission when a typed draft or attachment exists", () => {
    expect(canAutoSubmit(initialComposer)).toBe(true);
    expect(canAutoSubmit(edited)).toBe(false);
    expect(canAutoSubmit(compose(initialComposer, { type: "attach", id: "image" }))).toBe(false);
  });
  it("bounds edits and requires source/session/generation at the IPC boundary", () => {
    const edit = {
      type: "composer_edit",
      sessionId: "s",
      source: "transcript",
      generation: 1,
      requestId: "r",
      text: "",
    };
    expect(clientCommand.safeParse(edit).success).toBe(true);
    expect(clientCommand.safeParse({ ...edit, text: "x".repeat(10_001) }).success).toBe(false);
    expect(clientCommand.safeParse({ ...edit, generation: -1 }).success).toBe(false);
    expect(clientCommand.safeParse({ type: "composer_send", source: "text" }).success).toBe(false);
  });
});
