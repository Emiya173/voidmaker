import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { avatarLook } from "../../../packages/contracts/src/character.js";
import { convertPmx } from "./characters/pmx.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { pose: { type: "string", default: "original" }, look: { type: "string" }, blender: { type: "string" } },
});
const [source, output] = positionals;
if (!source || !output || !["original", "relaxed"].includes(values.pose) || positionals.length !== 2)
  throw new Error(
    "用法：pnpm character:pmx <模型.pmx> <新输出目录> [--pose original|relaxed] [--look 外观.json] [--blender 几何.gltf]",
  );
if (values.look && (await stat(values.look)).size > 64 * 1024) throw new Error("外观配置过大");
const look = avatarLook.parse(values.look ? JSON.parse(await readFile(values.look, "utf8")) : {});
console.log(
  JSON.stringify(
    await convertPmx(
      source,
      output,
      "あ",
      "まばたき",
      values.pose === "relaxed" ? "relaxed" : "original",
      look,
      values.look ? dirname(resolve(values.look)) : dirname(resolve(source)),
      values.blender,
    ),
    null,
    2,
  ),
);
