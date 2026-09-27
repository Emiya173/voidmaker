import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Parser } from "mmd-parser";
import { avatarLook } from "../../../packages/contracts/src/character.js";
import { toolAsset } from "./asset.js";
import { auditBlenderGeometry } from "./characters/blender-audit.js";
import { readBlenderGeometry } from "./characters/blender-gltf.js";
import { convertPmx, pmxSchema } from "./characters/pmx.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    look: { type: "string" },
    pose: { type: "string", default: "original" },
    blend: { type: "string" },
    "allow-edits": { type: "boolean", default: false },
  },
});
const [input, destination] = positionals;
if (!input || !destination || positionals.length !== 2 || !["original", "relaxed"].includes(values.pose))
  throw new Error(
    "用法：pnpm character:roundtrip <原始.pmx> <新目录> [--look 外观.json] [--pose original|relaxed] [--blend 编辑.blend --allow-edits]",
  );
if (!process.env.VOIDMAKER_MMD_TOOLS) throw new Error("请在 nix develop .#character 环境运行");
if (values["allow-edits"] && !values.blend) throw new Error("允许修改需要指定经过编辑的 .blend");
const source = resolve(input),
  output = resolve(destination);
if ((await stat(source)).size > 64 * 1024 * 1024) throw new Error("PMX 文件过大");
if (values.look && (await stat(values.look)).size > 64 * 1024) throw new Error("外观配置过大");
const look = avatarLook.parse(values.look ? JSON.parse(await readFile(values.look, "utf8")) : {});
if (Object.keys(look.geometry ?? {}).length) throw new Error("往返比较不叠加程序形变；请从 look 中移除 geometry");
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Refuse overwrite; preserve diagnostics on failure.
const names = ["あ", "まばたき", ...(look.restEyes ? [look.restEyes.morph] : [])];
const script = await toolAsset("blender/character_exchange.py");
try {
  const blender = await promisify(execFile)(
    "blender",
    [
      "--background",
      "--factory-startup",
      "--disable-autoexec",
      "--python-exit-code",
      "1",
      "--python",
      script,
      "--",
      "--source",
      source,
      "--output",
      output,
      ...names.flatMap((name) => ["--morph", name]),
      ...(values.blend ? ["--blend", resolve(values.blend)] : []),
    ],
    { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
  );
  await writeFile(join(output, "blender.log"), blender.stdout + blender.stderr);
  const bytes = await readFile(source);
  const pmx = pmxSchema.parse(
    new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true),
  );
  const gltf = join(output, "blender.gltf");
  const audit = auditBlenderGeometry(pmx, await readBlenderGeometry(gltf));
  const toolchain = JSON.parse(await readFile(join(output, "blender-toolchain.json"), "utf8"));
  await writeFile(
    join(output, "audit.json"),
    `${JSON.stringify({ ...audit, toolchain, intentionalEdits: values["allow-edits"] }, null, 2)}\n`,
  );
  const pose = values.pose === "relaxed" ? "relaxed" : "original";
  const lookDirectory = values.look ? dirname(resolve(values.look)) : dirname(source);
  await convertPmx(source, join(output, "before"), "あ", "まばたき", pose, look, lookDirectory);
  await convertPmx(source, join(output, "after"), "あ", "まばたき", pose, look, lookDirectory, gltf);
  console.log(JSON.stringify({ output, ...audit }, null, 2));
  if (!audit.passed && !values["allow-edits"])
    throw new Error("零修改往返超出容差，保留报告和预览产物，禁止作为通过基准");
} catch (error) {
  if (error && typeof error === "object" && "stdout" in error && "stderr" in error)
    await writeFile(join(output, "blender.log"), String(error.stdout) + String(error.stderr));
  await writeFile(join(output, "failure.txt"), error instanceof Error ? error.message : String(error));
  throw error;
}
