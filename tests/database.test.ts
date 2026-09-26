import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../apps/host/src/migrate.js";
import { Database } from "../packages/adapters/src/database.js";

const connectionString = process.env.VOIDMAKER_TEST_DATABASE_URL;
const database = new Database(connectionString);

afterAll(async () => database.close());

describe.skipIf(!connectionString)("PostgreSQL persistence", () => {
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
