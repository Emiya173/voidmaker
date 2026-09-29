import { z } from "zod";
import { inspectArtifact, projectPath } from "../../../packages/adapters/src/artifacts.js";
import { CodexAppServer, type CodexOptions } from "../../../packages/adapters/src/codex.js";
import type { WorkStore } from "../../../packages/adapters/src/work-store.js";
import type { WorkItem } from "../../../packages/contracts/src/work.js";

export type WorkRunner = Pick<CodexAppServer, "start" | "startThread" | "run" | "interrupt" | "close">;
export type RunnerFactory = (
  cwd: string,
  approve: (method: string, params: Record<string, unknown>) => Promise<"accept" | "decline">,
  event: (method: string, params: Record<string, unknown>) => void,
) => WorkRunner;
export const workRunner =
  (options: CodexOptions = {}): RunnerFactory =>
  (cwd, approve, onEvent) =>
    new CodexAppServer(
      approve,
      cwd,
      "codex",
      [
        "app-server",
        "--stdio",
        "--disable",
        "plugins",
        "--disable",
        "hooks",
        "--disable",
        "apps",
        "--disable",
        "multi_agent",
      ],
      { ...options, work: true, onEvent },
    );
const resultSchema = z.object({
  outcome: z.enum(["completed", "blocked"]),
  summary: z.string().max(50_000),
  artifacts: z.array(z.string().max(4096)).max(100),
});
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One worker slot, independent from chat. PostgreSQL is the authority; UI events are invalidations. */
export class WorkManager {
  private active: { work: WorkItem; runner: WorkRunner; cancelled: boolean } | null = null;
  private pumping: Promise<void> | null = null;
  private closed = false;
  private wakeRequested = false;
  private approvals = new Map<string, { resolve: (decision: "accept" | "decline") => void; timer: NodeJS.Timeout }>();
  constructor(
    readonly store: WorkStore,
    private readonly publish: (id: string) => void,
    private readonly report: (message: string) => void,
    private readonly factory: RunnerFactory = workRunner(),
  ) {}
  async start(): Promise<void> {
    await this.store.acquire(() => {
      this.report("后台任务数据库连接已中断，请重启 Host 后检查任务状态");
      void this.close().catch((e: unknown) => this.report(messageOf(e)));
    });
    await this.store.recover();
  }
  async enqueue(id: string, revision: number, retry: boolean): Promise<void> {
    if (this.closed) throw new Error("后台任务调度器已停止，请重启 Host");
    await this.store.enqueue(id, revision, retry);
    this.publish(id);
    this.wake();
  }
  wake(): void {
    if (this.closed) return;
    if (this.pumping) {
      this.wakeRequested = true;
      return;
    }
    this.wakeRequested = false;
    this.pumping = this.pump()
      .catch((error: unknown) => this.report(messageOf(error)))
      .finally(() => {
        this.pumping = null;
        if (this.wakeRequested) this.wake();
      });
  }
  private async pump(): Promise<void> {
    while (!this.closed) {
      const work = await this.store.claim();
      if (!work) return;
      await this.execute(work);
    }
  }
  async cancel(id: string): Promise<void> {
    await this.store.cancel(id);
    const active = this.active;
    if (active?.work.id === id) {
      active.cancelled = true;
      this.declineAll();
      // Closing also handles cancellation during initialization, before a turn exists.
      await active.runner.close();
    }
    this.publish(id);
  }
  async decide(id: string, decision: "accept" | "decline" | "expired"): Promise<void> {
    try {
      const committed = await this.store.decide(id, decision);
      const pending = this.approvals.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.approvals.delete(id);
        pending.resolve(committed?.decision ?? "decline");
      }
      if (committed) this.publish(committed.workId);
    } catch (error) {
      // Never send acceptance before its database commit. Stop on persistence failure.
      this.declineAll();
      await this.active?.runner.close();
      throw error;
    }
  }
  private declineAll(): void {
    for (const pending of this.approvals.values()) {
      clearTimeout(pending.timer);
      pending.resolve("decline");
    }
    this.approvals.clear();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.declineAll();
    await this.active?.runner.close();
    await this.pumping;
    // Active/queued states remain recoverable. close is not user cancellation.
  }
  private async execute(work: WorkItem): Promise<void> {
    const attemptId = work.attemptId;
    if (!attemptId) throw new Error("缺少执行 ID");
    let events = Promise.resolve();
    let eventError: unknown;
    const paths = new Set<string>();
    let runner: WorkRunner | undefined;
    const queueEvent = (method: string, params: Record<string, unknown>) => {
      if (!["turn/started", "item/started", "item/completed", "turn/plan/updated"].includes(method)) return;
      events = events
        .then(async () => {
          if (eventError || this.closed) return;
          const item = params.item as Record<string, unknown> | undefined;
          let text = "";
          if (method === "turn/started") {
            if (typeof params.turnId === "string")
              await this.store.record(work.id, attemptId, method, params.turnId, { turnId: params.turnId });
          } else if (item?.type === "commandExecution") {
            text = `${String(item.command)}\n${String(item.status)} · exit=${String(item.exitCode ?? "—")}\n${String(item.aggregatedOutput ?? "").slice(-6000)}`;
          } else if (method === "item/completed" && item?.type === "agentMessage" && item.phase === "commentary") {
            text = String(item.text ?? "");
          } else if (method === "item/completed" && item?.type === "fileChange") {
            const changes = z.array(z.object({ path: z.string() })).safeParse(item.changes);
            if (changes.success) for (const change of changes.data) if (paths.size < 100) paths.add(change.path);
            text = `文件修改: ${String(item.status)}\n${changes.success ? changes.data.map((c) => c.path).join("\n") : "未知文件"}`;
          } else if (method === "turn/plan/updated") text = JSON.stringify(params.plan ?? []);
          if (text) await this.store.record(work.id, attemptId, method, text);
          this.publish(work.id);
        })
        .catch((error: unknown) => {
          eventError = error;
          void runner?.close();
        });
    };
    let result = "";
    let failure = "";
    try {
      const project = await this.store.project(work.projectId);
      if ((await projectPath(project.path)) !== project.path) throw new Error("项目路径已被替换");
      runner = this.factory(
        project.path,
        async (method, params) => {
          await events;
          if (eventError || this.closed || this.active?.cancelled) return "decline";
          const description = `${method}\n${JSON.stringify(params, null, 2)}`;
          if (Buffer.byteLength(description) > 16_000) return "decline";
          const approval = await this.store
            .requestApproval(work.id, attemptId, description)
            .catch(async (error: unknown) => {
              eventError = error;
              await runner?.close();
              throw error;
            });
          if (!approval || this.closed || this.active?.cancelled) return "decline";
          return new Promise<"accept" | "decline">((resolve) => {
            const timer = setTimeout(
              () => {
                void this.decide(approval.id, "expired").catch((e: unknown) => this.report(messageOf(e)));
              },
              Math.max(0, Date.parse(approval.expiresAt) - Date.now()),
            );
            this.approvals.set(approval.id, { resolve, timer });
            this.publish(work.id);
          });
        },
        queueEvent,
      );
      const active = { work, runner, cancelled: false };
      this.active = active;
      this.publish(work.id);
      // Cancellation can win the race while the project was being resolved.
      if (this.closed || (await this.store.detail(work.id)).work.status === "cancelling") {
        active.cancelled = true;
        return;
      }
      await runner.start();
      if (this.closed || active.cancelled) return;
      const threadId = await runner.startThread();
      if (
        !(await this.store.record(work.id, attemptId, "thread", threadId, { threadId })) ||
        this.closed ||
        active.cancelled
      )
        return;
      const raw = await runner.run(threadId, work.prompt, () => undefined);
      await events;
      if (eventError) throw eventError;
      if (this.closed || active.cancelled) return;
      const parsed = resultSchema.safeParse(parseJson(raw));
      if (!parsed.success) throw new Error("Codex 工作结果不符合约定格式");
      result = parsed.data.summary;
      if (parsed.data.outcome === "blocked") failure = parsed.data.summary || "任务未完成";
      for (const path of parsed.data.artifacts) paths.add(path);
      for (const path of [...paths].slice(0, 100)) {
        try {
          const verified = await inspectArtifact(project.path, path);
          await this.store.artifact(work.id, attemptId, verified.artifact);
        } catch (error) {
          await this.store.record(work.id, attemptId, "artifact_unavailable", `${path}: ${messageOf(error)}`);
          if (parsed.data.artifacts.includes(path)) failure ||= `产物未通过校验: ${path}`;
        }
      }
    } catch (error) {
      failure = messageOf(eventError ?? error);
    } finally {
      this.declineAll();
      await runner?.close();
      await events;
      if (!this.closed) await this.store.finish(work.id, attemptId, result, failure);
      this.active = null;
      this.publish(work.id);
    }
  }
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
