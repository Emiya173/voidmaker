import { isAbsolute } from "node:path";
import { z } from "zod";

export const aecSettingsSchema = z
  .object({
    nearendSnr: z.number().min(1).max(100).default(30),
    nearendEnr: z.number().min(0.01).max(10).default(0.25),
    nearendTrigger: z.number().int().min(1).max(100).default(12),
    nearendHold: z.number().int().min(1).max(500).default(50),
    nearendInitial: z.boolean().default(true),
    initialSeconds: z.number().min(0).max(10).default(2.5),
    nearendTransparency: z.number().min(1).max(8).default(1),
  })
  .strict();
export type AecSettings = z.infer<typeof aecSettingsSchema>;

/** Offline listening candidate; subsequent live intelligibility/echo acceptance failed. */
export const nearendProtectionSettings = aecSettingsSchema.parse({
  nearendSnr: 3,
  nearendEnr: 1,
  nearendTrigger: 1,
  nearendHold: 125,
  nearendTransparency: 4,
});

export const aecConfigSchema = z
  .object({
    pluginDirectory: z.string().refine(isAbsolute, "AEC 插件目录必须是绝对路径"),
    outputTarget: z.string().min(1),
    settings: aecSettingsSchema.default(nearendProtectionSettings),
    bargeIn: z.boolean().default(false),
    confirmationMs: z.number().int().min(150).max(1000).default(300),
    threshold: z.number().min(0.005).max(0.2).default(0.015),
    referenceRatio: z.number().min(1).max(30).default(3),
  })
  .strict();
export type AecConfig = z.infer<typeof aecConfigSchema>;

export function aecArguments(settings: AecSettings): Readonly<Record<string, string | number | boolean>> {
  return {
    "webrtc.gain_control": false,
    "webrtc.noise_suppression": false,
    "webrtc.aec3.nearend-snr": settings.nearendSnr,
    "webrtc.aec3.nearend-enr": settings.nearendEnr,
    "webrtc.aec3.nearend-trigger": settings.nearendTrigger,
    "webrtc.aec3.nearend-hold": settings.nearendHold,
    "webrtc.aec3.nearend-initial": settings.nearendInitial,
    "webrtc.aec3.initial-seconds": settings.initialSeconds,
    "webrtc.aec3.nearend-transparency": settings.nearendTransparency,
  };
}
