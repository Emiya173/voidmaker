import { z } from "zod";
import { localUrl } from "./voice.js";

export const characterId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const asset = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => part === ".." || !part),
    "素材须为角色目录内的相对路径",
  );
const color = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);
export const avatarManifest = z
  .object({
    height: z.number().positive().max(100000),
    centerY: z.number().min(-100000).max(100000),
    parts: z
      .array(
        z
          .object({
            mesh: asset.refine((path) => path.endsWith(".mesh")),
            texture: asset.optional(),
            color,
            doubleSided: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();
export type AvatarPresentation = Readonly<{
  kind: "quick3d";
  height: number;
  centerY: number;
  parts: readonly Readonly<{ meshUrl: string; textureUrl: string; color: readonly number[]; doubleSided: boolean }>[];
}>;
export const characterDefinition = z
  .object({
    version: z.literal(1),
    id: characterId.refine((id) => id !== "default", "default 为内置助手"),
    name: z.string().trim().min(1).max(80),
    persona: z.string().trim().min(1).max(12000),
    avatar: z
      .object({ kind: z.literal("quick3d"), manifest: asset })
      .strict()
      .optional(),
    portraits: z
      .object({
        idle: asset,
        layered: z.boolean().default(false),
        listening: asset.optional(),
        thinking: asset.optional(),
        speaking: asset.optional(),
        mouthOpen: asset.optional(),
      })
      .strict()
      .optional(),
    voice: z
      .object({
        reference: asset,
        promptText: z.string().trim().min(1).max(2000),
        promptLanguage: z.string().min(1).max(32).default("zh"),
        textLanguage: z.string().min(1).max(32).default("auto"),
        url: localUrl.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CharacterDefinition = z.infer<typeof characterDefinition>;
export type CharacterSummary = Readonly<{ id: string; name: string; hasPortrait: boolean; hasVoice: boolean }>;
export type CharacterPresentation = Readonly<{
  state: "idle" | "listening" | "thinking" | "speaking" | "error";
  imageUrl: string;
  baseUrl: string;
  mouth: number;
  subtitle: string;
  avatar?: AvatarPresentation;
}>;
export type CharacterSnapshot = Readonly<{
  selectedId: string;
  sessionId: string;
  characters: readonly CharacterSummary[];
  changing: boolean;
  warnings: readonly string[];
  presentation: CharacterPresentation;
}>;
