import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AvatarPresentation,
  avatarManifest,
  type CharacterSummary,
  characterDefinition,
} from "../../contracts/src/character.js";
import type { VoiceConfig } from "../../contracts/src/voice.js";
import type { Portraits } from "../../domain/src/character.js";

export type Character = Readonly<{
  id: string;
  name: string;
  persona: string;
  revision: string;
  portraits: Portraits;
  layered: boolean;
  avatar?: AvatarPresentation;
  voice?: Readonly<Omit<NonNullable<VoiceConfig["tts"]>, "url" | "timeoutMs"> & { url?: string }>;
}>;
export type CharacterCatalog = Readonly<{ entries: readonly Character[]; warnings: readonly string[] }>;
export const defaultCharacter: Character = {
  id: "default",
  name: "VoidMaker",
  persona: "",
  revision: "builtin-1",
  portraits: {},
  layered: false,
};
export function characterTts(config: VoiceConfig["tts"], character: Character): VoiceConfig["tts"] {
  const voice = character.voice;
  if (voice?.url) return { ...voice, url: voice.url, timeoutMs: config?.timeoutMs ?? 120_000 };
  return config ? { ...config, ...voice } : undefined;
}
export function characterSummary(value: Character): CharacterSummary {
  return {
    id: value.id,
    name: value.name,
    hasPortrait: !!value.portraits.idle || !!value.avatar,
    hasVoice: !!value.voice,
  };
}
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("文件类型或大小无效");
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error("文件过大");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
async function assetPath(root: string, path: string): Promise<string> {
  const resolved = await realpath(join(root, path));
  const rel = relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("素材越出角色目录");
  return resolved;
}
async function portrait(root: string, path: string): Promise<string> {
  const resolved = await assetPath(root, path);
  const data = await boundedFile(resolved, 16 * 1024 * 1024);
  if (
    data.length < 24 ||
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("立绘须为 PNG");
  const width = data.readUInt32BE(16),
    height = data.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 24_000_000)
    throw new Error("立绘尺寸过大");
  return pathToFileURL(resolved).href;
}
export async function loadCharacters(
  directory = process.env.VOIDMAKER_CHARACTERS_DIR ??
    join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "voidmaker", "characters"),
): Promise<CharacterCatalog> {
  const entries: Character[] = [defaultCharacter],
    warnings: string[] = [];
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push("无法读取角色目录，使用内置助手");
    return { entries, warnings };
  }
  if (names.length > 32) warnings.push("只加载前 32 个角色目录");
  for (const name of names.slice(0, 32)) {
    try {
      const root = await realpath(join(directory, name));
      const definition = characterDefinition.parse(
        JSON.parse((await boundedFile(await assetPath(root, "character.json"), 64 * 1024)).toString("utf8")),
      );
      if (entries.some((entry) => entry.id === definition.id)) throw new Error("角色 id 重复");
      const portraits: Record<string, string> = {};
      for (const [state, path] of Object.entries(definition.portraits ?? {})) {
        if (typeof path !== "string") continue;
        try {
          portraits[state] = await portrait(root, path);
        } catch {
          warnings.push(`${definition.name}：${state} 立绘不可用，使用回退显示`);
        }
      }
      let voice: Character["voice"];
      let avatar: AvatarPresentation | undefined;
      if (definition.avatar) {
        try {
          const manifestPath = await assetPath(root, definition.avatar.manifest);
          const manifest = avatarManifest.parse(
            JSON.parse((await boundedFile(manifestPath, 64 * 1024)).toString("utf8")),
          );
          const parts = await Promise.all(
            manifest.parts.map(async (part) => {
              const mesh = await assetPath(dirname(manifestPath), part.mesh);
              const info = await stat(mesh);
              if (!info.isFile() || info.size < 32 || info.size > 64 * 1024 * 1024) throw new Error("网格文件无效");
              return {
                meshUrl: pathToFileURL(mesh).href,
                textureUrl: part.texture ? await portrait(dirname(manifestPath), part.texture) : "",
                color: part.color,
                doubleSided: part.doubleSided,
              };
            }),
          );
          avatar = { kind: "quick3d", height: manifest.height, centerY: manifest.centerY, parts };
        } catch {
          warnings.push(`${definition.name}：3D 素材不可用，使用立绘回退`);
        }
      }
      if (definition.voice) {
        const refAudioPath = await assetPath(root, definition.voice.reference);
        const info = await stat(refAudioPath);
        if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("语音参考文件无效");
        voice = {
          refAudioPath,
          promptText: definition.voice.promptText,
          promptLanguage: definition.voice.promptLanguage,
          textLanguage: definition.voice.textLanguage,
          ...(definition.voice.url ? { url: definition.voice.url } : {}),
        };
      }
      entries.push({
        id: definition.id,
        name: definition.name,
        persona: definition.persona,
        layered: definition.portraits?.layered ?? false,
        revision: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
        portraits,
        ...(avatar ? { avatar } : {}),
        ...(voice ? { voice } : {}),
      });
    } catch {
      warnings.push(`${name}：角色配置无效，已跳过`);
    }
  }
  return { entries, warnings };
}
