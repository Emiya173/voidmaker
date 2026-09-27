import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Locate repository-owned runtime assets from either tsx sources or dist output. */
export async function toolAsset(relative: string): Promise<string> {
  let root = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const path = join(root, "apps", "tools", relative);
    if ((await stat(path).catch(() => undefined))?.isFile()) return path;
    const parent = dirname(root);
    if (parent === root) throw new Error(`缺少开发工具资源：${relative}`);
    root = parent;
  }
}
