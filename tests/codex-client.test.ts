import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "../packages/adapters/src/codex.js";
import { desktopTool } from "../packages/adapters/src/desktop-tool.js";

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
  it("registers only desktop functions, returns image content, and rejects stale or malformed requests", async () => {
    const read = vi.fn(async () => ({
      context: "fixture",
      imageUrl: "data:image/png;base64,fixture",
      signal: new AbortController().signal,
    }));
    const instance = new CodexAppServer(
      async () => "decline",
      process.cwd(),
      process.execPath,
      [join(process.cwd(), "tests/fixtures/fake-codex.mjs")],
      { restricted: true, tools: [desktopTool(read)] },
    );
    clients.push(instance);
    await instance.start();
    const thread = await instance.startThread();
    const policy = JSON.parse(await instance.run(thread, "policy", () => {}));
    expect(policy.threadParams.dynamicTools).toHaveLength(1);
    expect(policy.threadParams.dynamicTools[0]).toMatchObject({ type: "function", name: "read_desktop" });
    expect(policy.threadParams.config["features.shell_tool"]).toBe(false);
    const result = JSON.parse(await instance.run(thread, "tool", () => {}));
    expect(result.success).toBe(true);
    expect(result.contentItems[1]).toEqual({ type: "inputImage", imageUrl: "data:image/png;base64,fixture" });
    expect(read).toHaveBeenCalledExactlyOnceWith(true, expect.any(AbortSignal));
    for (const prompt of ["tool_wrong_thread", "tool_bad_args"])
      expect(JSON.parse(await instance.run(thread, prompt, () => {})).success).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    const upgraded = await instance.startThread("legacy-thread", "persona", "RECENT_HISTORY", true);
    const upgradedPolicy = JSON.parse(await instance.run(upgraded, "policy", () => {}));
    expect(upgradedPolicy.threadParams.threadId).toBeUndefined();
    expect(upgradedPolicy.threadParams.dynamicTools[0].name).toBe("read_desktop");
    expect(upgradedPolicy.threadParams.baseInstructions).toContain("RECENT_HISTORY");
  });
  it("aborts an in-flight tool on stop and never returns late screenshot pixels", async () => {
    let finish!: (value: { context: string; imageUrl: string; signal: AbortSignal }) => void;
    const read = vi.fn(
      (_screenshot: boolean, _signal: AbortSignal) =>
        new Promise<{ context: string; imageUrl: string; signal: AbortSignal }>((resolve) => {
          finish = resolve;
        }),
    );
    const instance = new CodexAppServer(
      async () => "decline",
      process.cwd(),
      process.execPath,
      [join(process.cwd(), "tests/fixtures/fake-codex.mjs")],
      { restricted: true, tools: [desktopTool(read)] },
    );
    clients.push(instance);
    await instance.start();
    const thread = await instance.startThread();
    const running = instance.run(thread, "tool", () => {});
    const rejected = expect(running).rejects.toThrow("停止");
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await instance.interrupt();
    await rejected;
    expect(read.mock.calls[0]?.[1].aborted).toBe(true);
    finish({ context: "stale", imageUrl: "data:image/png;base64,secret", signal: new AbortController().signal });
    // The next request is queued after the tool completion microtasks, in the same stdio stream.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = JSON.parse(await instance.run(thread, "tool_result", () => {}));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("scopes reply schemas to each turn and preserves image inputs", async () => {
    const instance = await client();
    const thread = await instance.startThread();
    const schema = { type: "object", properties: { segments: { type: "array" } } };
    const policy = JSON.parse(await instance.run(thread, "policy", () => {}, ["data:image/png;base64,test"], schema));
    expect(policy.turnParams.outputSchema).toEqual(schema);
    expect(policy.turnParams.input[1].type).toBe("image");
    const next = JSON.parse(await instance.run(thread, "policy", () => {}));
    expect(next.turnParams.outputSchema).toBeUndefined();
  });
  it.each([
    { model: "gpt-6-sol", reasoningEffort: "medium" as const, observer: false },
    { model: "gpt-6-luna", reasoningEffort: "high" as const, observer: true },
  ])("pins $model on start, resume and every turn", async ({ model, reasoningEffort, observer }) => {
    const instance = new CodexAppServer(
      async () => "decline",
      process.cwd(),
      process.execPath,
      [join(process.cwd(), "tests/fixtures/fake-codex.mjs")],
      { restricted: true, observer, model: { model, reasoningEffort } },
    );
    clients.push(instance);
    await instance.start();
    for (const existing of [null, "saved-thread"]) {
      const thread = await instance.startThread(existing);
      const policy = JSON.parse(await instance.run(thread, "policy", () => undefined));
      expect(policy.threadParams.model).toBe(model);
      expect(policy.threadParams.config.model_reasoning_effort).toBe(reasoningEffort);
      expect(policy.turnParams.model).toBe(model);
      expect(policy.turnParams.effort).toBe(reasoningEffort);
    }
  });
  it("applies character instructions on restricted start/resume without enabling tools", async () => {
    const instance = new CodexAppServer(
      async () => "decline",
      process.cwd(),
      process.execPath,
      [join(process.cwd(), "tests/fixtures/fake-codex.mjs")],
      { restricted: true },
    );
    clients.push(instance);
    await instance.start();
    const first = await instance.startThread(null, "你是角色 A");
    let policy = JSON.parse(await instance.run(first, "policy", () => {}));
    expect(policy.threadParams.baseInstructions).toContain("你是角色 A");
    const second = await instance.startThread("saved-B", "你是角色 B");
    policy = JSON.parse(await instance.run(second, "policy", () => {}));
    expect(policy.threadParams.threadId).toBe("saved-B");
    expect(policy.threadParams.baseInstructions).toContain("你是角色 B");
    expect(policy.threadParams.baseInstructions).not.toContain("你是角色 A");
    expect(policy.threadParams.config["features.shell_tool"]).toBe(false);
  });
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
