import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../apps/host/src/migrate.js";
import { Database } from "../packages/adapters/src/database.js";
import { HistoryStore } from "../packages/adapters/src/history-store.js";
import { clientCommand } from "../packages/contracts/src/protocol.js";
import { memoryInstructions } from "../packages/domain/src/memory.js";

const url = process.env.VOIDMAKER_TEST_DATABASE_URL;
const store = new HistoryStore(url),
  database = new Database(url);
afterAll(async () => {
  await store.close();
  await database.close();
});
it("limits manual memory commands and omits disabled or out-of-session context", () => {
  const sessionId = randomUUID();
  expect(
    clientCommand.safeParse({ type: "memory_save", sessionId, scope: "global", text: "secret", enabled: true }).success,
  ).toBe(false);
  expect(clientCommand.safeParse({ type: "session_rename", id: sessionId, revision: 0, title: " " }).success).toBe(
    false,
  );
  const base = { id: randomUUID(), revision: 0, updatedAt: "", source: "manual" as const, enabled: true };
  const instructions = memoryInstructions(
    [
      { ...base, sessionId: null, text: "role fact" },
      { ...base, sessionId, text: "session fact" },
      { ...base, sessionId: "other", text: "private other" },
      { ...base, sessionId, enabled: false, text: "disabled fact" },
    ],
    sessionId,
  );
  expect(instructions).toContain("role fact");
  expect(instructions).toContain("session fact");
  expect(instructions).not.toContain("private other");
  expect(instructions).not.toContain("disabled fact");
});
describe.skipIf(!url)("session and memory PostgreSQL", () => {
  it("preserves selection, enforces role/version ownership and uses revision checks for archive/delete", async () => {
    await migrate(url);
    const scope = { id: `history-${randomUUID()}`, revision: "v1" };
    const first = await database.characterSession(scope.id, scope.revision);
    await database.addMessage(first, "user", "original history");
    const second = await store.create(scope, "新会话");
    await store.select(scope, second);
    expect(await database.characterSession(scope.id, scope.revision)).toBe(second);
    await expect(store.session({ ...scope, revision: "v2" }, first)).rejects.toThrow("不属于");
    await expect(store.messages({ ...scope, id: "different" }, first, "")).rejects.toThrow("不属于");
    await expect(store.change(scope, second, 0, { archived: true })).rejects.toThrow("先切换");
    await store.change(scope, first, 0, { title: "保留记录" });
    await expect(store.change(scope, first, 0, { title: "stale" })).rejects.toThrow("已变更");
    await expect(store.change(scope, first, 1, { delete: true })).rejects.toThrow("先归档");
    await store.change(scope, first, 1, { archived: true });
    expect((await store.list(scope, true, "保留")).items.map((s) => s.id)).toEqual([first]);
    expect((await store.messages(scope, first, "original")).items).toHaveLength(1);
    await store.change(scope, first, 2, { archived: false });
    await store.change(scope, first, 3, { archived: true });
    await store.change(scope, first, 4, { delete: true });
    expect(await database.listMessages(first)).toEqual([]);
  });
  it("paginates beyond 200 messages without losing sub-millisecond timestamps or literal search characters", async () => {
    await migrate(url);
    const scope = { id: `pages-${randomUUID()}`, revision: "v1" };
    const id = await store.create(scope, "分页");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO messages(id,session_id,role,text,created_at)
        SELECT md5($1 || n::text)::uuid,$1::uuid,'user','100%_ literal ' || n::text,'2026-01-01'::timestamptz + n*interval '1 microsecond' FROM generate_series(1,235) n`,
        [id],
      );
      const ids: string[] = [];
      let before: string | undefined;
      do {
        const result = await store.messages(scope, id, "%_", before);
        ids.push(...result.items.map((m) => m.id));
        before = result.next ?? undefined;
      } while (before);
      expect(ids).toHaveLength(235);
      expect(new Set(ids).size).toBe(235);
      expect((await store.messages(scope, id, "not-found")).items).toEqual([]);
      await client.query(
        `WITH inserted AS (INSERT INTO sessions(id) SELECT md5($1 || 'session' || n::text)::uuid FROM generate_series(1,55) n RETURNING id)
        INSERT INTO chat_sessions(id,character_id,character_revision,title) SELECT id,$1,'v1','分页' FROM inserted`,
        [scope.id],
      );
      const first = await store.list(scope, false, "分页");
      const next = await store.list(scope, false, "分页", first.next ?? undefined);
      expect(new Set([...first.items, ...next.items].map((s) => s.id)).size).toBe(56);
    } finally {
      await client.end();
    }
  });
  it("scopes memories, rolls back conflicts/quotas and invalidates every affected model thread atomically", async () => {
    await migrate(url);
    const scope = { id: `memory-${randomUUID()}`, revision: "v1" };
    const first = await store.create(scope, "first"),
      second = await store.create(scope, "second");
    const other = await store.create({ ...scope, revision: "v2" }, "new version");
    const setThreads = async () => {
      for (const id of [first, second, other]) await database.setCodexThread(id, `thread-${id}`);
    };
    await setThreads();
    await store.saveMemory(scope, first, { scope: "session", text: "only first", enabled: true });
    expect(await database.ensureSession(first)).toBeNull();
    expect(await database.ensureSession(second)).toBe(`thread-${second}`);
    expect(await store.memories(scope, second)).toEqual([]);
    await store.saveMemory(scope, first, { scope: "character", text: "shared fact", enabled: true });
    expect(await database.ensureSession(second)).toBeNull();
    expect(await database.ensureSession(other)).toBe(`thread-${other}`);
    const entry = (await store.memories(scope, second))[0];
    if (!entry) throw new Error("missing memory");
    await setThreads();
    await store.saveMemory(scope, second, {
      id: entry.id,
      revision: entry.revision,
      scope: "character",
      text: "corrected",
      enabled: false,
    });
    expect(await database.ensureSession(first)).toBeNull();
    await expect(
      store.saveMemory(scope, first, { id: entry.id, revision: entry.revision, delete: true }),
    ).rejects.toThrow("已变更");
    expect(memoryInstructions(await store.memories(scope, second), second)).toBe("");
    await store.saveMemory(scope, second, { id: entry.id, revision: 1, delete: true });
    expect(await store.memories(scope, second)).toEqual([]);
    const local = (await store.memories(scope, first))[0];
    if (!local) throw new Error("missing local memory");
    await expect(store.saveMemory(scope, second, { id: local.id, revision: 0, delete: true })).rejects.toThrow(
      "不属于",
    );
    for (let i = 0; i < 9; i++)
      await store.saveMemory(scope, first, { scope: "character", text: "a".repeat(2000), enabled: true });
    await setThreads();
    await expect(
      store.saveMemory(scope, first, { scope: "character", text: "a".repeat(2000), enabled: true }),
    ).rejects.toThrow("精简");
    expect(await database.ensureSession(first)).toBe(`thread-${first}`);
    expect(await store.memories(scope, first)).toHaveLength(10);
  });
});
