import { expect, it } from "vitest";
import { characterErrors } from "../packages/domain/src/asr-metrics.js";

it("measures mixed-script CER and handles silence without dividing by zero", () => {
  expect(characterErrors("你好，Codex！", "你好 codex").cer).toBe(0);
  expect(characterErrors("今天下雨", "今天雨")).toEqual({ errors: 1, characters: 4, cer: 0.25 });
  expect(characterErrors("", "你好")).toEqual({ errors: 2, characters: 0, cer: null });
});
