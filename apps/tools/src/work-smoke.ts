import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { WorkStore } from "../../../packages/adapters/src/work-store.js";
import { migrate } from "../../host/src/migrate.js";
import { WorkManager } from "../../host/src/work.js";

// Explicit opt-in: real Codex usage, isolated project, dedicated test database, no microphone.
const url = process.env.VOIDMAKER_TEST_DATABASE_URL;
if (!url) throw new Error("请指定独立的 VOIDMAKER_TEST_DATABASE_URL（不要使用生产数据库）");
await migrate(url);
const store = new WorkStore(url);
const errors: string[] = [];
const manager = new WorkManager(
  store,
  () => undefined,
  (message) => errors.push(message),
);
const directory = await mkdtemp("/tmp/voidmaker-work-acceptance-");
const id = randomUUID();
try {
  await manager.start();
  const project = await store.addProject("Codex 后台任务验收", directory);
  await store.draft(
    id,
    project.id,
    "在当前项目创建 acceptance.txt，内容严格为 VoidMaker background work accepted 加一个换行。使用 shell 或 Node.js 实际验证内容，然后返回中文总结，并将 acceptance.txt 列为产物。不要联网、提交或推送。",
  );
  await store.enqueue(id, 0, false);
  console.log(JSON.stringify({ id, directory }));
  const started = Date.now();
  manager.wake();
  let status = "";
  while (Date.now() - started < 120_000) {
    const detail = await store.detail(id);
    if (status !== detail.work.status) {
      status = detail.work.status;
      console.log(status);
    }
    for (const approval of detail.approvals.filter((value) => value.decision === null)) {
      // The fixture only needs workspace writes. Unexpected escalation is never auto-accepted.
      console.log("拒绝验收任务的额外权限请求");
      await manager.decide(approval.id, "decline");
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(status)) {
      await writeFile(
        join(directory, "acceptance-report.json"),
        JSON.stringify({ elapsedMs: Date.now() - started, errors, detail }, null, 2),
      );
      assert.equal(status, "completed", detail.attempts.at(-1)?.error);
      assert.equal(await readFile(join(directory, "acceptance.txt"), "utf8"), "VoidMaker background work accepted\n");
      assert.equal(detail.artifacts.length, 1);
      assert.equal(detail.artifacts[0]?.path, "acceptance.txt");
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          elapsedMs: Date.now() - started,
          artifact: detail.artifacts[0],
          report: join(directory, "acceptance-report.json"),
        }),
      );
      break;
    }
    await setTimeout(250);
  }
  assert.equal(status, "completed", "实机验收超时");
} finally {
  await manager.close();
  await store.close();
}
