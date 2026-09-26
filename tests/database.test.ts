import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../apps/host/src/migrate.js";
import { Database } from "../packages/adapters/src/database.js";
import { DesktopStore } from "../packages/adapters/src/desktop-store.js";
import { desktopPolicy, noDesktopGrants } from "../packages/contracts/src/desktop.js";

const connectionString = process.env.VOIDMAKER_TEST_DATABASE_URL;
const database = new Database(connectionString);

afterAll(async () => database.close());

describe.skipIf(!connectionString)("PostgreSQL persistence", () => {
  it("isolates character histories by definition revision while preserving the original default session", async () => {
    await migrate(connectionString);
    const id = `character-${randomUUID()}`;
    const first = await database.characterSession(id, "v1");
    await database.addMessage(first, "user", "only first character");
    expect(await database.characterSession(id, "v1")).toBe(first);
    const revised = await database.characterSession(id, "v2");
    expect(revised).not.toBe(first);
    expect(await database.listMessages(revised)).toEqual([]);
    expect(await database.characterSession("default", "builtin-1")).toBe("00000000-0000-4000-8000-000000000001");
    await database.selectCharacter(id);
    expect(await database.selectedCharacter()).toBe(id);
    await database.selectCharacter("default");
  });
  it("resets desktop grants and proactive mode on restart while retaining preferences", async () => {
    await migrate(connectionString);
    const store = new DesktopStore(connectionString);
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await store.start();
      await store.save(
        desktopPolicy.parse({ proactive: true, intervalSeconds: 120 }),
        { ...noDesktopGrants, window: Date.now() + 60000 },
        "grant",
      );
      const resumed = await store.start();
      expect(resumed.proactive).toBe(false);
      expect(resumed.intervalSeconds).toBe(120);
      const settings = await client.query("SELECT grants FROM desktop_settings WHERE id=true");
      expect(settings.rows[0].grants).toEqual(noDesktopGrants);
      await store.audit("capture", "region", { id: "audit-test", bytes: 123, sha256: "test-hash" });
      const audit = await client.query(
        "SELECT detail FROM desktop_events WHERE kind='capture' ORDER BY id DESC LIMIT 1",
      );
      expect(audit.rows[0].detail).toEqual({ id: "audit-test", bytes: 123, sha256: "test-hash" });
    } finally {
      await client.end();
      await store.close();
    }
  });
  it("applies migrations twice and restores messages and a Codex thread", async () => {
    await migrate(connectionString);
    await migrate(connectionString);
    const sessionId = randomUUID();
    expect(await database.ensureSession(sessionId)).toBeNull();
    await database.setCodexThread(sessionId, "thread-test");
    await database.addMessage(sessionId, "user", "持久化测试");
    await database.addMessage(sessionId, "assistant", "已保存");
    expect(await database.ensureSession(sessionId)).toBe("thread-test");
    const messages = await database.listMessages(sessionId);
    expect(messages.map((message) => message.text)).toEqual(["持久化测试", "已保存"]);
  });
});
