import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { toolAsset } from "./asset.js";
import { comparePixels, inspectionFrames, readPreview } from "./characters/preview.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { reference: { type: "string" }, capture: { type: "string" } },
});
const [before, after] = positionals;
if (!before || !after || positionals.length !== 2)
  throw new Error(
    "用法：pnpm character:inspect <之前/avatar.json> <之后/avatar.json> [--reference 立绘.png] [--capture 新目录]",
  );
const preview = {
  before: await readPreview(resolve(before)),
  after: await readPreview(resolve(after)),
  reference: values.reference ? pathToFileURL(await realpath(values.reference)).href : "",
  capture: values.capture ? resolve(values.capture) : "",
  frames: inspectionFrames,
};
if (preview.capture) await mkdir(preview.capture); // Never overwrite comparison evidence.
const temp = await mkdtemp(join(tmpdir(), "voidmaker-inspect-"));
try {
  const config = join(temp, "preview.json");
  await writeFile(config, JSON.stringify(preview));
  if (preview.capture) await writeFile(join(preview.capture, "preview.json"), JSON.stringify(preview, null, 2));
  // Quickshell blackholes relative imports outside its config folder. An explicit
  // file URL loads the real production component and its shaders without copying them.
  const qml = join(temp, "Inspector.qml");
  const shellUrl = pathToFileURL(dirname(await toolAsset("../shell/Character3D.qml"))).href;
  await writeFile(
    qml,
    (await readFile(await toolAsset("qml/CharacterInspector.qml"), "utf8")).replace(
      '"../../shell"',
      JSON.stringify(shellUrl),
    ),
  );
  const child = spawn("quickshell", ["--path", qml], {
    env: {
      ...process.env,
      VOIDMAKER_CHARACTER_PREVIEW: pathToFileURL(config).href,
      QML_XHR_ALLOW_FILE_READ: "1",
      QSG_RHI_BACKEND: "opengl",
    },
    stdio: "inherit",
  });
  const cancel = () => child.kill("SIGTERM");
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timeout = preview.capture ? setTimeout(cancel, 120_000) : undefined;
  try {
    await new Promise<void>((success, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0 ? success() : reject(new Error(`Qt 检查台退出：${signal ?? code}`)),
      );
    });
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  if (preview.capture) {
    const run = promisify(execFile);
    const results = [];
    for (const frame of inspectionFrames) {
      const pixels = [];
      for (const side of ["before", "after"]) {
        const path = join(preview.capture, `${frame.name}-${side}.png`);
        await readFile(path); // A missing capture must fail the command.
        const result = await run(
          "ffmpeg",
          ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
          { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
        );
        pixels.push(result.stdout);
      }
      results.push({ frame: frame.name, ...comparePixels(pixels[0] ?? Buffer.alloc(0), pixels[1] ?? Buffer.alloc(0)) });
    }
    const report = {
      note: "同一进程、相同相机和尺寸的 Qt 输出；像素误差是诊断数据，不能替代造型验收。",
      frames: results,
    };
    await writeFile(join(preview.capture, "pixels.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ capture: preview.capture, ...report }, null, 2));
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
