import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { parse } from "yaml";
import { z } from "zod";
import { characterDefinition, characterId } from "../../../../packages/contracts/src/character.js";
import { localUrl } from "../../../../packages/contracts/src/voice.js";

const run = promisify(execFile);
const metadata = z
  .array(
    z.object({
      name: z.string(),
      character_setting: z.string(),
      prompt_text: z.string(),
      prompt_lang: z.string(),
      gpt_model_path: z.string(),
      sovits_model_path: z.string(),
      refer_audio_path: z.string(),
      sprites: z
        .array(z.object({ path: z.string() }))
        .min(1)
        .max(128),
    }),
  )
  .length(1);

// Exporters embed Windows paths. Match only an unambiguous basename; never use
// exporter paths as destinations or execute any code/serialized model objects.
export function unpackCharacter(bytes: Uint8Array) {
  if (bytes.length > 512 * 1024 * 1024) throw new Error("角色包超过 512 MiB");
  let total = 0,
    count = 0;
  const files = unzipSync(bytes, {
    filter: (entry) => {
      total += entry.originalSize;
      if (++count > 512 || total > 768 * 1024 * 1024) throw new Error("角色包解压大小或文件数超限");
      if (entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.split("/").includes(".."))
        throw new Error("角色包包含非法路径");
      return !entry.name.endsWith("/");
    },
  });
  const yaml = files["character.yaml"];
  if (!yaml || yaml.length > 64 * 1024) throw new Error("缺少有效 character.yaml");
  const [info] = metadata.parse(parse(Buffer.from(yaml).toString("utf8"), { maxAliasCount: 0 }));
  if (!info) throw new Error("角色元数据为空");
  const find = (path: string) => {
    const name = basename(path.replaceAll("\\", "/"));
    const matches = Object.entries(files).filter(([key]) => basename(key) === name);
    const match = matches[0];
    if (matches.length !== 1 || !match) throw new Error(`素材缺失或重名：${name}`);
    return match[1];
  };
  return { info, find };
}

export async function importCharacter(source: string, destination: string, id: string, endpoint: string) {
  characterId.parse(id);
  localUrl.parse(endpoint);
  if ((await stat(source)).size > 512 * 1024 * 1024) throw new Error("角色包过大");
  const bytes = await readFile(source);
  const { info, find } = unpackCharacter(bytes);
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  // Reserve the destination before writing so a second import cannot overwrite it.
  await mkdir(target);
  const staging = await mkdtemp(join(dirname(target), ".import-"));
  try {
    await mkdir(join(staging, "voice"));
    await mkdir(join(staging, "portraits"));
    await writeFile(join(staging, "voice/gpt.ckpt"), find(info.gpt_model_path));
    await writeFile(join(staging, "voice/sovits.pth"), find(info.sovits_model_path));
    await writeFile(join(staging, "voice/reference.wav"), find(info.refer_audio_path));
    const sprite = info.sprites[0];
    if (!sprite) throw new Error("角色缺少立绘");
    const original = join(staging, `portraits/source${/\.webp$/i.test(sprite.path) ? ".webp" : ".png"}`);
    await writeFile(original, find(sprite.path));
    await run(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-i", original, "-frames:v", "1", join(staging, "portraits/idle.png")],
      { timeout: 30_000 },
    );
    await rm(original);
    const definition = characterDefinition.parse({
      version: 1,
      id,
      name: info.name,
      persona: info.character_setting,
      portraits: { idle: "portraits/idle.png" },
      voice: {
        reference: "voice/reference.wav",
        promptText: info.prompt_text,
        promptLanguage: info.prompt_lang,
        textLanguage: "auto",
        url: endpoint,
      },
    });
    await writeFile(join(staging, "character.json"), `${JSON.stringify(definition, null, 2)}\n`);
    await writeFile(
      join(staging, "provenance.json"),
      `${JSON.stringify(
        {
          format: "Shinsekai .char",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          importedAt: new Date().toISOString(),
          weights: { gpt: "voice/gpt.ckpt", sovits: "voice/sovits.pth" },
        },
        null,
        2,
      )}\n`,
    );
    await rename(staging, target);
    return definition;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rmdir(target).catch(() => undefined);
    throw error;
  }
}
