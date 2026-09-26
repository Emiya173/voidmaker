import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Memory, Page, SessionSummary } from "../../contracts/src/history.js";
import type { Message } from "../../contracts/src/protocol.js";

export type ChatScope = Readonly<{ id: string; revision: string }>;
type SessionRow = { id: string; title: string; archived: boolean; revision: number; created_at: Date };
type MemoryRow = {
  id: string;
  session_id: string | null;
  text: string;
  enabled: boolean;
  revision: number;
  updated_at: Date;
  source: "manual";
};
const sessionSummary = (row: SessionRow): SessionSummary => ({
  id: row.id,
  title: row.title,
  archived: row.archived,
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
});
const memory = (row: MemoryRow): Memory => ({
  id: row.id,
  sessionId: row.session_id,
  text: row.text,
  enabled: row.enabled,
  revision: row.revision,
  updatedAt: row.updated_at.toISOString(),
  source: row.source,
});
const page = <T extends { id: string }>(rows: readonly T[]): Page<T> => ({
  items: rows.slice(0, 50),
  next: rows.length > 50 ? (rows[49]?.id ?? null) : null,
});

export class HistoryStore {
  private readonly pool: pg.Pool;
  constructor(connectionString?: string) {
    this.pool = new pg.Pool(connectionString ? { connectionString } : undefined);
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  async session(scope: ChatScope, id: string, activeOnly = false): Promise<SessionSummary> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM chat_sessions WHERE id=$1 AND character_id=$2 AND character_revision=$3",
      [id, scope.id, scope.revision],
    );
    const row = result.rows[0];
    if (!row || (activeOnly && row.archived)) throw new Error("会话不存在、已归档或不属于当前角色版本");
    return sessionSummary(row);
  }
  async create(scope: ChatScope, title: string): Promise<string> {
    const id = randomUUID();
    await this.transaction(async (client) => {
      await client.query("INSERT INTO sessions(id) VALUES($1)", [id]);
      await client.query("INSERT INTO chat_sessions(id,character_id,character_revision,title) VALUES($1,$2,$3,$4)", [
        id,
        scope.id,
        scope.revision,
        title,
      ]);
    });
    return id;
  }
  async select(scope: ChatScope, id: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query(
        "SELECT id FROM chat_sessions WHERE id=$1 AND character_id=$2 AND character_revision=$3 AND NOT archived FOR UPDATE",
        [id, scope.id, scope.revision],
      );
      if (!result.rowCount) throw new Error("会话不可用");
      await client.query(
        "INSERT INTO character_sessions(character_id,revision,session_id) VALUES($1,$2,$3) ON CONFLICT(character_id,revision) DO UPDATE SET session_id=$3",
        [scope.id, scope.revision, id],
      );
      await client.query(
        "INSERT INTO character_settings(id,selected_id) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET selected_id=$1",
        [scope.id],
      );
    });
  }
  async list(scope: ChatScope, archived: boolean, query: string, before?: string): Promise<Page<SessionSummary>> {
    const result = await this.pool.query<SessionRow>(
      `SELECT * FROM chat_sessions WHERE character_id=$1 AND character_revision=$2 AND archived=$3
      AND strpos(lower(title),lower($4))>0
      AND ($5::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM chat_sessions WHERE id=$5 AND character_id=$1 AND character_revision=$2))
      ORDER BY created_at DESC,id DESC LIMIT 51`,
      [scope.id, scope.revision, archived, query, before ?? null],
    );
    return page(result.rows.map(sessionSummary));
  }
  async change(
    scope: ChatScope,
    id: string,
    revision: number,
    value: { title: string } | { archived: boolean } | { delete: true },
  ): Promise<void> {
    await this.transaction(async (client) => {
      const rows = await client.query<SessionRow>(
        "SELECT * FROM chat_sessions WHERE id=$1 AND character_id=$2 AND character_revision=$3 AND revision=$4 FOR UPDATE",
        [id, scope.id, scope.revision, revision],
      );
      const row = rows.rows[0];
      if (!row) throw new Error("会话已变更，请刷新后重试");
      if (!("title" in value)) {
        const selected = await client.query("SELECT 1 FROM character_sessions WHERE session_id=$1", [id]);
        if (selected.rowCount) throw new Error("请先切换到另一个会话");
      }
      if ("delete" in value) {
        if (!row.archived) throw new Error("请先归档，再删除会话");
        await client.query("DELETE FROM sessions WHERE id=$1", [id]);
      } else if ("title" in value) {
        await client.query("UPDATE chat_sessions SET title=$2,revision=revision+1 WHERE id=$1", [id, value.title]);
      } else {
        await client.query("UPDATE chat_sessions SET archived=$2,revision=revision+1 WHERE id=$1", [
          id,
          value.archived,
        ]);
      }
    });
  }
  async messages(scope: ChatScope, sessionId: string, query: string, before?: string): Promise<Page<Message>> {
    await this.session(scope, sessionId);
    const result = await this.pool.query<{ id: string; role: Message["role"]; text: string; created_at: Date }>(
      `SELECT * FROM messages WHERE session_id=$1 AND strpos(lower(text),lower($2))>0
      AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM messages WHERE id=$3 AND session_id=$1))
      ORDER BY created_at DESC,id DESC LIMIT 51`,
      [sessionId, query, before ?? null],
    );
    return page(
      result.rows.map((row) => ({
        id: row.id,
        role: row.role,
        text: row.text,
        createdAt: row.created_at.toISOString(),
      })),
    );
  }
  async memories(scope: ChatScope, sessionId: string): Promise<readonly Memory[]> {
    await this.session(scope, sessionId);
    const result = await this.pool.query<MemoryRow>(
      "SELECT * FROM memories WHERE character_id=$1 AND character_revision=$2 AND (session_id IS NULL OR session_id=$3) ORDER BY updated_at,id",
      [scope.id, scope.revision, sessionId],
    );
    return result.rows.map(memory);
  }
  async saveMemory(
    scope: ChatScope,
    sessionId: string,
    value:
      | {
          id?: string | undefined;
          revision?: number | undefined;
          scope: "character" | "session";
          text: string;
          enabled: boolean;
        }
      | { id: string; revision: number; delete: true },
  ): Promise<void> {
    await this.session(scope, sessionId, true);
    await this.transaction(async (client) => {
      // Serialize quota checks and invalidation with other memory edits.
      await client.query("SELECT pg_advisory_xact_lock(91244016)");
      let affectedSession: string | null;
      if (value.id) {
        const found = await client.query<MemoryRow>(
          "SELECT * FROM memories WHERE id=$1 AND character_id=$2 AND character_revision=$3 AND (session_id IS NULL OR session_id=$4) AND revision=$5 FOR UPDATE",
          [value.id, scope.id, scope.revision, sessionId, value.revision],
        );
        const entry = found.rows[0];
        if (!entry) throw new Error("记忆已变更或不属于当前会话，请刷新后重试");
        affectedSession = entry.session_id;
        if ("delete" in value) await client.query("DELETE FROM memories WHERE id=$1", [value.id]);
        else {
          if ((value.scope === "session") !== Boolean(entry.session_id))
            throw new Error("已有记忆不能直接改变作用域，请另建一条");
          await client.query(
            "UPDATE memories SET text=$2,enabled=$3,revision=revision+1,updated_at=now() WHERE id=$1",
            [value.id, value.text, value.enabled],
          );
        }
      } else {
        if ("delete" in value) throw new Error("缺少记忆编号");
        affectedSession = value.scope === "session" ? sessionId : null;
        await client.query(
          "INSERT INTO memories(id,character_id,character_revision,session_id,text,enabled) VALUES($1,$2,$3,$4,$5,$6)",
          [randomUUID(), scope.id, scope.revision, affectedSession, value.text, value.enabled],
        );
      }
      const quota = await client.query<{ count: string; size: string }>(
        "SELECT count(*) AS count,coalesce(sum(length(text)),0) AS size FROM memories WHERE character_id=$1 AND character_revision=$2",
        [scope.id, scope.revision],
      );
      if (Number(quota.rows[0]?.count) > 100 || Number(quota.rows[0]?.size) > 20000)
        throw new Error("每个角色版本最多保存 100 条、共 20000 字记忆，请先精简");
      // Old model context may contain deleted/disabled facts. Never resume it after an edit.
      await client.query(
        "UPDATE sessions SET codex_thread_id=NULL WHERE id IN (SELECT id FROM chat_sessions WHERE character_id=$1 AND character_revision=$2 AND ($3::uuid IS NULL OR id=$3))",
        [scope.id, scope.revision, affectedSession],
      );
    });
  }
  private async transaction<T>(effect: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await effect(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
