import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Artifact } from "../../contracts/src/work.js";

export async function projectPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("项目必须使用绝对路径");
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error("项目路径不是目录");
  return canonical;
}
function within(root: string, path: string): string {
  const local = relative(root, path);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new Error("产物路径超出项目目录");
  return local;
}
export async function inspectArtifact(
  root: string,
  path: string,
): Promise<{
  artifact: Omit<Artifact, "id" | "attemptId">;
  preview: string;
}> {
  if ((await projectPath(root)) !== root) throw new Error("项目路径已被替换");
  const canonical = await realpath(resolve(root, path));
  within(root, canonical);
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // Validate the opened inode as well as the input path (Linux /proc, our target platform).
    const actual = await realpath(`/proc/self/fd/${file.fd}`);
    const local = within(root, actual);
    const before = await file.stat();
    if (!before.isFile()) throw new Error("产物不是普通文件");
    if (before.size > 20 * 1024 * 1024) throw new Error("产物超过 20 MiB 查看上限");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const data = buffer.subarray(0, length);
    const after = await file.stat();
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || length !== before.size)
      throw new Error("产物正在修改，请稍后重试");
    const text = !data.subarray(0, 65536).includes(0);
    return {
      artifact: {
        path: local,
        sha256: createHash("sha256").update(data).digest("hex"),
        size: data.length,
        kind: text ? "text" : "binary",
      },
      preview: text
        ? data.subarray(0, 65536).toString("utf8") + (data.length > 65536 ? "\n…仅显示前 64 KiB" : "")
        : "二进制文件，仅显示文件信息。",
    };
  } finally {
    await file.close();
  }
}
