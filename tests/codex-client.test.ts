import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServer } from "../packages/adapters/src/codex.js";

const clients: CodexAppServer[] = [];

async function client(): Promise<CodexAppServer> {
  const instance = new CodexAppServer(async () => "decline", process.cwd(), process.execPath, [
    join(process.cwd(), "tests/fixtures/fake-codex.mjs"),
  ]);
  clients.push(instance);
  await instance.start();
  return instance;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((instance) => instance.close()));
});

describe("Codex App Server transport", () => {
  it("streams the final message without mixing commentary", async () => {
    const instance = await client();
    const threadId = await instance.startThread();
    const deltas: string[] = [];
    const result = await instance.run(threadId, "hello", (text) => deltas.push(text));
    expect(result).toBe("你好");
    expect(deltas).toEqual(["你好"]);
  });

  it("interrupts a turn before its start response and accepts a subsequent turn", async () => {
    const instance = await client();
    const threadId = await instance.startThread();
    const run = instance.run(threadId, "wait", () => undefined);
    const stopped = expect(run).rejects.toThrow("轮次已停止");
    await instance.interrupt();
    await stopped;
    expect(await instance.run(threadId, "hello", () => undefined)).toBe("你好");
  });

  it("reports a subprocess failure rather than leaving the turn pending", async () => {
    const instance = await client();
    const threadId = await instance.startThread();
    await expect(instance.run(threadId, "crash", () => undefined)).rejects.toThrow("Codex App Server 退出");
  });

  it("responds to approval requests with string RPC IDs", async () => {
    const instance = await client();
    const threadId = await instance.startThread();
    expect(await instance.run(threadId, "approval", () => undefined)).toBe("decline");
  });
});
