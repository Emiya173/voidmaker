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
  it("isolates work policy and forwards progress without changing the chat default", async () => {
    const events: string[] = [];
    const instance = new CodexAppServer(
      async () => "decline",
      process.cwd(),
      process.execPath,
      [join(process.cwd(), "tests/fixtures/fake-codex.mjs")],
      { work: true, onEvent: (method) => events.push(method) },
    );
    clients.push(instance);
    await instance.start();
    const thread = await instance.startThread();
    const policy = JSON.parse(await instance.run(thread, "policy", () => undefined));
    expect(policy.threadParams.sandbox).toBe("workspace-write");
    expect(policy.threadParams.config.mcp_servers.test.enabled).toBe(false);
    expect(policy.threadParams.config.apps.test.enabled).toBe(false);
    expect(policy.turnParams.sandboxPolicy.networkAccess).toBe(false);
    expect(policy.turnParams.sandboxPolicy.writableRoots).toEqual([process.cwd()]);
    expect(policy.turnParams.approvalsReviewer).toBe("user");
    expect(policy.turnParams.outputSchema.required).toContain("outcome");
    expect(events).toContain("turn/started");
    expect(events).toContain("turn/completed");
  });
  it("restricts observer tools, uses ephemeral structured output and explicit image input", async () => {
    const instance = new CodexAppServer(
      async () => "accept",
      process.cwd(),
      process.execPath,
      [join(process.cwd(), "tests/fixtures/fake-codex.mjs")],
      { restricted: true, observer: true },
    );
    clients.push(instance);
    await instance.start();
    const thread = await instance.startThread();
    const image = "data:image/png;base64,fixture";
    const policy = JSON.parse(await instance.run(thread, "policy", () => undefined, [image]));
    expect(policy.threadParams.ephemeral).toBe(true);
    expect(policy.threadParams.approvalPolicy).toBe("never");
    expect(policy.threadParams.config["features.shell_tool"]).toBe(false);
    expect(policy.threadParams.config.mcp_servers.test.enabled).toBe(false);
    expect(policy.turnParams.outputSchema.required).toEqual(["speak", "text"]);
    expect(policy.turnParams.input[1]).toEqual({ type: "image", url: image });
    expect(await instance.run(thread, "approval", () => undefined)).toBe("decline");
  });
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
