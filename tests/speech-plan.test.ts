import { expect, it } from "vitest";
import { validateSpeechPlan } from "../packages/adapters/src/speech-plan.js";

it("keeps Chinese subtitles while allowing only installed contextual speech references", () => {
  expect(
    validateSpeechPlan(
      { segments: [{ text: "大丈夫だよ。", referenceId: "warm" }] },
      ["没关系的。"],
      ["neutral", "warm"],
    ),
  ).toEqual([{ text: "大丈夫だよ。", subtitle: "没关系的。", referenceId: "warm", portraitId: "neutral" }]);
  expect(() =>
    validateSpeechPlan({ segments: [{ text: "はい。", referenceId: "unknown" }] }, ["好。"], ["neutral"]),
  ).toThrow("未配置");
  expect(() =>
    validateSpeechPlan({ segments: [{ text: "はい。", referenceId: "neutral" }] }, ["好。", "继续。"], ["neutral"]),
  ).toThrow("段落不匹配");
});

it("accepts installed contextual portraits and rejects invented expression ids", () => {
  const plan = { segments: [{ text: "一緒に考えよう。", referenceId: "neutral", portraitId: "thoughtful" }] };
  expect(validateSpeechPlan(plan, ["一起想想吧。"], ["neutral"], ["neutral", "thoughtful"])[0]).toMatchObject({
    subtitle: "一起想想吧。",
    portraitId: "thoughtful",
  });
  expect(() => validateSpeechPlan(plan, ["一起想想吧。"], ["neutral"])).toThrow("未配置的立绘");
});
