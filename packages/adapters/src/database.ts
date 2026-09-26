import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Message } from "../../contracts/src/protocol.js";
import { messages, sessions } from "./schema.js";

export const DEFAULT_SESSION_ID = "00000000-0000-4000-8000-000000000001";

export class Database {
  private readonly pool: pg.Pool;
  private readonly db;

  constructor(connectionString?: string) {
    this.pool = new pg.Pool(connectionString ? { connectionString } : undefined);
    this.db = drizzle(this.pool);
  }

  async check(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureSession(sessionId = DEFAULT_SESSION_ID): Promise<string | null> {
    await this.db.insert(sessions).values({ id: sessionId }).onConflictDoNothing();
    const rows = await this.db
      .select({ codexThreadId: sessions.codexThreadId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return rows[0]?.codexThreadId ?? null;
  }

  async setCodexThread(sessionId: string, threadId: string): Promise<void> {
    await this.db.update(sessions).set({ codexThreadId: threadId }).where(eq(sessions.id, sessionId));
  }

  async addMessage(sessionId: string, role: Message["role"], text: string): Promise<Message> {
    const id = randomUUID();
    const rows = await this.db
      .insert(messages)
      .values({ id, sessionId, role, text })
      .returning({ createdAt: messages.createdAt });
    const createdAt = rows[0]?.createdAt;
    if (!createdAt) throw new Error("数据库未返回消息时间");
    return { id, role, text, createdAt: createdAt.toISOString() };
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(200);
    return rows
      .reverse()
      .map((row) => ({ id: row.id, role: row.role, text: row.text, createdAt: row.createdAt.toISOString() }));
  }
}
