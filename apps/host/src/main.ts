import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inspectArtifact, projectPath } from "../../../packages/adapters/src/artifacts.js";
import { captureAudio, playAudio } from "../../../packages/adapters/src/audio-process.js";
import { CodexAppServer } from "../../../packages/adapters/src/codex.js";
import { Database, DEFAULT_SESSION_ID } from "../../../packages/adapters/src/database.js";
import { desktopAdapters } from "../../../packages/adapters/src/desktop.js";
import { suggestDesktop } from "../../../packages/adapters/src/desktop-codex.js";
import { DesktopStore } from "../../../packages/adapters/src/desktop-store.js";
import { synthesize, transcribe } from "../../../packages/adapters/src/speech-http.js";
import { WorkStore } from "../../../packages/adapters/src/work-store.js";
import { clientCommand, PROTOCOL_VERSION, type ServerEvent } from "../../../packages/contracts/src/protocol.js";
import type { VoiceConfig } from "../../../packages/contracts/src/voice.js";
import { type ConversationState, initialConversation, transition } from "../../../packages/domain/src/conversation.js";
import { contextPrompt } from "../../../packages/domain/src/desktop.js";
import { loadVoiceConfig } from "./config.js";
import { DesktopController } from "./desktop.js";
import { migrate } from "./migrate.js";
import { VoiceController } from "./voice.js";
import { WorkManager } from "./work.js";

const MAX_LINE_BYTES = 64 * 1024;
const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
if (!runtimeDirectory) throw new Error("XDG_RUNTIME_DIR 未设置，无法创建本地 UI socket");
const socketPath = process.env.VOIDMAKER_SOCKET ?? join(runtimeDirectory, "voidmaker", "host.sock");

async function socketIsActive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

class Host {
  private state: ConversationState = initialConversation;
  private readonly clients = new Set<Socket>();
  private readonly approvals = new Map<
    string,
    { description: string; answer: (decision: "accept" | "acceptForSession" | "decline") => void }
  >();
  private threadId = "";
  private readonly codex: CodexAppServer;
  private readonly voice: VoiceController;
  private readonly work: WorkManager;
  private readonly desktop: DesktopController;
  private readonly desktopStore = new DesktopStore(process.env.DATABASE_URL);
  private readonly presence = new Map<Socket, boolean>();
  private desktopReplyGeneration: number | null = null;

  constructor(
    private readonly database: Database,
    chatDirectory: string,
    voiceConfig: VoiceConfig,
  ) {
    this.work = new WorkManager(
      new WorkStore(process.env.DATABASE_URL),
      (id) => this.broadcast({ type: "work_changed", id }),
      (message) => {
        console.error("后台任务:", message);
        this.broadcast({ type: "error", message });
      },
    );
    this.codex = new CodexAppServer(
      (method, params) => this.askApproval(method, params),
      chatDirectory,
      "codex",
      ["app-server", "--stdio"],
      { restricted: true },
    );
    this.desktop = new DesktopController(join(dirname(socketPath), "desktop"), {
      adapters: desktopAdapters(),
      store: this.desktopStore,
      publish: (desktop) => this.broadcast({ type: "desktop", desktop }),
      present: () => [...this.presence.values()].some((idle) => !idle),
      idle: () => this.state.phase === "idle" && this.voice.snapshot.phase === "idle",
      suggest: (context, signal) => suggestDesktop(chatDirectory, context, signal),
      revoked: () => {
        if (this.desktopReplyGeneration === this.state.generation) void this.stop();
      },
    });
    this.voice = new VoiceController(
      {
        capture: (signal, onLevel) => captureAudio(voiceConfig, signal, onLevel),
        transcribe: (wav, signal) => {
          if (!voiceConfig.asr) throw new Error("未配置 ASR");
          return transcribe(wav, voiceConfig.asr, signal);
        },
        synthesize: (text, signal) => {
          if (!voiceConfig.tts) throw new Error("未配置 TTS");
          return synthesize(text, voiceConfig.tts, signal);
        },
        play: playAudio,
        submit: (text) => this.sendMessage(text),
        publish: (voice) => this.broadcast({ type: "voice", voice }),
      },
      Boolean(voiceConfig.asr),
      Boolean(voiceConfig.tts),
    );
  }

  async start(): Promise<void> {
    await this.work.start();
    await this.desktop.start();
    const oldThread = await this.database.ensureSession();
    await this.codex.start();
    this.threadId = await this.codex.startThread(oldThread);
    if (this.threadId !== oldThread) await this.database.setCodexThread(DEFAULT_SESSION_ID, this.threadId);
  }

  async close(): Promise<void> {
    for (const approval of this.approvals.values()) approval.answer("decline");
    for (const client of this.clients) client.destroy();
    await this.desktop.close();
    await this.desktopStore.close();
    await this.voice.cancel();
    await this.codex.close();
    await this.work.close();
    await this.work.store.close();
  }

  attach(client: Socket): void {
    this.clients.add(client);
    client.on("close", () => {
      this.clients.delete(client);
      this.presence.delete(client);
      if (this.clients.size === 0) {
        this.desktop.disconnected();
        void this.voice.cancel().catch((error: unknown) => console.error("语音停止失败", error));
      }
    });
    client.on("error", () => client.destroy());
    client.setEncoding("utf8");
    let buffer = "";
    client.on("data", (data: string) => {
      buffer += data;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          client.destroy();
          return;
        }
        void this.handle(client, line).catch((error: unknown) => {
          this.send(client, { type: "error", message: error instanceof Error ? error.message : String(error) });
        });
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) client.destroy();
    });
  }

  private async handle(client: Socket, line: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("无效 JSON 命令");
    }
    const parsed = clientCommand.safeParse(raw);
    if (!parsed.success) throw new Error("无效或不兼容的命令");
    const command = parsed.data;
    switch (command.type) {
      case "hello": {
        this.send(client, { type: "desktop", desktop: this.desktop.snapshot });
        const messages = await this.database.listMessages(DEFAULT_SESSION_ID);
        this.send(client, {
          type: "snapshot",
          version: PROTOCOL_VERSION,
          sessionId: DEFAULT_SESSION_ID,
          messages,
          status: this.state.phase,
          draft: this.state.phase === "thinking" ? this.state.draft : "",
          voice: this.voice.snapshot,
        });
        for (const [requestId, approval] of this.approvals) {
          this.send(client, { type: "approval", requestId, description: approval.description });
        }
        this.send(client, { type: "work_list", ...(await this.work.store.list()) });
        return;
      }
      case "desktop_grant":
        await this.desktop.grant(command.source, command.minutes);
        return;
      case "desktop_revoke":
        await this.desktop.revoke(command.source);
        return;
      case "desktop_policy":
        await this.desktop.configure(command.policy);
        return;
      case "desktop_read":
        await this.desktop.read(command.source);
        return;
      case "desktop_clear":
        await this.desktop.clear();
        return;
      case "desktop_presence":
        this.presence.set(client, command.idle);
        return;
      case "desktop_send":
        await this.sendMessage(command.text, command.id);
        return;
      case "project_add":
        await this.work.store.addProject(command.name, await projectPath(command.path));
        this.broadcast({ type: "work_changed", id: "" });
        return;
      case "work_list":
        this.send(client, { type: "work_list", ...(await this.work.store.list()) });
        return;
      case "work_get":
        this.send(client, { type: "work_detail", detail: await this.work.store.detail(command.id) });
        return;
      case "work_draft":
        await this.work.store.draft(command.id, command.projectId, command.prompt);
        this.send(client, { type: "work_saved", id: command.id });
        this.broadcast({ type: "work_changed", id: command.id });
        return;
      case "work_edit":
        await this.work.store.edit(command.id, command.revision, command.prompt);
        this.broadcast({ type: "work_changed", id: command.id });
        return;
      case "work_submit":
      case "work_retry":
        await this.work.enqueue(command.id, command.revision, command.type === "work_retry");
        return;
      case "work_cancel":
        await this.work.cancel(command.id);
        return;
      case "work_approval":
        await this.work.decide(command.id, command.decision);
        return;
      case "artifact_open": {
        const { artifact, project } = await this.work.store.findArtifact(command.id);
        const verified = await inspectArtifact(project.path, artifact.path);
        if (verified.artifact.sha256 !== artifact.sha256) throw new Error("文件已在任务后发生变化，不能作为原产物查看");
        this.send(client, {
          type: "artifact_preview",
          path: artifact.path,
          text: verified.preview,
          sha256: artifact.sha256,
        });
        return;
      }
      case "send":
        await this.sendMessage(command.text);
        return;
      case "stop":
        await this.stop();
        return;
      case "voice_start":
        if (this.state.phase !== "idle") throw new Error("请先停止当前回复");
        this.voice.listen(command.continuous);
        return;
      case "voice_finish":
        this.voice.finish();
        return;
      case "approval":
        this.approvals.get(command.requestId)?.answer(command.decision);
        return;
    }
  }

  private async sendMessage(text: string, desktopId?: string): Promise<void> {
    if (this.state.phase !== "idle") throw new Error("请先停止当前回复");
    const voiceGeneration = this.voice.beginReply();
    this.state = transition(this.state, { type: "send" });
    const generation = this.state.generation;
    if (desktopId) this.desktopReplyGeneration = generation;
    this.broadcast({ type: "status", status: "thinking" });
    try {
      const shared = desktopId ? await this.desktop.share(desktopId) : undefined;
      shared?.signal.throwIfAborted();
      if (this.state.phase !== "thinking" || this.state.generation !== generation) return;
      const prompt = shared ? contextPrompt(text, shared.context) : text;
      const message = await this.database.addMessage(
        DEFAULT_SESSION_ID,
        "user",
        shared ? `${text}\n\n[附带桌面上下文]\n${shared.context}` : text,
      );
      this.broadcast({ type: "message", message });
      if (this.state.phase !== "thinking" || this.state.generation !== generation) return;
      const reply = await this.codex.run(
        this.threadId,
        prompt,
        (delta) => {
          if (this.state.phase !== "thinking" || this.state.generation !== generation) return;
          this.state = transition(this.state, { type: "delta", generation, text: delta });
          this.broadcast({ type: "delta", turnId: String(generation), text: delta });
        },
        shared?.imageUrl ? [shared.imageUrl] : [],
      );
      if (this.state.phase !== "thinking" || this.state.generation !== generation) return;
      if (reply.trim()) {
        const assistantMessage = await this.database.addMessage(DEFAULT_SESSION_ID, "assistant", reply);
        this.broadcast({ type: "message", message: assistantMessage });
        if (this.state.phase === "thinking" && this.state.generation === generation)
          await this.voice.speak(reply, voiceGeneration);
      } else {
        await this.voice.speak("", voiceGeneration);
      }
    } catch (error) {
      if (this.state.phase === "thinking" && this.state.generation === generation) {
        this.broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) });
        await this.voice.cancel(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (this.desktopReplyGeneration === generation) this.desktopReplyGeneration = null;
      if (this.state.phase === "thinking" && this.state.generation === generation) {
        this.state = transition(this.state, { type: "complete", generation });
        this.broadcast({ type: "status", status: "idle" });
        this.voice.resumeListening();
      } else if (this.state.phase === "stopping" && this.state.generation === generation + 1) {
        this.state = transition(this.state, { type: "complete", generation: generation + 1 });
        this.broadcast({ type: "status", status: "idle" });
      }
    }
  }

  private async stop(): Promise<void> {
    if (this.state.phase !== "thinking") {
      await this.voice.cancel();
      return;
    }
    this.state = transition(this.state, { type: "stop" });
    this.broadcast({ type: "status", status: "stopping" });
    for (const approval of this.approvals.values()) approval.answer("decline");
    this.approvals.clear();
    try {
      await Promise.all([this.voice.cancel(), this.codex.interrupt()]);
    } catch (error) {
      this.broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) });
      const generation = this.state.generation;
      this.state = transition(this.state, { type: "complete", generation });
      this.broadcast({ type: "status", status: "idle" });
    }
  }

  private askApproval(
    method: string,
    params: Record<string, unknown>,
  ): Promise<"accept" | "acceptForSession" | "decline"> {
    if (this.clients.size === 0) return Promise.resolve("decline");
    const requestId = randomUUID();
    const description = `${method}\n${JSON.stringify(params, null, 2)}`;
    if (Buffer.byteLength(description) > 16_000) return Promise.resolve("decline");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(requestId);
        this.broadcast({ type: "approval_closed", requestId });
        resolve("decline");
      }, 60_000);
      this.approvals.set(requestId, {
        description,
        answer: (decision) => {
          clearTimeout(timer);
          this.approvals.delete(requestId);
          this.broadcast({ type: "approval_closed", requestId });
          resolve(decision);
        },
      });
      this.broadcast({ type: "approval", requestId, description });
    });
  }

  private send(client: Socket, event: ServerEvent): void {
    if (client.writable) client.write(`${JSON.stringify(event)}\n`);
  }

  private broadcast(event: ServerEvent): void {
    for (const client of this.clients) this.send(client, event);
  }
}

async function main(): Promise<void> {
  if (await socketIsActive(socketPath)) throw new Error(`Host 已运行: ${socketPath}`);
  await migrate(process.env.DATABASE_URL);
  const chatDirectory = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "voidmaker", "chat");
  await mkdir(chatDirectory, { recursive: true, mode: 0o700 });
  const database = new Database(process.env.DATABASE_URL);
  const host = new Host(database, chatDirectory, await loadVoiceConfig());
  const server = createServer((client) => host.attach(client));
  try {
    await database.check();
    await host.start();
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    await host.close();
    await database.close();
    throw error;
  }
  console.log(`VoidMaker Host: ${socketPath}`);
  const shutdown = async () => {
    server.close();
    await host.close();
    await database.close();
    await unlink(socketPath).catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
