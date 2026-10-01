import { z } from "zod";

export const reviewOptions = {
  emotion: [
    "平静",
    "温柔关切",
    "开心",
    "悲伤",
    "担忧",
    "惊讶",
    "困惑",
    "不满",
    "坚定",
    "俏皮",
    "疲惫",
    "犹豫",
    "难以判断",
  ],
  delivery: [
    "自然平缓",
    "轻柔安慰",
    "认真解释",
    "迟疑思索",
    "好奇询问",
    "坚定强调",
    "轻快愉悦",
    "低落失望",
    "惊讶感叹",
    "疲倦低缓",
    "难以判断",
  ],
  speech_act: ["陈述", "提问", "赞同", "拒绝", "道歉", "鼓励", "解释", "招呼", "思考", "其他"],
} as const;
export const reviewFields = z
  .object({
    text_ja: z.string().max(10000),
    text_zh: z.string().max(10000),
    emotion: z.enum(reviewOptions.emotion),
    delivery: z.enum(reviewOptions.delivery),
    speech_act: z.enum(reviewOptions.speech_act),
    needs_review: z.boolean(),
    review_reason: z.string().max(2000),
    reviewed: z.boolean(),
    excluded: z.boolean(),
    review_note: z.string().max(2000),
  })
  .strict();
export const reviewSave = z
  .object({
    revision: z.int().nonnegative(),
    fields: reviewFields,
  })
  .strict()
  .superRefine(({ fields }, ctx) => {
    if (!fields.excluded && !fields.text_ja.trim())
      ctx.addIssue({ code: "custom", message: "请填写日文台词，或将无效素材标记为排除" });
    if (fields.reviewed && fields.needs_review)
      ctx.addIssue({ code: "custom", message: "待复核素材不能同时标记为已确认" });
  });
export const reviewSample = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(120),
    file: z.string().min(1),
    audio: z.string().min(1),
    duration_seconds: z.number().positive(),
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    text_ja: z.string(),
    text_zh: z.string(),
    emotion: z.enum(reviewOptions.emotion),
    delivery: z.enum(reviewOptions.delivery),
    speech_act: z.enum(reviewOptions.speech_act),
    confidence: z.enum(["低", "中", "高"]),
    reason: z.string(),
    needs_review: z.boolean(),
    review_reason: z.string(),
    reviewed: z.boolean(),
  })
  .passthrough();
export type ReviewFields = Readonly<z.infer<typeof reviewFields>>;
export type ReviewSample = Readonly<z.infer<typeof reviewSample>>;
export type ReviewSave = Readonly<z.infer<typeof reviewSave>>;
export const reviewChange = z
  .object({
    id: z.string(),
    revision: z.int().positive(),
    updated_at: z.iso.datetime(),
    fields: reviewFields,
  })
  .strict();
export const reviewState = z
  .object({
    version: z.literal(1),
    dataset_sha256: z.string(),
    changes: z.array(reviewChange),
  })
  .strict();
export type ReviewChange = Readonly<z.infer<typeof reviewChange>>;
export type ReviewRow = ReviewSample &
  ReviewFields &
  Readonly<{
    revision: number;
    updated_at: string | null;
    original: ReviewSample;
  }>;
