import { z } from "zod";
import type { AvatarMotionRig } from "./character-motion.js";
import { localUrl } from "./voice.js";

export const characterId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const characterAssetPath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => part === ".." || !part),
    "素材须为角色目录内的相对路径",
  );
const asset = characterAssetPath;
const color = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);
const rgb = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
const coordinate = z.number().min(-100000).max(100000);
const point3 = z.tuple([coordinate, coordinate, coordinate]);
const uvPoint = z.tuple([z.number().min(-8).max(8), z.number().min(-8).max(8)]);
const expressionMix = z
  .object({
    morphs: z
      .record(z.string().min(1).max(128), z.number().min(0).max(1))
      .refine(
        (values) => Object.keys(values).length > 0 && Object.keys(values).length <= 16,
        "表情组合须含 1 至 16 个形态键",
      ),
  })
  .strict();
const expressionNames = z
  .array(z.enum(["sleepy", "smile"]))
  .max(2)
  .refine((names) => new Set(names).size === names.length, "表情槽不能重复");
const alphaFeather = z
  .object({
    center: uvPoint,
    scale: z.tuple([z.number().finite().min(0.0001).max(64), z.number().finite().min(0.0001).max(64)]),
    inner: z.number().finite().min(0).max(32),
    outer: z.number().finite().positive().max(32),
  })
  .strict()
  .refine((value) => value.outer > value.inner, "透明过渡外径须大于内径");
export const avatarMaterialStyle = z
  .object({
    tint: rgb.default([1, 1, 1]),
    saturation: z.number().min(0).max(2).default(1),
    contrast: z.number().min(0.5).max(1.5).default(1),
    shadeStrength: z.number().min(0).max(0.5).default(0),
    textureStrength: z.number().min(0).max(0.1).default(0),
    specularStrength: z.number().min(0).max(2).default(1),
    outlineScale: z.number().min(0).max(2).default(1),
    outlineColor: rgb.optional(),
    rampStrength: z.number().min(0).max(1).optional(),
    shadeTint: rgb.optional(),
    alphaFeather: alphaFeather.optional(),
  })
  .strict();
export const avatarLook = z
  .object({
    materials: z.record(z.string().min(1).max(128), avatarMaterialStyle).default({}),
    sourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    // Offline conversion only; paths are relative to the look file, never runtime URLs.
    textures: z.record(asset, asset).optional(),
    geometry: z
      .record(
        z.string().min(1).max(128),
        z
          .object({
            transform: z
              .object({
                pivot: point3,
                rotation: z.tuple([
                  z.number().min(-180).max(180),
                  z.number().min(-180).max(180),
                  z.number().min(-180).max(180),
                ]),
                translation: point3,
                scale: z.number().min(0.5).max(2).default(1),
              })
              .strict()
              .optional(),
            brushes: z
              .array(
                z
                  .object({
                    center: point3,
                    radius: z.tuple([
                      z.number().min(0.0001).max(100000),
                      z.number().min(0.0001).max(100000),
                      z.number().min(0.0001).max(100000),
                    ]),
                    offset: point3,
                    edgeScale: z.number().min(0).max(2).default(1),
                    // Fraction of the ellipsoid radius with full brush influence.
                    inner: z.number().min(0).max(0.95).default(0),
                    uvRegion: z
                      .object({ min: uvPoint, max: uvPoint })
                      .strict()
                      .refine((region) => region.max.every((n, i) => n >= (region.min[i] ?? 0)), "UV 选择范围无效")
                      .optional(),
                  })
                  .strict(),
              )
              .max(64)
              .default([]),
          })
          .strict(),
      )
      .optional(),
    restEyes: z
      .object({ morph: z.string().min(1).max(128), weight: z.number().min(0).max(0.6) })
      .strict()
      .optional(),
    // Opt-in six-joint presentation skinning, derived from original PMX weights.
    idleMotion: z.boolean().optional(),
    // Full skeleton/clip resources for offline conversion, relative to this look.
    motionRig: asset.optional(),
    expressions: z.object({ sleepy: expressionMix.optional(), smile: expressionMix.optional() }).strict().optional(),
    poses: z.object({ yawn: asset.optional(), think: asset.optional(), greet: asset.optional() }).strict().optional(),
  })
  .strict()
  .refine((value) => !value.motionRig || !value.idleMotion, "完整动作骨架不能与六关节待机转换同时启用");
export type AvatarLook = z.infer<typeof avatarLook>;
const toon = z
  .object({
    ambient: rgb,
    specular: rgb,
    shininess: z.number().min(0).max(1000),
    ramp: asset.optional(),
    edgeColor: color,
    edgeSize: z.number().min(0).max(10),
  })
  .strict();
const framing = z
  .object({
    yaw: z.number().min(-45).max(45).default(0),
    zoom: z.number().min(0.5).max(3).default(1),
    // Offset from the model center, as a fraction of its height.
    targetY: z.number().min(-0.5).max(0.5).default(0),
  })
  .strict();
export const avatarIdleRig = z
  .object({
    version: z.literal(1),
    // root, chest, neck, head, left eye, right eye in the mesh bind coordinates.
    pivots: z.array(point3).length(6),
  })
  .strict();
export type AvatarIdleRig = z.infer<typeof avatarIdleRig>;
export const avatarManifest = z
  .object({
    height: z.number().positive().max(100000),
    centerY: z.number().min(-100000).max(100000),
    width: z.number().positive().max(100000).optional(),
    depth: z.number().positive().max(100000).optional(),
    centerX: z.number().min(-100000).max(100000).default(0),
    framing: framing.default({ yaw: 0, zoom: 1, targetY: 0 }),
    // If present, mesh morph slot 2 contains a neutral eyelid adjustment.
    restEyes: z.number().min(0).max(0.6).optional(),
    idleRig: avatarIdleRig.optional(),
    motionRig: asset.optional(),
    expressions: expressionNames.optional(),
    poses: z
      .array(z.enum(["yawn", "think", "greet"]))
      .max(3)
      .refine((names) => new Set(names).size === names.length, "姿势槽不能重复")
      .optional(),
    parts: z
      .array(
        z
          .object({
            mesh: asset.refine((path) => path.endsWith(".mesh")),
            texture: asset.optional(),
            color,
            doubleSided: z.boolean().default(false),
            toon: toon.optional(),
            style: avatarMaterialStyle.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict()
  .refine((value) => !value.idleRig || !value.motionRig, "完整动作骨架不能与六关节待机骨架同时存在");
export type AvatarPresentation = Readonly<{
  kind: "quick3d";
  height: number;
  centerY: number;
  width?: number;
  depth?: number;
  centerX?: number;
  framing?: Readonly<z.infer<typeof framing>>;
  restEyes?: number;
  idleRig?: Readonly<AvatarIdleRig>;
  motionRig?: AvatarMotionRig;
  expressions?: readonly ("sleepy" | "smile")[];
  poses?: readonly ("yawn" | "think" | "greet")[];
  parts: readonly Readonly<{
    meshUrl: string;
    textureUrl: string;
    color: readonly number[];
    doubleSided: boolean;
    toon?: Readonly<Omit<z.infer<typeof toon>, "ramp"> & { rampUrl: string }>;
    style?: Readonly<z.infer<typeof avatarMaterialStyle>>;
  }>[];
}>;
export const characterDefinition = z
  .object({
    version: z.literal(1),
    id: characterId.refine((id) => id !== "default", "default 为内置助手"),
    name: z.string().trim().min(1).max(80),
    persona: z.string().trim().min(1).max(12000),
    trayIcon: asset.optional(),
    portraitExpressions: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
            description: z.string().trim().min(1).max(300),
            image: asset,
          })
          .strict(),
      )
      .max(24)
      .optional(),
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
        waitingClips: z
          .array(z.object({ audio: asset, subtitle: z.string().trim().min(1).max(80) }).strict())
          .max(8)
          .optional(),
        replyClips: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
                description: z.string().trim().min(1).max(300),
                audio: asset,
                text: z.string().trim().min(1).max(160),
                subtitle: z.string().trim().min(1).max(80),
              })
              .strict(),
          )
          .max(16)
          .optional(),
        references: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
                description: z.string().trim().min(1).max(300),
                reference: asset,
                promptText: z.string().trim().min(1).max(2000),
                promptLanguage: z.string().min(1).max(32).default("ja"),
              })
              .strict(),
          )
          .max(24)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CharacterDefinition = z.infer<typeof characterDefinition>;
export type PortraitExpression = Readonly<{ id: string; description: string; imageUrl: string }>;
export type CharacterSummary = Readonly<{ id: string; name: string; hasPortrait: boolean; hasVoice: boolean }>;
export type CharacterPresentation = Readonly<{
  state: "idle" | "listening" | "thinking" | "speaking" | "error";
  imageUrl: string;
  baseUrl: string;
  mouth: number;
  subtitle: string;
  avatar?: AvatarPresentation;
  expressionId?: string;
}>;
export type CharacterSnapshot = Readonly<{
  selectedId: string;
  sessionId: string;
  characters: readonly CharacterSummary[];
  changing: boolean;
  warnings: readonly string[];
  presentation: CharacterPresentation;
}>;
