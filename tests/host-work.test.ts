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
    const characterId = `role-${randomUUID()}`;
    const charactersDirectory = join(dir, "characters");
    await mkdir(join(charactersDirectory, characterId), { recursive: true });
    await writeFile(
      join(charactersDirectory, characterId, "character.json"),
      JSON.stringify({ version: 1, id: characterId, name: "Fixture", persona: "角色测试" }),
    );
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
          VOIDMAKER_TRAY: "0",
          FAKE_CODEX_UNIQUE_THREADS: "1",
          VOIDMAKER_SOCKET: socketPath,
          VOIDMAKER_VOICE_CONFIG: join(dir, "voice.json"),
          VOIDMAKER_CHARACTERS_DIR: charactersDirectory,
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
      send({ type: "hello", version: 7 });
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
      const settings = events.find((e) => e.type === "settings");
      if (settings?.type !== "settings") throw new Error("missing settings");
      events = [];
      send({
        type: "settings_save",
        revision: settings.settings.revision,
        config: { asr: { url: "http://127.0.0.1:1/v1/audio/transcriptions" } },
      });
      await expect
        .poll(() => events.some((e) => e.type === "settings" && !e.settings.busy && !!e.settings.config.asr))
        .toBe(true);
      expect(events.some((e) => e.type === "voice" && e.voice.inputAvailable && e.voice.phase === "idle")).toBe(true);
      const updated = events.findLast((e) => e.type === "settings");
      if (updated?.type !== "settings") throw new Error("missing updated settings");
      events = [];
      send({ type: "settings_restore", revision: updated.settings.revision });
      await expect
        .poll(() => events.some((e) => e.type === "settings" && !e.settings.busy && !e.settings.config.asr))
        .toBe(true);
      expect(events.some((e) => e.type === "voice" && !e.voice.inputAvailable)).toBe(true);
      events = [];
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
      const select = async (selectedId: string) => {
        events = [];
        send({ type: "character_select", id: selectedId });
        await expect
          .poll(() => events.some((e) => e.type === "snapshot" && e.character.selectedId === selectedId))
          .toBe(true);
        const snapshot = events.findLast((e) => e.type === "snapshot");
        if (snapshot?.type !== "snapshot") throw new Error("missing character snapshot");
        return snapshot;
      };
      const original = await select("default");
      const empty = await select(characterId);
      expect(empty.sessionId).not.toBe(original.sessionId);
      expect(empty.messages).toEqual([]);
      send({ type: "send", text: "hello" });
      await expect.poll(() => events.some((e) => e.type === "message" && e.message.role === "assistant")).toBe(true);
      await expect.poll(() => events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
      await expect
        .poll(() =>
          events.some(
            (e) =>
              e.type === "character" &&
              e.character.presentation.state === "idle" &&
              !e.character.presentation.subtitle &&
              e.character.presentation.mouth === 0,
          ),
        )
        .toBe(true);
      expect((await select("default")).messages).toEqual(original.messages);
      expect((await select(characterId)).messages.map((m) => m.text)).toEqual(["hello", "你好"]);
      const exchange = async (command: unknown, predicate: (event: ServerEvent) => boolean) => {
        events = [];
        send(command);
        await expect.poll(() => events.some(predicate), { timeout: 5000 }).toBe(true);
        return events.findLast(predicate);
      };
      const created = await exchange(
        { type: "session_create", title: "second conversation" },
        (e) => e.type === "snapshot" && e.sessionId !== empty.sessionId,
      );
      if (created?.type !== "snapshot") throw new Error("missing session snapshot");
      expect(created.messages).toEqual([]);
      await exchange(
        {
          type: "memory_save",
          sessionId: created.sessionId,
          scope: "session",
          text: "LOCAL_MEMORY_FIXTURE",
          enabled: true,
        },
        (e) => e.type === "library_changed",
      );
      await exchange({ type: "send", text: "policy" }, (e) => e.type === "status" && e.status === "idle");
      const policy = events.findLast((e) => e.type === "message" && e.message.role === "assistant");
      if (policy?.type !== "message") throw new Error("missing policy reply");
      expect(JSON.parse(policy.message.text).threadParams.baseInstructions).toContain("LOCAL_MEMORY_FIXTURE");
      const threadWithMemory = JSON.parse(policy.message.text).turnParams.threadId;
      const memories = await exchange(
        { type: "memory_list", sessionId: created.sessionId, requestId: "memories" },
        (e) => e.type === "memory_list",
      );
      if (memories?.type !== "memory_list" || !memories.items[0]) throw new Error("missing memories");
      await exchange(
        {
          type: "memory_delete",
          sessionId: created.sessionId,
          id: memories.items[0].id,
          revision: memories.items[0].revision,
        },
        (e) => e.type === "library_changed",
      );
      await exchange({ type: "send", text: "policy" }, (e) => e.type === "status" && e.status === "idle");
      const cleared = events.findLast((e) => e.type === "message" && e.message.role === "assistant");
      if (cleared?.type !== "message") throw new Error("missing cleared reply");
      expect(JSON.parse(cleared.message.text).threadParams.baseInstructions).not.toContain("LOCAL_MEMORY_FIXTURE");
      expect(JSON.parse(cleared.message.text).turnParams.threadId).not.toBe(threadWithMemory);
      const back = await exchange(
        { type: "session_select", id: empty.sessionId },
        (e) => e.type === "snapshot" && e.sessionId === empty.sessionId,
      );
      expect(back?.type === "snapshot" && back.messages.map((m) => m.text)).toEqual(["hello", "你好"]);
      await exchange(
        { type: "session_archive", id: created.sessionId, revision: 0, archived: true },
        (e) => e.type === "library_changed",
      );
      await exchange({ type: "session_select", id: created.sessionId }, (e) => e.type === "error");
      const archived = await exchange(
        { type: "history_list", sessionId: created.sessionId, requestId: "archived", query: "policy" },
        (e) => e.type === "history_list",
      );
      expect(archived?.type === "history_list" && archived.page.items.filter((m) => m.role === "user")).toHaveLength(2);
      events = [];
      send({ type: "send", text: "wait" });
      await expect.poll(() => events.some((e) => e.type === "message" && e.message.role === "user")).toBe(true);
      send({ type: "character_select", id: "default" });
      await expect.poll(() => events.some((e) => e.type === "error" && e.message.includes("停止"))).toBe(true);
      events = [];
      send({
        type: "memory_save",
        sessionId: empty.sessionId,
        scope: "character",
        text: "busy must reject",
        enabled: true,
      });
      await expect.poll(() => events.some((e) => e.type === "error" && e.message.includes("停止"))).toBe(true);
      send({ type: "stop" });
      await expect.poll(() => events.some((e) => e.type === "status" && e.status === "idle")).toBe(true);
      socket?.destroy();
      const closing = once(child as ChildProcess, "exit");
      child?.kill("SIGTERM");
      await closing;
      start();
      await connect();
      const characterRestored = events.find((e) => e.type === "snapshot");
      expect(characterRestored?.type === "snapshot" && characterRestored.character.selectedId).toBe(characterId);
      expect(characterRestored?.type === "snapshot" && characterRestored.sessionId).toBe(empty.sessionId);
      await select("default");
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
  30_000,
);
