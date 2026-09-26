import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

type RpcResponse = { id: number; result?: Record<string, unknown>; error?: { message?: string } };
type RpcNotification = { method: string; params?: Record<string, unknown>; id?: number | string };
type Approval = (method: string, params: Record<string, unknown>) => Promise<"accept" | "acceptForSession" | "decline">;

type ActiveTurn = {
  id: string | null;
  threadId: string;
  cancelled: boolean;
  finalItemIds: Set<string>;
  draft: string;
  finalText: string;
  onDelta: (text: string) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export class CodexAppServer {
  private process: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private active: ActiveTurn | null = null;
  private stderr = "";

  constructor(
    private readonly approve: Approval,
    private readonly cwd: string,
    private readonly executable = "codex",
    private readonly args = ["app-server", "--stdio"],
  ) {}

  async start(): Promise<void> {
    if (this.process) return;
    const child = spawn(this.executable, this.args, { cwd: this.cwd, stdio: "pipe" });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code) => this.failAll(new Error(`Codex App Server 退出 (${code}): ${this.stderr}`)));
    await this.request("initialize", {
      clientInfo: { name: "voidmaker", title: "VoidMaker", version: "0.3.0" },
      capabilities: { experimentalApi: false },
    });
    this.write({ method: "initialized", params: {} });
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  async startThread(existingThreadId?: string | null): Promise<string> {
    if (existingThreadId) {
      try {
        const resumed = await this.request("thread/resume", {
          threadId: existingThreadId,
          cwd: this.cwd,
          sandbox: "read-only",
          approvalPolicy: "on-request",
        });
        const id = object(resumed.thread).id;
        if (typeof id === "string") return id;
      } catch {
        // Codex's local thread history may have been removed; create a fresh thread.
      }
    }
    const started = await this.request("thread/start", {
      cwd: this.cwd,
      sandbox: "read-only",
      approvalPolicy: "on-request",
      serviceName: "voidmaker",
      baseInstructions: "你是用户的桌面语音助手。用自然、简洁的中文回答。除非用户明确要求，否则不要执行命令。",
    });
    const id = object(started.thread).id;
    if (typeof id !== "string") throw new Error("Codex 未返回 thread id");
    return id;
  }

  async run(threadId: string, text: string, onDelta: (text: string) => void): Promise<string> {
    if (this.active) throw new Error("已有进行中的 Codex 轮次");
    let resolve!: (text: string) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<string>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    // A process can fail before turn/start returns; keep that rejection handled until we await it.
    void completed.catch(() => undefined);
    const active: ActiveTurn = {
      id: null,
      threadId,
      cancelled: false,
      finalItemIds: new Set(),
      draft: "",
      finalText: "",
      onDelta,
      resolve,
      reject,
    };
    this.active = active;
    try {
      const started = await this.request("turn/start", { threadId, input: [{ type: "text", text }] });
      const id = object(started.turn).id;
      if (typeof id !== "string") throw new Error("Codex 未返回 turn id");
      active.id = id;
      if (active.cancelled) await this.request("turn/interrupt", { threadId, turnId: id });
      return await completed;
    } finally {
      if (this.active === active) this.active = null;
    }
  }

  async interrupt(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.cancelled = true;
    if (active.id) await this.request("turn/interrupt", { threadId: active.threadId, turnId: active.id });
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.requestId;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 请求超时`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return result;
  }

  private write(message: Record<string, unknown>): void {
    if (!this.process?.stdin.writable) throw new Error("Codex App Server 未连接");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: RpcResponse | RpcNotification;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object") return;
      message = parsed as RpcResponse | RpcNotification;
    } catch {
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      if ("error" in message && message.error) pending.reject(new Error(message.error.message ?? "Codex 请求失败"));
      else pending.resolve(object(message.result));
      return;
    }
    if ("method" in message) {
      if (typeof message.id === "number" || typeof message.id === "string") {
        void this.handleApproval(message).catch((error: unknown) => {
          this.failAll(error instanceof Error ? error : new Error(String(error)));
        });
      } else this.handleNotification(message);
    }
  }

  private async handleApproval(message: RpcNotification): Promise<void> {
    const method = message.method;
    if (typeof message.id !== "number" && typeof message.id !== "string") return;
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const decision = await this.approve(method, object(message.params)).catch(() => "decline" as const);
      this.write({ id: message.id, result: { decision } });
    } else if (method === "item/tool/requestUserInput") {
      this.write({ id: message.id, result: { answers: {} } });
    } else {
      this.write({ id: message.id, error: { code: -32601, message: `Unsupported: ${method}` } });
    }
  }

  private handleNotification(message: RpcNotification): void {
    const active = this.active;
    if (!active) return;
    const params = object(message.params);
    if (params.threadId !== active.threadId) return;
    const turnId = params.turnId ?? object(params.turn).id;
    if (active.id && turnId && turnId !== active.id) return;
    const item = object(params.item);
    if (message.method === "item/started" && item.type === "agentMessage" && item.phase !== "commentary") {
      if (typeof item.id === "string") active.finalItemIds.add(item.id);
    } else if (message.method === "item/agentMessage/delta") {
      if (!active.cancelled && typeof params.itemId === "string" && active.finalItemIds.has(params.itemId)) {
        const delta = String(params.delta ?? "");
        active.draft += delta;
        active.onDelta(delta);
      }
    } else if (message.method === "item/completed" && item.type === "agentMessage" && item.phase !== "commentary") {
      active.finalText = String(item.text ?? "");
    } else if (message.method === "turn/completed") {
      const turn = object(params.turn);
      if (turn.status === "failed") active.reject(new Error(String(object(turn.error).message ?? "Codex 轮次失败")));
      else if (turn.status === "interrupted" || active.cancelled) active.reject(new Error("轮次已停止"));
      else active.resolve(active.finalText || active.draft);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.active?.reject(error);
    this.active = null;
    // A protocol failure can occur while the child is still alive.
    this.process?.kill("SIGTERM");
    this.process = null;
  }
}
