import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { captureAudio, playAudio } from "../../../packages/adapters/src/audio-process.js";
import { CodexAppServer } from "../../../packages/adapters/src/codex.js";
import { Database, DEFAULT_SESSION_ID } from "../../../packages/adapters/src/database.js";
import { synthesize, transcribe } from "../../../packages/adapters/src/speech-http.js";
import { clientCommand, PROTOCOL_VERSION, type ServerEvent } from "../../../packages/contracts/src/protocol.js";
import type { VoiceConfig } from "../../../packages/contracts/src/voice.js";
import { type ConversationState, initialConversation, transition } from "../../../packages/domain/src/conversation.js";
import { loadVoiceConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { VoiceController } from "./voice.js";

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

  constructor(
    private readonly database: Database,
    chatDirectory: string,
    voiceConfig: VoiceConfig,
  ) {
    this.codex = new CodexAppServer((method, params) => this.askApproval(method, params), chatDirectory);
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
    const oldThread = await this.database.ensureSession();
    await this.codex.start();
    this.threadId = await this.codex.startThread(oldThread);
    if (this.threadId !== oldThread) await this.database.setCodexThread(DEFAULT_SESSION_ID, this.threadId);
  }

  async close(): Promise<void> {
    for (const approval of this.approvals.values()) approval.answer("decline");
    for (const client of this.clients) client.destroy();
    await this.voice.cancel();
    await this.codex.close();
  }

  attach(client: Socket): void {
    this.clients.add(client);
    client.on("close", () => {
      this.clients.delete(client);
      if (this.clients.size === 0) {
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

  private async sendMessage(text: string): Promise<void> {
    if (this.state.phase !== "idle") throw new Error("请先停止当前回复");
    const voiceGeneration = this.voice.beginReply();
    this.state = transition(this.state, { type: "send" });
    const generation = this.state.generation;
    this.broadcast({ type: "status", status: "thinking" });
    try {
      const message = await this.database.addMessage(DEFAULT_SESSION_ID, "user", text);
      this.broadcast({ type: "message", message });
      if (this.state.phase !== "thinking" || this.state.generation !== generation) return;
      const reply = await this.codex.run(this.threadId, text, (delta) => {
        if (this.state.phase !== "thinking" || this.state.generation !== generation) return;
        this.state = transition(this.state, { type: "delta", generation, text: delta });
        this.broadcast({ type: "delta", turnId: String(generation), text: delta });
      });
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
