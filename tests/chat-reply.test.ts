import { expect, it } from "vitest";
import {
  parseReply,
  ReplyStream,
  replyFormat,
  replyInstructions,
  replyText,
} from "../packages/adapters/src/chat-reply.js";

const references = [
  { id: "warm", description: "温和", refAudioPath: "/ref.wav", promptText: "参考台词", promptLanguage: "ja" },
];
const portraits = [{ id: "gentle", description: "温柔", imageUrl: "file:///portrait.png" }];
const format = replyFormat(references, portraits);
const segment = {
  subtitle: '先检查 "{状态}"，再试试。',
  text: "まず状態を確認してみよう。",
  referenceId: "warm",
  portraitId: "gentle",
};
const clips = [
  { id: "apology", description: "道歉", subtitle: "对不起。", text: "ごめんなさい。", wav: Buffer.from("recording") },
];

it("lets the model choose one installed opener, projects its exact translation once and keeps its audio private", () => {
  const format = replyFormat(references, portraits, clips);
  const raw = JSON.stringify({ openingClipId: "apology", segments: [segment] });
  const expected = `对不起。\n${segment.subtitle}`;
  for (let width = 1; width <= raw.length; width++) {
    const stream = new ReplyStream(format);
    let displayed = "";
    for (let at = 0; at < raw.length; at += width) displayed += stream.push(raw.slice(at, at + width));
    expect(displayed).toBe(expected);
  }
  const parsed = parseReply(raw, format);
  expect(replyText(parsed)).toBe(expected);
  expect(parsed).toEqual([
    { subtitle: "对不起。", text: "ごめんなさい。", clipId: "apology", referenceId: "neutral", portraitId: "gentle" },
    segment,
  ]);
  const single = JSON.stringify({ openingClipId: "apology", segments: [] });
  expect(replyText(parseReply(single, format))).toBe("对不起。");
  expect(new ReplyStream(format).push(single)).toBe("对不起。");
  const instructions = replyInstructions("ja", references, portraits, clips);
  expect(instructions).toContain("不要再次写出或合成");
  expect(instructions).toContain("ごめんなさい。");
  expect(instructions).not.toContain("recording");
  expect(JSON.stringify(format.schema)).not.toContain("recording");
});

it("rejects invented or injected clips and holds reordered JSON until final validation", () => {
  const format = replyFormat(references, portraits, clips);
  for (const openingClipId of ["missing", "../../secret.wav"]) {
    const raw = JSON.stringify({ openingClipId, segments: [segment] });
    expect(() => parseReply(raw, format)).toThrow("回复格式无效");
    expect(() => new ReplyStream(format).push(raw)).toThrow();
  }
  expect(() =>
    parseReply(JSON.stringify({ openingClipId: "none", segments: [{ ...segment, clipId: "apology" }] }), format),
  ).toThrow();
  expect(() => parseReply(JSON.stringify({ segments: [segment] }), format)).toThrow();
  const reordered = JSON.stringify({ segments: [segment], openingClipId: "apology" });
  expect(new ReplyStream(format).push(reordered)).toBe("");
  expect(replyText(parseReply(reordered, format))).toBe(`对不起。\n${segment.subtitle}`);
});

it("projects only validated Chinese subtitles across every chunk boundary", () => {
  const raw = JSON.stringify({ openingClipId: "none", segments: [segment, { ...segment, subtitle: "然后继续。" }] });
  for (let width = 1; width <= raw.length; width++) {
    const stream = new ReplyStream(format);
    let displayed = "";
    for (let at = 0; at < raw.length; at += width) displayed += stream.push(raw.slice(at, at + width));
    expect(displayed).toBe(`${segment.subtitle}\n然后继续。`);
  }
  expect(parseReply(raw, format)[0]).toEqual(segment);
  expect(replyText(parseReply(raw, format))).toBe(`${segment.subtitle}\n然后继续。`);
});

it("does not project objects outside the segments array and rejects invalid final replies", () => {
  const stream = new ReplyStream(format);
  expect(stream.push(`{"openingClipId":"none","segments":[],"extra":${JSON.stringify(segment)}}`)).toBe("");
  for (const raw of [
    "plain text",
    '{"openingClipId":"none","segments":[]',
    JSON.stringify({ openingClipId: "none", segments: [segment], extra: true }),
    JSON.stringify({ openingClipId: "none", segments: [{ ...segment, referenceId: "unknown" }] }),
    JSON.stringify({ openingClipId: "none", segments: [{ ...segment, portraitId: "unknown" }] }),
    JSON.stringify({ openingClipId: "none", segments: Array(41).fill(segment) }),
  ]) {
    expect(() => parseReply(raw, format)).toThrow("回复格式无效");
  }
  expect(() =>
    new ReplyStream(format).push(
      JSON.stringify({ openingClipId: "none", segments: [{ ...segment, referenceId: "unknown" }] }),
    ),
  ).toThrow();
  expect(() => parseReply(" ".repeat(128 * 1024 + 1), format)).toThrow("回复过长");
  expect(() => new ReplyStream(format).push(" ".repeat(128 * 1024 + 1))).toThrow("回复过长");
  expect(parseReply('{"openingClipId":"none","segments":[]}', format)).toEqual([]);
});

it("provides a single bilingual response contract with character-specific choices", () => {
  const instructions = replyInstructions("ja", references, portraits);
  expect(instructions).toContain("一次生成完整回复");
  expect(instructions).toContain("不能直接填写中文");
  expect(instructions).toContain('"warm"');
  expect(instructions).toContain('"gentle"');
  expect(replyInstructions("zh", [], [])).toContain("自然口语中文");
  expect(JSON.stringify(replyFormat([], []).schema)).not.toContain('"warm"');
});
