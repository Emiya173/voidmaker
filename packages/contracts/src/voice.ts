import { isAbsolute } from "node:path";
import { z } from "zod";
import { aecConfigSchema } from "./aec.js";

const localUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["http:", "https:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.username &&
    !url.password
  );
}, "语音服务必须使用本机回环 HTTP 地址");

export const voiceConfigSchema = z
  .object({
    inputTarget: z.string().min(1).optional(),
    aec: aecConfigSchema.optional(),
    vad: z
      .object({
        threshold: z.number().min(0.001).max(0.5).default(0.015),
        silenceMs: z.number().int().min(200).max(3000).default(800),
        minSpeechMs: z.number().int().min(60).max(2000).default(240),
        maxRecordingMs: z.number().int().min(1000).max(60_000).default(30_000),
      })
      .default({ threshold: 0.015, silenceMs: 800, minSpeechMs: 240, maxRecordingMs: 30_000 }),
    asr: z
      .object({
        url: localUrl,
        model: z
          .string()
          .min(1)
          .refine((value) => !/whisper/i.test(value), "请配置非 Whisper 模型")
          .default("Qwen/Qwen3-ASR-0.6B"),
        language: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(100).max(300_000).default(60_000),
      })
      .optional(),
    tts: z
      .object({
        url: localUrl,
        refAudioPath: z.string().refine(isAbsolute, "参考音频必须为模型服务可读取的绝对路径"),
        promptText: z.string().min(1),
        promptLanguage: z.string().default("zh"),
        textLanguage: z.string().default("auto"),
        timeoutMs: z.number().int().min(100).max(300_000).default(120_000),
      })
      .optional(),
  })
  .refine((config) => !config.aec || !!config.inputTarget, "AEC 必须指定 inputTarget，禁止使用默认麦克风");
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;
export type VoicePhase =
  | "idle"
  | "preparing"
  | "interrupting"
  | "listening"
  | "transcribing"
  | "review"
  | "thinking"
  | "synthesizing"
  | "speaking"
  | "stopping";
export type VoiceSnapshot = Readonly<{
  phase: VoicePhase;
  generation: number;
  continuous: boolean;
  transcript: string;
  error: string;
  subtitle: string;
  position: number;
  duration: number;
  level: number;
  inputAvailable: boolean;
  outputAvailable: boolean;
  bargeInAvailable: boolean;
  aecAvailable: boolean;
}>;
