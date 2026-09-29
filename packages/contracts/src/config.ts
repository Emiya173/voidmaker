import { z } from "zod";

export const reasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export type ModelSettings = Readonly<{ model: string; reasoningEffort: z.infer<typeof reasoningEffort> }>;
export const applicationConfig = z.object({
  agent: z
    .object({
      model: z.string().trim().min(1).default("gpt-6-sol"),
      reasoning_effort: reasoningEffort.default("medium"),
    })
    .prefault({}),
  screen_awareness: z
    .object({
      precheck_model: z.string().trim().min(1).default("gpt-6-luna"),
      precheck_reasoning_effort: reasoningEffort.default("high"),
    })
    .prefault({}),
  speech: z.object({ language: z.enum(["ja", "zh"]).default("ja") }).prefault({}),
});
export type ApplicationConfig = z.infer<typeof applicationConfig>;
