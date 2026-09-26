import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  Artifact,
  Attempt,
  Project,
  WorkApproval,
  WorkDetail,
  WorkEvent,
  WorkItem,
} from "../../contracts/src/work.js";
import { isActiveWork, transitionWork, type WorkAction } from "../../domain/src/work.js";

const workColumns = `id, project_id AS "projectId", prompt, status, attempt_id AS "attemptId", revision, created_at::text AS "createdAt"`;
const approvalColumns = `id, attempt_id AS "attemptId", description, decision, expires_at::text AS "expiresAt"`;
const artifactColumns = `id, attempt_id AS "attemptId", path, sha256, size::float8 AS size, kind`;

/** SQL stays at this boundary; each state change and its audit event commit together. */
export class WorkStore {
  private readonly pool: pg.Pool;
  private leader: pg.PoolClient | null = null;
  constructor(connectionString?: string) {
    this.pool = new pg.Pool(connectionString ? { connectionString } : undefined);
  }
  async acquire(onLost: () => void): Promise<void> {
    const client = await this.pool.connect();
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(91244014) AS locked");
    if (!result.rows[0]?.locked) {
      client.release();
      throw new Error("已有后台任务调度器连接此数据库");
    }
    this.leader = client;
    client.on("error", onLost);
  }
  async close(): Promise<void> {
    this.leader?.release(true);
    this.leader = null;
    await this.pool.end();
  }
  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private async locked(client: pg.PoolClient, id: string): Promise<WorkItem> {
    const result = await client.query<WorkItem>(`SELECT ${workColumns} FROM work_items WHERE id=$1 FOR UPDATE`, [id]);
    if (!result.rows[0]) throw new Error("任务不存在");
    return result.rows[0];
  }
  private async event(client: pg.PoolClient, work: WorkItem, kind: string, text: string): Promise<void> {
    await client.query("INSERT INTO work_events(work_id,attempt_id,kind,text) VALUES($1,$2,$3,$4)", [
      work.id,
      work.attemptId,
      kind,
      text.slice(0, 8000),
    ]);
  }
  private async move(client: pg.PoolClient, work: WorkItem, action: WorkAction, text: string = action): Promise<void> {
    const status = transitionWork(work.status, action);
    await client.query("UPDATE work_items SET status=$2, revision=revision+1, updated_at=now() WHERE id=$1", [
      work.id,
      status,
    ]);
    if (work.attemptId && action !== "retry") {
      await client.query(
        `UPDATE work_attempts SET status=$2, finished_at=CASE WHEN $3 THEN now() ELSE finished_at END WHERE id=$1`,
        [work.attemptId, status, !isActiveWork(status)],
      );
    }
    await this.event(client, work, action, text);
  }
  async recover(): Promise<void> {
    await this.transaction(async (client) => {
      const rows = await client.query<WorkItem>(
        `SELECT ${workColumns} FROM work_items WHERE status IN ('queued','running','awaiting_permission','cancelling') FOR UPDATE`,
      );
      for (const work of rows.rows) {
        await this.move(client, work, "recover", "Host 重启，执行中断；请检查文件后手动重试。排队任务也不会自动重放。");
      }
      await client.query("UPDATE work_approvals SET decision='expired', decided_at=now() WHERE decision IS NULL");
    });
  }
  async addProject(name: string, path: string): Promise<Project> {
    const result = await this.pool.query<Project>(
      `INSERT INTO projects(id,name,path) VALUES($1,$2,$3)
      ON CONFLICT(path) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,path`,
      [randomUUID(), name, path],
    );
    return result.rows[0] as Project;
  }
  async project(id: string): Promise<Project> {
    const result = await this.pool.query<Project>("SELECT id,name,path FROM projects WHERE id=$1", [id]);
    if (!result.rows[0]) throw new Error("项目不存在");
    return result.rows[0];
  }
  async list(): Promise<{ projects: Project[]; works: WorkItem[] }> {
    const [projects, works] = await Promise.all([
      this.pool.query<Project>("SELECT id,name,path FROM projects ORDER BY created_at"),
      this.pool.query<WorkItem>(`SELECT ${workColumns} FROM work_items ORDER BY updated_at DESC, id LIMIT 100`),
    ]);
    return { projects: projects.rows, works: works.rows };
  }
  async detail(id: string): Promise<WorkDetail> {
    return this.transaction(async (client) => {
      // Row lock makes this a consistent task snapshot while writers use the same lock.
      const work = await this.locked(client, id);
      const attempts = await client.query<Attempt>(
        `SELECT id,status,thread_id AS "threadId",turn_id AS "turnId",result,error,
        started_at::text AS "startedAt",finished_at::text AS "finishedAt" FROM work_attempts WHERE work_id=$1 ORDER BY started_at`,
        [id],
      );
      const events = await client.query<WorkEvent>(
        `SELECT id::text,attempt_id AS "attemptId",kind,text,created_at::text AS "createdAt"
        FROM work_events WHERE work_id=$1 ORDER BY id DESC LIMIT 100`,
        [id],
      );
      const approvals = await client.query<WorkApproval>(
        `SELECT ${approvalColumns} FROM work_approvals WHERE work_id=$1 ORDER BY expires_at`,
        [id],
      );
      const artifacts = await client.query<Artifact>(
        `SELECT ${artifactColumns} FROM work_artifacts WHERE work_id=$1 ORDER BY path`,
        [id],
      );
      return {
        work,
        attempts: attempts.rows,
        events: events.rows.reverse(),
        approvals: approvals.rows,
        artifacts: artifacts.rows,
      };
    });
  }
  async draft(id: string, projectId: string, prompt: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "INSERT INTO work_items(id,project_id,prompt,status) VALUES($1,$2,$3,'draft') ON CONFLICT(id) DO NOTHING",
        [id, projectId, prompt],
      );
      const work = await this.locked(client, id);
      if (work.projectId !== projectId || work.prompt !== prompt) throw new Error("草稿 ID 已被其他内容使用");
    });
  }
  async edit(id: string, revision: number, prompt: string): Promise<void> {
    await this.transaction(async (client) => {
      const work = await this.locked(client, id);
      if (work.status !== "draft" || work.revision !== revision) throw new Error("草稿已变更，请刷新后重试");
      await client.query("UPDATE work_items SET prompt=$2,revision=revision+1,updated_at=now() WHERE id=$1", [
        id,
        prompt,
      ]);
    });
  }
  async enqueue(id: string, revision: number, retry: boolean): Promise<void> {
    await this.transaction(async (client) => {
      const work = await this.locked(client, id);
      if (work.revision !== revision) throw new Error("任务已变更，请刷新后重试");
      await this.move(client, work, retry ? "retry" : "submit");
      // The previous attempt is immutable, even when a retry is cancelled before it starts.
      await client.query("UPDATE work_items SET attempt_id=NULL WHERE id=$1", [id]);
    });
  }
  async claim(): Promise<WorkItem | null> {
    return this.transaction(async (client) => {
      const rows = await client.query<WorkItem>(
        `SELECT ${workColumns} FROM work_items WHERE status='queued' ORDER BY updated_at,id LIMIT 1 FOR UPDATE`,
      );
      const work = rows.rows[0];
      if (!work) return null;
      const attemptId = randomUUID();
      await client.query("INSERT INTO work_attempts(id,work_id,status) VALUES($1,$2,'running')", [attemptId, work.id]);
      await client.query("UPDATE work_items SET attempt_id=$2 WHERE id=$1", [work.id, attemptId]);
      await this.move(client, { ...work, attemptId }, "start");
      return { ...work, attemptId, status: "running", revision: work.revision + 1 };
    });
  }
  async cancel(id: string): Promise<void> {
    await this.transaction(async (client) => {
      const work = await this.locked(client, id);
      if (!["draft", "queued", "running", "awaiting_permission"].includes(work.status)) return;
      await this.move(client, work, "cancel", "请求取消；已经完成的文件修改不会回滚。");
      await client.query(
        "UPDATE work_approvals SET decision='expired',decided_at=now() WHERE work_id=$1 AND decision IS NULL",
        [id],
      );
    });
  }
  async record(
    id: string,
    attemptId: string,
    kind: string,
    text: string,
    ids?: { threadId?: string; turnId?: string },
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const work = await this.locked(client, id);
      if (work.attemptId !== attemptId || !isActiveWork(work.status) || work.status === "cancelling") return false;
      await this.event(client, work, kind, text);
      if (ids)
        await client.query(
          "UPDATE work_attempts SET thread_id=COALESCE($2,thread_id),turn_id=COALESCE($3,turn_id) WHERE id=$1",
          [attemptId, ids.threadId, ids.turnId],
        );
      return true;
    });
  }
  async finish(id: string, attemptId: string, result: string, error: string): Promise<void> {
    await this.transaction(async (client) => {
      const work = await this.locked(client, id);
      if (work.attemptId !== attemptId || !isActiveWork(work.status)) return;
      await this.move(client, work, work.status === "cancelling" ? "stop" : error ? "fail" : "complete");
      await client.query("UPDATE work_attempts SET result=$2,error=$3 WHERE id=$1", [
        attemptId,
        result.slice(0, 50000),
        error.slice(0, 8000),
      ]);
      await client.query(
        "UPDATE work_approvals SET decision='expired',decided_at=now() WHERE work_id=$1 AND decision IS NULL",
        [id],
      );
    });
  }
  async requestApproval(id: string, attemptId: string, description: string): Promise<WorkApproval | null> {
    return this.transaction(async (client) => {
      const work = await this.locked(client, id);
      if (work.attemptId !== attemptId || !["running", "awaiting_permission"].includes(work.status)) return null;
      if (work.status === "running") await this.move(client, work, "request_permission");
      const result = await client.query<WorkApproval>(
        `INSERT INTO work_approvals(id,work_id,attempt_id,description,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '2 minutes') RETURNING ${approvalColumns}`,
        [randomUUID(), id, attemptId, description],
      );
      return result.rows[0] ?? null;
    });
  }
  async decide(
    id: string,
    decision: "accept" | "decline" | "expired",
  ): Promise<{ workId: string; decision: "accept" | "decline" } | null> {
    return this.transaction(async (client) => {
      const row = (await client.query<{ work_id: string }>("SELECT work_id FROM work_approvals WHERE id=$1", [id]))
        .rows[0];
      if (!row) return null;
      const work = await this.locked(client, row.work_id);
      const updated = await client.query<{ decision: string }>(
        `UPDATE work_approvals SET decision=CASE WHEN expires_at<=now() THEN 'expired' ELSE $2 END,decided_at=now()
        WHERE id=$1 AND decision IS NULL AND attempt_id=$3 RETURNING decision`,
        [id, decision, work.attemptId],
      );
      if (!updated.rows[0]) return null;
      const pending = await client.query("SELECT id FROM work_approvals WHERE work_id=$1 AND decision IS NULL", [
        work.id,
      ]);
      if (work.status === "awaiting_permission" && pending.rowCount === 0) await this.move(client, work, "decide");
      await this.event(client, work, "approval", `${id}: ${updated.rows[0].decision}`);
      return {
        workId: work.id,
        decision: work.status === "awaiting_permission" && updated.rows[0].decision === "accept" ? "accept" : "decline",
      };
    });
  }
  async artifact(id: string, attemptId: string, artifact: Omit<Artifact, "id" | "attemptId">): Promise<void> {
    await this.transaction(async (client) => {
      const work = await this.locked(client, id);
      if (work.attemptId !== attemptId || !isActiveWork(work.status) || work.status === "cancelling") return;
      await client.query(
        `INSERT INTO work_artifacts(id,work_id,attempt_id,path,sha256,size,kind) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(attempt_id,path) DO UPDATE SET sha256=EXCLUDED.sha256,size=EXCLUDED.size,kind=EXCLUDED.kind`,
        [randomUUID(), id, attemptId, artifact.path, artifact.sha256, artifact.size, artifact.kind],
      );
    });
  }
  async findArtifact(id: string): Promise<{ artifact: Artifact; project: Project }> {
    const row = (
      await this.pool.query<Artifact & { projectId: string }>(
        `SELECT a.id,a.attempt_id AS "attemptId",a.path,a.sha256,a.size::float8 AS size,a.kind,w.project_id AS "projectId"
      FROM work_artifacts a JOIN work_items w ON w.id=a.work_id WHERE a.id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new Error("产物不存在");
    return { artifact: row, project: await this.project(row.projectId) };
  }
}
