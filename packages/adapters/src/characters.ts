import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AvatarPresentation,
  avatarManifest,
  type CharacterSummary,
  characterDefinition,
  type PortraitExpression,
} from "../../contracts/src/character.js";
import type { ReplyClip, SpeechReference, WaitingClip } from "../../contracts/src/speech.js";
import { type PixelIcon, pixelIcon } from "../../contracts/src/tray-icon.js";
import type { VoiceConfig } from "../../contracts/src/voice.js";
import type { Portraits } from "../../domain/src/character.js";
import { assetPath, boundedFile } from "./character-assets.js";
import { readMotionRig } from "./character-motion.js";
import { readWav } from "./pcm.js";

export type Character = Readonly<{
  id: string;
  name: string;
  persona: string;
  revision: string;
  portraits: Portraits;
  portraitExpressions?: readonly PortraitExpression[];
  layered: boolean;
  trayIcon?: PixelIcon;
  avatar?: AvatarPresentation;
  speechReferences?: readonly SpeechReference[];
  waitingClips?: readonly WaitingClip[];
  replyClips?: readonly ReplyClip[];
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
      let trayIcon: PixelIcon | undefined;
      if (definition.trayIcon) {
        try {
          trayIcon = pixelIcon.parse(
            JSON.parse((await boundedFile(await assetPath(root, definition.trayIcon), 16 * 1024)).toString("utf8")),
          );
        } catch {
          warnings.push(`${definition.name}：托盘图标不可用，使用默认图标`);
        }
      }
      const portraitExpressions: PortraitExpression[] = [];
      for (const expression of definition.portraitExpressions ?? []) {
        try {
          if (expression.id === "neutral" || portraitExpressions.some((entry) => entry.id === expression.id))
            throw new Error("立绘表情 id 重复");
          portraitExpressions.push({
            id: expression.id,
            description: expression.description,
            imageUrl: await portrait(root, expression.image),
          });
        } catch {
          warnings.push(`${definition.name}：${expression.id} 表情立绘不可用，使用默认立绘`);
        }
      }
      const speechReferences: SpeechReference[] = [];
      const waitingClips: WaitingClip[] = [];
      const replyClips: ReplyClip[] = [];
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
                ...(part.style ? { style: part.style } : {}),
                ...(part.toon
                  ? {
                      toon: {
                        ambient: part.toon.ambient,
                        specular: part.toon.specular,
                        shininess: part.toon.shininess,
                        edgeColor: part.toon.edgeColor,
                        edgeSize: part.toon.edgeSize,
                        rampUrl: part.toon.ramp ? await portrait(dirname(manifestPath), part.toon.ramp) : "",
                      },
                    }
                  : {}),
              };
            }),
          );
          avatar = {
            kind: "quick3d",
            height: manifest.height,
            centerY: manifest.centerY,
            ...(manifest.width === undefined ? {} : { width: manifest.width }),
            ...(manifest.depth === undefined ? {} : { depth: manifest.depth }),
            centerX: manifest.centerX,
            framing: manifest.framing,
            ...(manifest.restEyes === undefined ? {} : { restEyes: manifest.restEyes }),
            ...(manifest.idleRig ? { idleRig: manifest.idleRig } : {}),
            ...(manifest.motionRig
              ? { motionRig: await readMotionRig(dirname(manifestPath), manifest.motionRig, manifest.poses ?? []) }
              : {}),
            ...(manifest.expressions ? { expressions: manifest.expressions } : {}),
            ...(manifest.poses ? { poses: manifest.poses } : {}),
            parts,
          };
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
        for (const clip of definition.voice.waitingClips ?? []) {
          try {
            const wav = await boundedFile(await assetPath(root, clip.audio), 2 * 1024 * 1024);
            const { duration } = readWav(wav);
            if (duration < 0.2 || duration > 5) throw new Error("过渡音应为简短应答");
            waitingClips.push({ wav, subtitle: clip.subtitle });
          } catch {
            warnings.push(`${definition.name}：过渡音不可用，已跳过`);
          }
        }
        for (const clip of definition.voice.replyClips ?? []) {
          try {
            if (clip.id === "none" || replyClips.some((entry) => entry.id === clip.id))
              throw new Error("句首原声 id 重复或保留");
            const wav = await boundedFile(await assetPath(root, clip.audio), 2 * 1024 * 1024);
            const { duration } = readWav(wav);
            if (duration < 0.2 || duration > 5) throw new Error("句首原声应为简短回应");
            replyClips.push({
              id: clip.id,
              description: clip.description,
              text: clip.text,
              subtitle: clip.subtitle,
              wav,
            });
          } catch {
            warnings.push(`${definition.name}：${clip.id} 句首原声不可用，已跳过`);
          }
        }
        for (const reference of definition.voice.references ?? []) {
          try {
            if (reference.id === "neutral" || speechReferences.some((entry) => entry.id === reference.id))
              throw new Error("参考音频 id 重复");
            const refAudioPath = await assetPath(root, reference.reference);
            const info = await stat(refAudioPath);
            if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("参考音频无效");
            speechReferences.push({
              id: reference.id,
              description: reference.description,
              refAudioPath,
              promptText: reference.promptText,
              promptLanguage: reference.promptLanguage,
            });
          } catch {
            warnings.push(`${definition.name}：${reference.id} 语气参考不可用，使用默认语气`);
          }
        }
      }
      entries.push({
        id: definition.id,
        name: definition.name,
        persona: definition.persona,
        layered: definition.portraits?.layered ?? false,
        revision: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
        portraits,
        ...(trayIcon ? { trayIcon } : {}),
        ...(portraitExpressions.length ? { portraitExpressions } : {}),
        ...(avatar ? { avatar } : {}),
        ...(voice ? { voice } : {}),
        ...(speechReferences.length ? { speechReferences } : {}),
        ...(waitingClips.length ? { waitingClips } : {}),
        ...(replyClips.length ? { replyClips } : {}),
      });
    } catch {
      warnings.push(`${name}：角色配置无效，已跳过`);
    }
  }
  return { entries, warnings };
}
