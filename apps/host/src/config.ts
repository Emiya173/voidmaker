import { homedir } from "node:os";
import { join } from "node:path";
import { VoiceSettingsStore } from "../../../packages/adapters/src/voice-settings.js";
import type { VoiceConfig } from "../../../packages/contracts/src/voice.js";
export function voiceSettingsStore(): VoiceSettingsStore {
  return new VoiceSettingsStore(
    process.env.VOIDMAKER_VOICE_CONFIG ??
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "voidmaker", "voice.json"),
  );
}
export async function loadVoiceConfig(): Promise<VoiceConfig> {
  return (await voiceSettingsStore().load()).config;
}
