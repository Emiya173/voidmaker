import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openAecSession } from "../../../packages/adapters/src/aec-session.js";
import { inspectArtifact, projectPath } from "../../../packages/adapters/src/artifacts.js";
import { captureAudio, playAudio } from "../../../packages/adapters/src/audio-process.js";
import { type Character, type CharacterCatalog, loadCharacters } from "../../../packages/adapters/src/characters.js";
import { CodexAppServer } from "../../../packages/adapters/src/codex.js";
import { Database } from "../../../packages/adapters/src/database.js";
import { desktopAdapters } from "../../../packages/adapters/src/desktop.js";
import { suggestDesktop } from "../../../packages/adapters/src/desktop-codex.js";
import { DesktopStore } from "../../../packages/adapters/src/desktop-store.js";
import { inspectAec, inspectDevices, inspectModel } from "../../../packages/adapters/src/diagnostics.js";
import { HistoryStore } from "../../../packages/adapters/src/history-store.js";
import { synthesize, transcribe } from "../../../packages/adapters/src/speech-http.js";
import { TrayService } from "../../../packages/adapters/src/tray.js";
import { WorkStore } from "../../../packages/adapters/src/work-store.js";
import {
  type ClientCommand,
  clientCommand,
  PROTOCOL_VERSION,
  type ServerEvent,
} from "../../../packages/contracts/src/protocol.js";
import type { SettingsSnapshot } from "../../../packages/contracts/src/settings.js";
import type { VoiceConfig } from "../../../packages/contracts/src/voice.js";
import { characterInstructions } from "../../../packages/domain/src/character.js";
import { type ConversationState, initialConversation, transition } from "../../../packages/domain/src/conversation.js";
import { contextPrompt } from "../../../packages/domain/src/desktop.js";
import { memoryInstructions } from "../../../packages/domain/src/memory.js";
import { CharacterController } from "./character.js";
import { voiceSettingsStore } from "./config.js";
import { DesktopController } from "./desktop.js";
import { DiagnosticsController } from "./diagnostics.js";
import { migrate } from "./migrate.js";
import { SettingsController } from "./settings.js";
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
  private readonly character: CharacterController;
  private readonly history = new HistoryStore(process.env.DATABASE_URL);
  private readonly codex: CodexAppServer;
  private voice: VoiceController;
  private readonly settings: SettingsController;
  private readonly diagnostics = new DiagnosticsController((diagnostics) =>
    this.broadcast({ type: "diagnostics", diagnostics }),
  );
  private readonly tray = new TrayService((action) => {
    if (action.type === "stop") {
      void this.stop().catch((error: unknown) =>
        this.broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) }),
      );
    } else if (action.type === "open") {
      this.broadcast({ type: "shell_visibility", action: "show", page: action.page });
    } else {
      this.broadcast({ type: "shell_visibility", action: "toggle" });
    }
  });
  private readonly work: WorkManager;
  private readonly desktop: DesktopController;
  private readonly desktopStore = new DesktopStore(process.env.DATABASE_URL);
  private readonly presence = new Map<Socket, boolean>();
  private desktopReplyGeneration: number | null = null;

  constructor(
    private readonly database: Database,
    chatDirectory: string,
    settings: SettingsSnapshot,
    characters: CharacterCatalog,
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
    this.character = new CharacterController(characters, {
      idle: () =>
        !this.settings.snapshot.busy &&
        this.state.phase === "idle" &&
        this.voice.snapshot.phase === "idle" &&
        !this.voice.snapshot.continuous,
      prepare: async (character, signal, selectedSession) => {
        const sessionId = selectedSession ?? (await this.database.characterSession(character.id, character.revision));
        await this.history.session(character, sessionId, true);
        return { sessionId, threadId: await this.prepareThread(character, sessionId, signal) };
      },
      persist: (id, binding) => {
        const character = characters.entries.find((entry) => entry.id === id);
        if (!character) throw new Error("角色不存在");
        return this.history.select(character, binding.sessionId);
      },
      publish: () => this.publishCharacter(),
    });
    this.desktop = new DesktopController(join(dirname(socketPath), "desktop"), {
      adapters: desktopAdapters(),
      store: this.desktopStore,
      publish: (desktop) => this.broadcast({ type: "desktop", desktop }),
      present: () => [...this.presence.values()].some((idle) => !idle),
      idle: () => !this.character.changing && this.state.phase === "idle" && this.voice.snapshot.phase === "idle",
      suggest: (context, signal) => suggestDesktop(chatDirectory, context, signal),
      revoked: () => {
        if (this.desktopReplyGeneration === this.state.generation) void this.stop();
      },
    });
    this.voice = this.createVoice(settings.config);
    this.settings = new SettingsController(settings, voiceSettingsStore(), {
      idle: () =>
        !this.character.changing &&
        this.state.phase === "idle" &&
        this.voice.snapshot.phase === "idle" &&
        !this.voice.snapshot.continuous,
      prepare: () => this.voice.cancel(),
      apply: (config) => {
        this.voice = this.createVoice(config);
        this.diagnostics.clear();
        this.broadcast({ type: "voice", voice: this.voice.snapshot });
        this.publishCharacter();
      },
      publish: (settings) => this.broadcast({ type: "settings", settings }),
    });
  }

  private createVoice(voiceConfig: VoiceConfig): VoiceController {
    const controller = new VoiceController(
      {
        capture: (signal, onLevel) => captureAudio(voiceConfig, signal, onLevel),
        transcribe: (wav, signal) => {
          if (!voiceConfig.asr) throw new Error("未配置 ASR");
          return transcribe(wav, voiceConfig.asr, signal);
        },
        synthesize: (text, signal) => {
          if (!voiceConfig.tts) throw new Error("未配置 TTS");
          return synthesize(text, { ...voiceConfig.tts, ...this.character.current.voice }, signal);
        },
        play: (wav, signal, onProgress) =>
          playAudio(
            wav,
            signal,
            onProgress,
            (voiceConfig.aec?.outputTarget ?? voiceConfig.outputTarget)
              ? { outputTarget: (voiceConfig.aec?.outputTarget ?? voiceConfig.outputTarget) as string }
              : {},
          ),
        ...(voiceConfig.aec ? { openSession: (signal: AbortSignal) => openAecSession(voiceConfig, signal) } : {}),
        submit: (text) => this.sendMessage(text),
        publish: (voice) => {
          if (this.voice !== controller) return;
          this.broadcast({ type: "voice", voice });
          this.publishCharacter();
        },
      },
      Boolean(voiceConfig.asr),
      Boolean(voiceConfig.tts),
      Boolean(voiceConfig.aec?.bargeIn),
    );
    return controller;
  }

  async start(): Promise<void> {
    this.tray.start();
    await this.work.start();
    await this.desktop.start();
    await this.codex.start();
    const selected = await this.database.selectedCharacter();
    await this.character.select(
      this.character.catalog.entries.some((entry) => entry.id === selected) ? selected : "default",
    );
  }

  async close(): Promise<void> {
    this.tray.close();
    this.diagnostics.cancel(false);
    await this.settings.close();
    await this.character.close();
    await this.history.close();
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
    if (!parsed.success)
      throw new Error(
        "无效或不兼容的命令: " +
          parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("；"),
      );
    const command = parsed.data;
    switch (command.type) {
      case "settings_get":
        this.send(client, { type: "settings", settings: this.settings.snapshot });
        this.send(client, { type: "diagnostics", diagnostics: this.diagnostics.snapshot });
        return;
      case "settings_save":
        await this.settings.change({ type: "save", revision: command.revision, config: command.config });
        this.send(client, { type: "settings_applied" });
        return;
      case "settings_restore":
        await this.settings.change({ type: "restore", revision: command.revision });
        this.send(client, { type: "settings_applied" });
        return;
      case "settings_reload":
        await this.settings.change({ type: "reload" });
        return;
      case "diagnostics_start":
        this.checkServices();
        return;
      case "diagnostics_cancel":
        this.diagnostics.cancel();
        return;
      case "session_list":
      case "session_create":
      case "session_select":
      case "session_rename":
      case "session_archive":
      case "session_delete":
      case "history_list":
      case "memory_list":
      case "memory_save":
      case "memory_delete":
        await this.handleHistory(client, command);
        return;
      case "hello": {
        this.send(client, { type: "settings", settings: this.settings.snapshot });
        this.send(client, { type: "diagnostics", diagnostics: this.diagnostics.snapshot });
        this.send(client, { type: "desktop", desktop: this.desktop.snapshot });
        await this.sendSnapshot(client);
        for (const [requestId, approval] of this.approvals) {
          this.send(client, { type: "approval", requestId, description: approval.description });
        }
        this.send(client, { type: "work_list", ...(await this.work.store.list()) });
        return;
      }
      case "character_select": {
        await this.character.select(command.id);
        await Promise.all([...this.clients].map((connection) => this.sendSnapshot(connection)));
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
        if (this.character.changing || this.settings.snapshot.busy) throw new Error("正在更新对话上下文或设置，请稍候");
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

  private checkServices(): void {
    if (this.settings.snapshot.busy) throw new Error("设置正在保存，请稍候");
    const config = this.settings.snapshot.config;
    let reading: ReturnType<typeof inspectDevices> | undefined;
    const devices = (signal: AbortSignal) => (reading ??= inspectDevices(signal));
    this.diagnostics.start(
      [
        {
          id: "database",
          label: "PostgreSQL",
          run: async () => {
            await this.database.check();
            return { id: "database", label: "PostgreSQL", status: "ready", detail: "只读连通检查通过" };
          },
        },
        {
          id: "codex",
          label: "Codex",
          run: async () => ({
            id: "codex",
            label: "Codex",
            status: this.codex.connected ? "reachable" : "error",
            detail: this.codex.connected ? "聊天进程在线；未验证登录或发起模型请求" : "聊天进程离线，需要重启 Host",
          }),
        },
        ...(["asr", "tts"] as const).map((id) => ({
          id,
          label: id.toUpperCase(),
          run: (signal: AbortSignal) => inspectModel(id, config, signal),
        })),
        { id: "aec", label: "AEC 插件", run: () => inspectAec(config) },
        {
          id: "routing",
          label: "设备选择",
          run: async (signal) => {
            const found = await devices(signal);
            const input = config.inputTarget,
              output = config.aec?.outputTarget ?? config.outputTarget;
            if (input && !found.some((d) => d.kind === "input" && d.name === input))
              throw new Error("指定麦克风不在线，请从设备列表重新选择");
            if (output && !found.some((d) => d.kind === "output" && d.name === output))
              throw new Error("指定播放设备不在线，请从设备列表重新选择");
            if (config.asr && !found.some((d) => d.kind === "input")) throw new Error("未发现输入设备");
            if (config.tts && !found.some((d) => d.kind === "output")) throw new Error("未发现输出设备");
            return {
              id: "routing",
              label: "设备选择",
              status: "reachable",
              detail: "已指定设备均在线；默认路由及实际音质未验证",
            };
          },
        },
        { id: "tray", label: "系统托盘", run: async () => this.tray.status },
      ],
      devices,
    );
  }

  private async prepareThread(character: Character, sessionId: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const oldThread = await this.database.ensureSession(sessionId);
    const memories = await this.history.memories(character, sessionId);
    signal?.throwIfAborted();
    const threadId = await this.codex.startThread(
      oldThread,
      characterInstructions(character.name, character.persona) + memoryInstructions(memories, sessionId),
    );
    signal?.throwIfAborted();
    if (threadId !== oldThread) await this.database.setCodexThread(sessionId, threadId);
    return threadId;
  }

  private async handleHistory(client: Socket, command: ClientCommand): Promise<boolean> {
    const scope = this.character.current;
    const binding = this.character.binding;
    const send = (event: ServerEvent) => {
      if (scope === this.character.current && binding === this.character.binding) this.send(client, event);
    };
    switch (command.type) {
      case "session_list":
        send({
          type: "session_list",
          requestId: command.requestId,
          characterId: scope.id,
          page: await this.history.list(scope, command.archived, command.query, command.before),
        });
        return true;
      case "history_list":
        send({
          type: "history_list",
          requestId: command.requestId,
          sessionId: command.sessionId,
          page: await this.history.messages(scope, command.sessionId, command.query, command.before),
        });
        return true;
      case "memory_list":
        send({
          type: "memory_list",
          requestId: command.requestId,
          sessionId: command.sessionId,
          items: await this.history.memories(scope, command.sessionId),
        });
        return true;
      case "session_create":
        await this.character.select(scope.id, () => this.history.create(scope, command.title));
        break;
      case "session_select":
        await this.character.select(scope.id, command.id);
        break;
      case "session_rename":
      case "session_archive":
      case "session_delete":
        await this.character.edit(async (signal) => {
          signal.throwIfAborted();
          await this.history.change(
            scope,
            command.id,
            command.revision,
            command.type === "session_rename"
              ? { title: command.title }
              : command.type === "session_archive"
                ? { archived: command.archived }
                : { delete: true },
          );
        });
        break;
      case "memory_save":
      case "memory_delete":
        await this.character.edit(async (signal) => {
          signal.throwIfAborted();
          if (command.sessionId !== binding.sessionId) throw new Error("会话已切换，请刷新记忆");
          await this.history.saveMemory(
            scope,
            command.sessionId,
            command.type === "memory_delete" ? { id: command.id, revision: command.revision, delete: true } : command,
          );
        });
        break;
      default:
        return false;
    }
    if (command.type === "session_create" || command.type === "session_select")
      await Promise.all([...this.clients].map((connection) => this.sendSnapshot(connection)));
    else this.broadcast({ type: "library_changed" });
    return true;
  }

  private async sendMessage(text: string, desktopId?: string): Promise<void> {
    if (this.character.changing || this.settings.snapshot.busy) throw new Error("正在更新对话上下文或设置，请稍候");
    if (this.state.phase !== "idle") throw new Error("请先停止当前回复");
    const binding = this.character.binding;
    const character = this.character.current;
    const voiceGeneration = this.voice.beginReply();
    this.state = transition(this.state, { type: "send" });
    const generation = this.state.generation;
    if (desktopId) this.desktopReplyGeneration = generation;
    this.broadcast({ type: "status", status: "thinking" });
    try {
      const oldThread = await this.database.ensureSession(binding.sessionId);
      const threadId = oldThread ?? (await this.prepareThread(character, binding.sessionId));
      if (this.state.phase !== "thinking" || this.state.generation !== generation) return;
      const shared = desktopId ? await this.desktop.share(desktopId) : undefined;
      shared?.signal.throwIfAborted();
      if (this.state.phase !== "thinking" || this.state.generation !== generation) return;
      const prompt = shared ? contextPrompt(text, shared.context) : text;
      const message = await this.database.addMessage(
        binding.sessionId,
        "user",
        shared ? `${text}\n\n[附带桌面上下文]\n${shared.context}` : text,
      );
      this.broadcast({ type: "message", message });
      if (this.state.phase !== "thinking" || this.state.generation !== generation) return;
      const reply = await this.codex.run(
        threadId,
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
        const assistantMessage = await this.database.addMessage(binding.sessionId, "assistant", reply);
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

  private publishCharacter(): void {
    this.broadcast({
      type: "character",
      character: this.character.snapshot(this.voice.snapshot, this.state.phase === "thinking"),
    });
  }

  private async sendSnapshot(client: Socket): Promise<void> {
    const binding = this.character.binding;
    const messages = await this.database.listMessages(binding.sessionId);
    if (binding !== this.character.binding) return this.sendSnapshot(client);
    this.send(client, {
      type: "snapshot",
      version: PROTOCOL_VERSION,
      sessionId: binding.sessionId,
      messages,
      status: this.state.phase,
      draft: this.state.phase === "thinking" ? this.state.draft : "",
      voice: this.voice.snapshot,
      character: this.character.snapshot(this.voice.snapshot, this.state.phase === "thinking"),
    });
  }

  private broadcast(event: ServerEvent): void {
    for (const client of this.clients) this.send(client, event);
    // Voice can finish before the conversation does; publish the final idle projection too.
    if (event.type === "status") this.publishCharacter();
  }
}

async function main(): Promise<void> {
  if (await socketIsActive(socketPath)) throw new Error(`Host 已运行: ${socketPath}`);
  await migrate(process.env.DATABASE_URL);
  const chatDirectory = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "voidmaker", "chat");
  await mkdir(chatDirectory, { recursive: true, mode: 0o700 });
  const database = new Database(process.env.DATABASE_URL);
  const host = new Host(database, chatDirectory, await voiceSettingsStore().load(), await loadCharacters());
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
