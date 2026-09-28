import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export async function boundedFile(path: string, limit: number): Promise<Buffer> {
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

export async function assetPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const resolved = await realpath(join(canonicalRoot, path));
  const rel = relative(canonicalRoot, resolved);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("素材越出角色目录");
  return resolved;
}
