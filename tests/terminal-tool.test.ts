import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { executeTerminal, terminalTool } from "../packages/adapters/src/terminal-tool.js";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "voidmaker-terminal-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("returns command output, exit status and the requested working directory", async () => {
  const cwd = await directory();
  const result = await terminalTool(cwd, () => true).call(
    { command: "pwd; printf '完成'; printf '失败原因' >&2; exit 7", cwd: null, timeoutSeconds: 2 },
    new AbortController().signal,
  );
  expect(result.success).toBe(false);
  expect(JSON.parse((result.contentItems[0] as { text: string }).text)).toMatchObject({
    exitCode: 7,
    stdout: `${cwd}\n完成`,
    stderr: "失败原因",
    error: null,
  });
});

it("rejects proactive turns, malformed arguments and already cancelled calls before spawning", async () => {
  const cwd = await directory();
  const args = { command: "touch executed", cwd: null, timeoutSeconds: 2 };
  await expect(terminalTool(cwd, () => false).call(args, new AbortController().signal)).rejects.toThrow("用户发起");
  const tool = terminalTool(cwd, () => true);
  await expect(tool.call({ ...args, cwd: "relative" }, new AbortController().signal)).rejects.toThrow();
  await expect(tool.call({ ...args, timeoutSeconds: 61 }, new AbortController().signal)).rejects.toThrow();
  await expect(tool.call(args, AbortSignal.abort(new Error("已停止")))).rejects.toThrow("已停止");
  await expect(access(join(cwd, "executed"))).rejects.toThrow();
});

it.each(["abort", "timeout"])("reaps child processes which ignore SIGTERM on %s", async (mode) => {
  const cwd = await directory();
  const abort = new AbortController();
  const operation = executeTerminal(
    'trap "" TERM; (trap "" TERM; sleep 1.2; printf stale > late.txt) & printf ready > ready.txt; wait',
    cwd,
    abort.signal,
    mode === "timeout" ? 100 : 3000,
  );
  const observed = operation.catch((error: unknown) => error);
  await vi.waitFor(async () => expect(await readFile(join(cwd, "ready.txt"), "utf8")).toBe("ready"));
  if (mode === "abort") abort.abort(new Error("停止对话"));
  const result = await observed;
  if (mode === "abort") expect(result).toEqual(new Error("停止对话"));
  else expect(result).toMatchObject({ error: "终端命令超时", signal: "SIGKILL" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  await expect(access(join(cwd, "late.txt"))).rejects.toThrow();
});

it("bounds output and reports startup failures without hanging", async () => {
  const result = await executeTerminal("yes x", await directory(), new AbortController().signal, 2000);
  expect(result.error).toContain("64 KiB");
  expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024);
  const missing = await executeTerminal("true", "/missing/voidmaker-cwd", new AbortController().signal, 2000);
  expect(missing.error).toContain("无法启动");
});
