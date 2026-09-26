import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type VoiceConfig, voiceConfigSchema } from "../../../packages/contracts/src/voice.js";

export async function loadVoiceConfig(): Promise<VoiceConfig> {
  const path =
    process.env.VOIDMAKER_VOICE_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "voidmaker", "voice.json");
  try {
    return voiceConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.VOIDMAKER_VOICE_CONFIG)
      return voiceConfigSchema.parse({});
    throw new Error(`语音配置加载失败: ${path}`, { cause: error });
  }
}
