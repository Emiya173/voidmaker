import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../apps/host/src/migrate.js";
import { type RunnerFactory, WorkManager } from "../apps/host/src/work.js";
import { inspectArtifact } from "../packages/adapters/src/artifacts.js";
import { WorkStore } from "../packages/adapters/src/work-store.js";
import { transitionWork } from "../packages/domain/src/work.js";

it("rejects stale or unsafe work transitions", () => {
  expect(transitionWork("draft", "submit")).toBe("queued");
  expect(transitionWork("awaiting_permission", "cancel")).toBe("cancelling");
  expect(transitionWork("cancelling", "stop")).toBe("cancelled");
  expect(() => transitionWork("cancelled", "complete")).toThrow();
  expect(() => transitionWork("interrupted", "start")).toThrow();
  expect(transitionWork("interrupted", "retry")).toBe("queued");
});

it("verifies actual files and rejects directory traversal and symlink escape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voidmaker-artifact-"));
  try {
    const project = join(dir, "project");
    await mkdir(project);
    await writeFile(join(project, "output.txt"), "hello");
    await writeFile(join(dir, "outside.txt"), "outside");
    await symlink(join(dir, "outside.txt"), join(project, "escape.txt"));
    const verified = await inspectArtifact(project, "output.txt");
    expect(verified.preview).toBe("hello");
    expect(verified.artifact.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    await expect(inspectArtifact(project, "../outside.txt")).rejects.toThrow("超出");
    await expect(inspectArtifact(project, "escape.txt")).rejects.toThrow("超出");
    await expect(inspectArtifact(project, "missing.txt")).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true });
  }
});

const connectionString = process.env.VOIDMAKER_TEST_DATABASE_URL;
describe.skipIf(!connectionString)("durable work", () => {
  const store = new WorkStore(connectionString);
  const pool = new pg.Pool({ connectionString });
  const ids: string[] = [];
  let dir: string;
  let projectId: string;
  beforeAll(async () => {
    await migrate(connectionString);
    dir = await mkdtemp(join(tmpdir(), "voidmaker-work-"));
    projectId = (await store.addProject("test", dir)).id;
  });
  afterAll(async () => {
    await pool.query("DELETE FROM work_items WHERE id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM projects WHERE id=$1", [projectId]);
    await store.close();
    await pool.end();
    await rm(dir, { recursive: true });
  });
  async function draft(prompt = "task") {
    const id = randomUUID();
    ids.push(id);
    await store.draft(id, projectId, prompt);
    return id;
  }
  async function running() {
    const id = await draft();
    await store.enqueue(id, 0, false);
    const work = await store.claim();
    expect(work?.id).toBe(id);
    if (!work?.attemptId) throw new Error("missing attempt");
    return { id, attempt: work.attemptId };
  }
  it("deduplicates drafts, serializes submit, and preserves attempts after retry", async () => {
    const id = await draft();
    await store.draft(id, projectId, "task");
    const submitted = await Promise.allSettled([store.enqueue(id, 0, false), store.enqueue(id, 0, false)]);
    expect(submitted.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const first = await store.claim();
    if (!first?.attemptId) throw new Error("missing attempt");
    await store.cancel(id);
    await store.finish(id, first.attemptId, "late completion", "");
    expect((await store.detail(id)).work.status).toBe("cancelled");
    await store.enqueue(id, (await store.detail(id)).work.revision, true);
    const second = await store.claim();
    if (!second?.attemptId) throw new Error("missing retry");
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(await store.record(id, first.attemptId, "late", "ignored")).toBe(false);
    await store.finish(id, first.attemptId, "stale", "");
    expect((await store.detail(id)).work.status).toBe("running");
    await store.finish(id, second.attemptId, "done", "");
    const detail = await store.detail(id);
    expect(detail.attempts.map((a) => a.status)).toEqual(["cancelled", "completed"]);
    expect(detail.attempts[1]?.result).toBe("done");
  });
  it("expires approvals on recovery and never replays queued or active tasks", async () => {
    const { id, attempt } = await running();
    const approval = await store.requestApproval(id, attempt, "write file");
    expect((await store.detail(id)).work.status).toBe("awaiting_permission");
    const queued = await draft();
    await store.enqueue(queued, 0, false);
    await store.recover();
    expect((await store.detail(id)).work.status).toBe("interrupted");
    expect((await store.detail(queued)).work.status).toBe("interrupted");
    expect((await store.detail(id)).approvals[0]?.decision).toBe("expired");
    expect(await store.decide(approval?.id ?? "", "accept")).toBeNull();
    expect(await store.claim()).toBeNull();
  });
  it("resolves multiple permissions only after all decisions and rejects late acceptance", async () => {
    const { id, attempt } = await running();
    const a = await store.requestApproval(id, attempt, "first");
    const b = await store.requestApproval(id, attempt, "second");
    if (!a || !b) throw new Error("missing approval");
    expect((await store.decide(a.id, "accept"))?.decision).toBe("accept");
    expect((await store.detail(id)).work.status).toBe("awaiting_permission");
    await pool.query("UPDATE work_approvals SET expires_at=now()-interval '1 second' WHERE id=$1", [b.id]);
    expect((await store.decide(b.id, "accept"))?.decision).toBe("decline");
    expect((await store.detail(id)).work.status).toBe("running");
    await store.finish(id, attempt, "", "rejected");
  });
  it("runs an independent worker, persists progress and verifies its reported artifacts", async () => {
    const errors: string[] = [];
    let sawCommittedApproval = false;
    let manager: WorkManager;
    const factory: RunnerFactory = (_cwd, approve, event) => ({
      start: async () => {},
      startThread: async () => "isolated-thread",
      interrupt: async () => {},
      close: async () => {},
      run: async () => {
        event("turn/started", { turnId: "turn-1" });
        const decision = await approve("item/commandExecution/requestApproval", { command: "write output.txt" });
        expect(decision).toBe("accept");
        await writeFile(join(dir, "result.txt"), "work result");
        event("item/completed", {
          item: {
            type: "commandExecution",
            command: "write result.txt",
            status: "completed",
            exitCode: 0,
            aggregatedOutput: "ok",
          },
        });
        event("item/completed", {
          item: { type: "fileChange", status: "completed", changes: [{ path: "deleted.txt" }] },
        });
        return JSON.stringify({ outcome: "completed", summary: "完成", artifacts: ["result.txt"] });
      },
    });
    const managedStore = new WorkStore(connectionString);
    manager = new WorkManager(
      managedStore,
      (id) => {
        void store.detail(id).then((detail) => {
          const pending = detail.approvals.find((a) => a.decision === null);
          if (pending) {
            sawCommittedApproval = true;
            void manager.decide(pending.id, "accept");
          }
        });
      },
      (error) => errors.push(error),
      factory,
    );
    await manager.start();
    const id = await draft();
    try {
      await store.enqueue(id, 0, false);
      manager.wake();
      await expect.poll(async () => (await store.detail(id)).work.status).toBe("completed");
      const detail = await store.detail(id);
      expect(sawCommittedApproval).toBe(true);
      expect(detail.attempts[0]?.threadId).toBe("isolated-thread");
      expect(detail.attempts[0]?.turnId).toBe("turn-1");
      expect(detail.artifacts.map((a) => a.path)).toEqual(["result.txt"]);
      expect(detail.events.some((e) => e.kind === "artifact_unavailable")).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await manager.close();
      await managedStore.close();
    }
  });
  it.each([
    JSON.stringify({ outcome: "blocked", summary: "权限被拒，未完成", artifacts: [] }),
    JSON.stringify({ outcome: "completed", summary: "完成", artifacts: ["missing.txt"] }),
    "invalid final result",
  ])("does not mark blocked or unverifiable results as completed (%s)", async (output) => {
    const managedStore = new WorkStore(connectionString);
    const factory: RunnerFactory = () => ({
      start: async () => {},
      startThread: async () => "thread-result",
      interrupt: async () => {},
      close: async () => {},
      run: async () => output,
    });
    const manager = new WorkManager(
      managedStore,
      () => {},
      () => {},
      factory,
    );
    try {
      await manager.start();
      const id = await draft();
      await manager.enqueue(id, 0, false);
      await expect.poll(async () => (await store.detail(id)).work.status).toBe("failed");
      expect((await store.detail(id)).attempts[0]?.error).not.toBe("");
    } finally {
      await manager.close();
      await managedStore.close();
    }
  });
  it("cancels a waiting worker and ignores its late completion", async () => {
    let finish!: (value: string) => void;
    const factory: RunnerFactory = () => ({
      start: async () => {},
      startThread: async () => "thread-cancel",
      interrupt: async () => {},
      close: async () => {
        finish?.("late success");
      },
      run: async () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });
    const managedStore = new WorkStore(connectionString);
    const errors: string[] = [];
    const manager = new WorkManager(
      managedStore,
      () => {},
      (error) => errors.push(error),
      factory,
    );
    await manager.start();
    const id = await draft();
    try {
      await store.enqueue(id, 0, false);
      manager.wake();
      await expect.poll(() => !!finish).toBe(true);
      await manager.cancel(id);
      await expect.poll(async () => (await store.detail(id)).work.status).toBe("cancelled");
      expect((await store.detail(id)).attempts[0]?.result).toBe("");
      expect(errors).toEqual([]);
    } finally {
      await manager.close();
      await managedStore.close();
    }
  });
});
