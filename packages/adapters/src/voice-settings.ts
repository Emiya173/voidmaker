import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { SettingsSnapshot } from "../../contracts/src/settings.js";
import { type VoiceConfig, voiceConfigSchema } from "../../contracts/src/voice.js";

const MAX_BYTES = 64 * 1024;
const revision = (bytes: Buffer | null) =>
  createHash("sha256")
    .update(bytes ?? "missing")
    .digest("hex");
async function bounded(path: string): Promise<Buffer | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("配置须为不超过 64 KiB 的普通文件");
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error("配置超过 64 KiB");
      return bytes.subarray(0, length);
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function parse(bytes: Buffer | null): VoiceConfig {
  return voiceConfigSchema.parse(bytes ? JSON.parse(bytes.toString("utf8")) : {});
}
async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
export class VoiceSettingsStore {
  constructor(readonly path: string) {}
  async load(): Promise<SettingsSnapshot> {
    const bytes = await bounded(this.path);
    let config = voiceConfigSchema.parse({}),
      error = "";
    try {
      config = parse(bytes);
    } catch {
      error = "配置格式或字段无效，语音暂未启用。可修正保存，或恢复上一份配置。";
    }
    let canRestore = false;
    try {
      const previous = await bounded(`${this.path}.previous`);
      if (previous) {
        parse(previous);
        canRestore = true;
      }
    } catch {
      /* Unusable backup isn't offered. */
    }
    return { config, revision: revision(bytes), path: this.path, error, canRestore, busy: false };
  }
  async save(expected: string, config: VoiceConfig): Promise<SettingsSnapshot> {
    const validated = voiceConfigSchema.parse(config);
    const bytes = Buffer.from(`${JSON.stringify(validated, null, 2)}\n`);
    if (bytes.length > MAX_BYTES) throw new Error("配置超过 64 KiB");
    const stat = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (stat?.isSymbolicLink()) throw new Error("配置是声明式管理的符号链接，请先改用可写的本地配置文件");
    const current = await bounded(this.path);
    if (revision(current) !== expected) throw new Error("配置已被其他操作修改，请重新读取后再保存");
    let canRestore = false;
    try {
      const previous = await bounded(`${this.path}.previous`);
      if (previous) {
        parse(previous);
        canRestore = true;
      }
    } catch {
      /* Invalid backup is ignored. */
    }
    if (current) {
      let valid = false;
      try {
        parse(current);
        valid = true;
      } catch {
        /* Keep invalid input for manual recovery. */
      }
      await atomicWrite(`${this.path}.${valid ? "previous" : "invalid-backup"}`, current);
      if (valid) canRestore = true;
    }
    if (revision(await bounded(this.path)) !== expected) throw new Error("保存期间配置已改变，请重新读取");
    await atomicWrite(this.path, bytes);
    // No fallible reads after the commit point: the active configuration must match disk.
    return {
      config: validated,
      revision: revision(bytes),
      path: this.path,
      error: "",
      canRestore,
      busy: false,
    };
  }
  async restore(expected: string): Promise<SettingsSnapshot> {
    const previous = await bounded(`${this.path}.previous`);
    if (!previous) throw new Error("没有可恢复的配置");
    return this.save(expected, parse(previous));
  }
}
