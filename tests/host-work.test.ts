import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import type { ServerEvent } from "../packages/contracts/src/protocol.js";

const url = process.env.VOIDMAKER_HOST_TEST_DATABASE_URL;
it.skipIf(!url)(
  "keeps chat independent and restores interrupted work after a Host crash",
  async () => {
    if (url === process.env.VOIDMAKER_TEST_DATABASE_URL) throw new Error("Host 测试必须使用另一独立数据库");
    const dir = await mkdtemp(join(tmpdir(), "voidmaker-host-test-"));
    const socketPath = join(dir, "host.sock");
    const binaryDir = join(dir, "bin");
    await mkdir(binaryDir);
    await writeFile(
      join(binaryDir, "codex"),
      `#!${process.execPath}\nimport ${JSON.stringify(join(process.cwd(), "tests/fixtures/fake-codex.mjs"))};\n`,
    );
    await chmod(join(binaryDir, "codex"), 0o700);
    for (const [name, output] of Object.entries({
      niri: JSON.stringify({ id: 1, app_id: "fixture", title: "fixture desktop context" }),
      loginctl: "Active=yes\nLockedHint=no\nIdleHint=no\n",
    })) {
      await writeFile(
        join(binaryDir, name),
        `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`,
      );
      await chmod(join(binaryDir, name), 0o700);
    }
    await writeFile(join(dir, "voice.json"), "{}");
    let child: ChildProcess | undefined;
    let socket: Socket | undefined;
    let log = "";
    let events: ServerEvent[] = [];
    function start() {
      log = "";
      child = spawn(process.execPath, ["--import", "tsx", "apps/host/src/main.ts"], {
        env: {
          ...process.env,
          DATABASE_URL: url,
          VOIDMAKER_SOCKET: socketPath,
          VOIDMAKER_VOICE_CONFIG: join(dir, "voice.json"),
          XDG_STATE_HOME: dir,
          XDG_RUNTIME_DIR: dir,
          PATH: `${binaryDir}:${process.env.PATH}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (data: Buffer) => {
        log += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        log += data.toString();
      });
    }
    async function connect() {
      await expect.poll(() => log, { timeout: 10_000 }).toContain("VoidMaker Host:");
      socket = createConnection(socketPath);
      await once(socket, "connect");
      events = [];
      createInterface({ input: socket }).on("line", (line) => events.push(JSON.parse(line) as ServerEvent));
      send({ type: "hello", version: 4 });
      await expect.poll(() => events.some((e) => e.type === "snapshot")).toBe(true);
    }
    function send(value: unknown) {
      socket?.write(`${JSON.stringify(value)}\n`);
    }
    async function detail(id: string) {
      events = events.filter((e) => e.type !== "work_detail");
      send({ type: "work_get", id });
      await expect.poll(() => events.some((e) => e.type === "work_detail" && e.detail.work.id === id)).toBe(true);
      const event = events.find((e) => e.type === "work_detail" && e.detail.work.id === id);
      if (event?.type !== "work_detail") throw new Error(log);
      return event.detail;
    }
    async function waitStatus(id: string, status: string) {
      await expect.poll(async () => (await detail(id)).work.status, { timeout: 5000 }).toBe(status);
    }
    async function submit(projectId: string, prompt: string) {
      const id = randomUUID();
      send({ type: "work_draft", id, projectId, prompt });
      await expect.poll(() => events.some((e) => e.type === "work_saved" && e.id === id)).toBe(true);
      send({ type: "work_submit", id, revision: 0 });
      return id;
    }
    try {
      start();
      await connect();
      send({ type: "desktop_grant", source: "window", minutes: 15 });
      await expect.poll(() => events.some((e) => e.type === "desktop" && e.desktop.grants.window > 0)).toBe(true);
      send({ type: "desktop_read", source: "window" });
      await expect.poll(() => events.some((e) => e.type === "desktop" && e.desktop.observations.length > 0)).toBe(true);
      const preview = events.findLast((e) => e.type === "desktop" && e.desktop.observations.length > 0);
      if (preview?.type !== "desktop") throw new Error("missing preview");
      send({ type: "desktop_send", id: preview.desktop.observations[0]?.id, text: "wait" });
      await expect
        .poll(() =>
          events.some(
            (e) =>
              e.type === "message" && e.message.role === "user" && e.message.text.includes("fixture desktop context"),
          ),
        )
        .toBe(true);
      send({ type: "desktop_revoke" });
      await expect.poll(() => events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
      expect(events.some((e) => e.type === "message" && e.message.role === "assistant")).toBe(false);
      send({ type: "desktop_grant", source: "window", minutes: 15 });
      send({ type: "project_add", name: "Host test", path: dir });
      await expect.poll(() => events.some((e) => e.type === "work_changed")).toBe(true);
      send({ type: "work_list" });
      await expect
        .poll(() => events.some((e) => e.type === "work_list" && e.projects.some((p) => p.path === dir)))
        .toBe(true);
      const list = events.findLast((e) => e.type === "work_list" && e.projects.some((p) => p.path === dir));
      if (list?.type !== "work_list") throw new Error(log);
      const projectId = list.projects.find((p) => p.path === dir)?.id;
      if (!projectId) throw new Error("missing project");
      const id = await submit(projectId, "wait");
      await expect.poll(async () => Boolean((await detail(id)).attempts[0]?.turnId)).toBe(true);
      send({ type: "send", text: "hello" });
      await expect
        .poll(() =>
          events.some((e) => e.type === "message" && e.message.role === "assistant" && e.message.text === "你好"),
        )
        .toBe(true);
      await waitStatus(id, "running");
      send({ type: "work_cancel", id });
      await waitStatus(id, "cancelled");
      const approvalTask = await submit(projectId, "approval");
      await waitStatus(approvalTask, "awaiting_permission");
      const before = await detail(approvalTask);
      expect(before.approvals[0]?.decision).toBeNull();
      socket?.destroy();
      const exited = once(child as ChildProcess, "exit");
      child?.kill("SIGKILL");
      await exited;
      start();
      await connect();
      const desktop = events.find((e) => e.type === "desktop");
      expect(desktop?.type === "desktop" && desktop.desktop.grants.window).toBe(0);
      expect(desktop?.type === "desktop" && desktop.desktop.policy.proactive).toBe(false);
      const restored = await detail(approvalTask);
      expect(restored.work.status).toBe("interrupted");
      expect(restored.attempts).toHaveLength(1);
      expect(restored.approvals[0]?.decision).toBe("expired");
      send({ type: "work_retry", id: approvalTask, revision: restored.work.revision });
      await waitStatus(approvalTask, "awaiting_permission");
      const retried = await detail(approvalTask);
      expect(retried.attempts).toHaveLength(2);
      expect(retried.work.attemptId).not.toBe(restored.work.attemptId);
      const pending = retried.approvals.find((a) => a.decision === null);
      send({ type: "work_approval", id: pending?.id, decision: "decline" });
      await waitStatus(approvalTask, "failed"); // Fixture returns a plain decision, not a successful structured result.
      expect((await detail(approvalTask)).approvals.at(-1)?.decision).toBe("decline");
      expect(events.filter((e) => e.type === "error")).toEqual([]);
    } finally {
      socket?.destroy();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await rm(dir, { recursive: true });
    }
  },
  20_000,
);
