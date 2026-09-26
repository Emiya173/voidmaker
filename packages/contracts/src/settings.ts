import { z } from "zod";
import { type VoiceConfig, voiceConfigSchema } from "./voice.js";

export const settingsCommands = [
  z.object({ type: z.literal("settings_get") }),
  z.object({ type: z.literal("settings_save"), revision: z.string().min(1).max(64), config: voiceConfigSchema }),
  z.object({ type: z.literal("settings_restore"), revision: z.string().min(1).max(64) }),
  z.object({ type: z.literal("settings_reload") }),
  z.object({ type: z.literal("diagnostics_start") }),
  z.object({ type: z.literal("diagnostics_cancel") }),
] as const;
export type SettingsSnapshot = Readonly<{
  config: VoiceConfig;
  revision: string;
  path: string;
  error: string;
  canRestore: boolean;
  busy: boolean;
}>;
export type AudioDevice = Readonly<{ name: string; description: string; kind: "input" | "output" }>;
export type DiagnosticStatus = "ready" | "reachable" | "warming" | "unconfigured" | "error";
export type DiagnosticResult = Readonly<{ id: string; label: string; status: DiagnosticStatus; detail: string }>;
export type DiagnosticsSnapshot = Readonly<{
  generation: number;
  phase: "idle" | "running" | "complete" | "cancelled";
  checkedAt: string | null;
  results: readonly DiagnosticResult[];
  devices: readonly AudioDevice[];
}>;
export type SettingsEvent =
  | { type: "settings_applied" }
  | { type: "settings"; settings: SettingsSnapshot }
  | { type: "diagnostics"; diagnostics: DiagnosticsSnapshot }
  | { type: "shell_visibility"; action: "toggle" | "show"; settings: boolean };
