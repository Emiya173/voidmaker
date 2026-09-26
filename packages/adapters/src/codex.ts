import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

type RpcResponse = { id: number; result?: Record<string, unknown>; error?: { message?: string } };
type RpcNotification = { method: string; params?: Record<string, unknown>; id?: number | string };
type Approval = (method: string, params: Record<string, unknown>) => Promise<"accept" | "acceptForSession" | "decline">;
export type CodexOptions = Readonly<{
  work?: boolean;
  onEvent?: (method: string, params: Record<string, unknown>) => void;
}>;

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
    private readonly options: CodexOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.process) return;
    const child = spawn(this.executable, this.args, {
      cwd: this.cwd,
      stdio: "pipe",
      detached: Boolean(this.options.work),
    });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000);
    });
    child.on("error", (error) => {
      if (this.process === child) this.failAll(error);
    });
    child.on("exit", (code) => {
      this.kill(child, "SIGKILL");
      if (this.process === child) this.failAll(new Error(`Codex App Server 退出 (${code}): ${this.stderr}`));
    });
    child.on("close", () => {
      if (this.process === child) this.process = null;
    });
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
      const timer = setTimeout(() => this.kill(child, "SIGKILL"), 2000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.kill(child, "SIGTERM");
    });
  }

  async startThread(existingThreadId?: string | null): Promise<string> {
    if (this.options.work) return this.startWorkThread();
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

  private async startWorkThread(): Promise<string> {
    const effective = object((await this.request("config/read", { includeLayers: false, cwd: this.cwd })).config);
    const disabled = (value: unknown) =>
      Object.fromEntries(Object.keys(object(value)).map((key) => [key, { enabled: false }]));
    const result = await this.request("thread/start", {
      cwd: this.cwd,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      serviceName: "voidmaker-work",
      config: {
        mcp_servers: disabled(effective.mcp_servers),
        apps: { ...disabled(effective.apps), _default: { enabled: false } },
        "features.apps": false,
        "features.multi_agent": false,
        web_search: "disabled",
        "sandbox_workspace_write.network_access": false,
        "sandbox_workspace_write.writable_roots": [],
        "sandbox_workspace_write.exclude_tmpdir_env_var": true,
        "sandbox_workspace_write.exclude_slash_tmp": true,
      },
      developerInstructions:
        "在所选项目内完成用户确认的任务。使用中文。不要提交、推送或发布，除非任务明确要求。取消后不自动回滚。最后返回 JSON：outcome 为 completed 或 blocked（未完成、权限被拒或条件不足时），summary 为结果总结，artifacts 为可供用户查看的项目相对文件路径数组；不要虚构产物。优先使用 shell 或 Node.js 执行操作。",
    });
    const id = object(result.thread).id;
    if (typeof id !== "string") throw new Error("Codex 未返回工作 thread id");
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
      const started = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        ...(this.options.work
          ? {
              sandboxPolicy: {
                type: "workspaceWrite",
                writableRoots: [this.cwd],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              },
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              outputSchema: {
                type: "object",
                properties: {
                  outcome: { type: "string", enum: ["completed", "blocked"] },
                  summary: { type: "string" },
                  artifacts: { type: "array", items: { type: "string" } },
                },
                required: ["outcome", "summary", "artifacts"],
                additionalProperties: false,
              },
            }
          : {}),
      });
      const id = object(started.turn).id;
      if (typeof id !== "string") throw new Error("Codex 未返回 turn id");
      active.id = id;
      this.options.onEvent?.("turn/started", { threadId, turnId: id });
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
      const params = object(message.params);
      if (
        this.options.work &&
        (!this.active ||
          this.active.cancelled ||
          params.threadId !== this.active.threadId ||
          (this.active.id && params.turnId !== this.active.id))
      ) {
        this.write({ id: message.id, result: { decision: "decline" } });
        return;
      }
      const decision = await this.approve(method, params).catch(() => "decline" as const);
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
    if (!active.cancelled) this.options.onEvent?.(message.method, params);
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
      else if (turn.status === "completed") active.resolve(active.finalText || active.draft);
      else active.reject(new Error(`未知 Codex 轮次状态: ${String(turn.status)}`));
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
    if (this.process) this.kill(this.process, "SIGTERM");
  }

  private kill(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (this.options.work && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else child.kill(signal);
  }
}
