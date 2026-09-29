import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { clientCommand, PROTOCOL_VERSION, type ServerEvent } from "../packages/contracts/src/protocol.js";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";
import { compose, initialComposer, submission } from "../packages/domain/src/composer.js";
import { initialVoice } from "../packages/domain/src/voice.js";
import { offscreenShell } from "./helpers/shell.js";

it.skipIf(process.env.VOIDMAKER_SHELL_SMOKE !== "1")(
  "runs compact speech, native transcript editing, drafts and both layouts over real shell IPC",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "voidmaker-hmi-"));
    await cp("apps/shell", dir, { recursive: true });
    let composer = initialComposer;
    let voice = initialVoice(true, false);
    const commands: ReturnType<typeof clientCommand.parse>[] = [];
    const failures: string[] = [];
    const clients = new Set<Socket>();
    const timers: NodeJS.Timeout[] = [];
    const send = (socket: Socket, event: ServerEvent) => socket.write(`${JSON.stringify(event)}\n`);
    const project = (socket: Socket, requestId?: string) =>
      send(socket, {
        type: "composer",
        sessionId: "10000000-0000-4000-8000-000000000001",
        composer,
        ...(requestId ? { requestId } : {}),
      });
    const publishVoice = (socket: Socket) => {
      composer = compose(composer, { type: "voice", voice });
      project(socket);
      send(socket, { type: "voice", voice });
    };
    const server = createServer((socket) => {
      clients.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => clients.delete(socket));
      createInterface({ input: socket })
        .on("error", () => undefined)
        .on("line", (line) => {
          try {
            const command = clientCommand.parse(JSON.parse(line));
            commands.push(command);
            switch (command.type) {
              case "hello":
                send(socket, {
                  type: "settings",
                  settings: {
                    revision: "test",
                    config: voiceConfigSchema.parse({}),
                    busy: false,
                    error: "",
                    canRestore: false,
                  },
                });
                send(socket, {
                  type: "snapshot",
                  version: PROTOCOL_VERSION,
                  sessionId: "10000000-0000-4000-8000-000000000001",
                  status: "idle",
                  draft: "",
                  voice,
                  composer,
                  messages: [
                    { id: "u", role: "user", text: "今天先整理一下项目吧。", createdAt: "today" },
                    { id: "a", role: "assistant", text: "嗯，一起从最小的任务开始吧。", createdAt: "today" },
                  ],
                  character: {
                    selectedId: "fixture",
                    sessionId: "10000000-0000-4000-8000-000000000001",
                    changing: false,
                    warnings: [],
                    characters: [{ id: "fixture", name: "七海千秋", hasPortrait: true, hasVoice: false }],
                    presentation: {
                      state: "idle",
                      mouth: 0,
                      subtitle: "",
                      baseUrl: "",
                      imageUrl: process.env.VOIDMAKER_HMI_PORTRAIT
                        ? pathToFileURL(process.env.VOIDMAKER_HMI_PORTRAIT).href
                        : "",
                    },
                  },
                });
                break;
              case "voice_start":
                voice = { ...voice, phase: "listening", generation: voice.generation + 1 };
                publishVoice(socket);
                break;
              case "voice_finish":
                voice = { ...voice, phase: "transcribing" };
                publishVoice(socket);
                timers.push(
                  setTimeout(() => {
                    voice = { ...voice, phase: "review", transcript: "先整理项目文档。" };
                    publishVoice(socket);
                  }, 80),
                );
                break;
              case "composer_edit":
                composer = compose(composer, { ...command, type: "edit" });
                project(socket, command.requestId);
                break;
              case "composer_attach":
                composer = compose(composer, { type: "attach", id: command.id });
                project(socket);
                break;
              case "composer_resolve":
                composer = compose(composer, { ...command, type: "resolve" });
                project(socket);
                break;
              case "composer_send": {
                const value = submission(composer, command.source, command.generation);
                expect(value.text).toBe("修正后的转写");
                expect(value.desktopId).toBeNull();
                composer = compose(composer, { type: "consumed", submission: value });
                project(socket);
                voice = { ...voice, phase: "thinking", generation: voice.generation + 1 };
                publishVoice(socket);
                send(socket, { type: "status", status: "thinking" });
                send(socket, {
                  type: "message",
                  message: { id: "user", role: "user", text: value.text, createdAt: "today" },
                });
                timers.push(
                  setTimeout(() => {
                    send(socket, { type: "delta", turnId: "1", text: "嗯，已经记下了。" });
                    send(socket, {
                      type: "message",
                      message: { id: "reply", role: "assistant", text: "嗯，已经记下了。", createdAt: "today" },
                    });
                    voice = { ...voice, phase: "idle" };
                    publishVoice(socket);
                    send(socket, { type: "status", status: "idle" });
                  }, 150),
                );
                break;
              }
              case "stop":
                voice = { ...initialVoice(true, false), generation: voice.generation + 1, phase: "stopping" };
                publishVoice(socket);
                break;
            }
          } catch (error) {
            failures.push(String(error));
          }
        });
    });
    const socketPath = join(dir, "host.sock");
    server.listen(socketPath);
    await once(server, "listening");
    const captureDir = process.env.VOIDMAKER_HMI_CAPTURE_DIR ?? "";
    const checks = `
    property int checkStep: 0
    property int ticks: 0
    property bool capturing: false
    property string companionGeometry: ""
    function geometry() { return [window.width, window.height, art.x, art.y, art.width, art.height].join(",") }
    function separate(item) { return item.x >= art.x + art.width || item.x + item.width <= art.x || item.y >= art.y + art.height || item.y + item.height <= art.y }
    function insist(value, message) { if (!value) throw new Error(message) }
    function capture(name, after) {
        const folder = ${JSON.stringify(captureDir)}
        if (!folder) { if (after) after(); return }
        capturing = true
        stage.grabToImage(result => { result.saveToFile(folder + "/" + name + ".png"); capturing = false; if (after) after() })
    }
    TestCase { id: keys; when: false }
    Timer { interval: 100; running: true; repeat: true; onTriggered: {
      try {
        if (root.capturing) return
        if (++root.ticks > 150) throw new Error("HMI step timed out: " + root.checkStep)
        switch (root.checkStep) {
        case 0:
          if (!root.ready) return
          root.insist(!root.chatOpen && dock.visible && !compactTranscript.visible, "not compact at start")
          root.insist(Math.abs(dock.x + dock.width / 2 - art.x - art.width / 2) < 1, "dock is not centered under the character")
          root.capture("production-idle", () => { root.microphone(); root.checkStep++ }); break
        case 1:
          if (root.phase !== "listening") return
          root.insist(!root.chatOpen, "microphone expanded chat")
          root.microphone(); root.checkStep++; break
        case 2:
          if (!root.hasTranscript) return
          root.insist(compactTranscript.visible && !input.editor.activeFocus && !compactTranscript.editor.activeFocus, "transcription stole focus")
          root.insist(compactTranscript.x + compactTranscript.width < dock.x, "transcript is not left of dock")
          root.insist(compactTranscript.height >= 80, "collapsed transcript geometry")
          composer.edit("text", "保留的文字草稿"); composer.attach("fixture-image")
          compactTranscript.editor.selectAll(); compactTranscript.editor.remove(0, compactTranscript.editor.length)
          root.checkStep++; break
        case 3:
          if (composer.pendingText || composer.pendingTranscript || !composer.desktopId) return
          root.insist(root.hasTranscript && composer.transcript === "", "cleared transcript fell back to draft")
          root.submit("transcript")
          keys.mouseClick(compactTranscript.editor, 16, 12)
          compactTranscript.editor.insert(0, "修正后的转写")
          keys.keyClick(Qt.Key_Return, Qt.ShiftModifier)
          root.insist(compactTranscript.editor.text.includes("\\n"), "Shift+Enter did not insert newline")
          compactTranscript.editor.text = "修正后的转写"
          root.checkStep++; break
        case 4:
          if (composer.pendingTranscript) return
          root.insist(composer.transcript === "修正后的转写", "inline edit was lost")
          root.capture("production-transcript", () => {
            root.toggleChat(); root.toggleImmersive(); root.toggleImmersive()
            root.insist(root.companionExpanded && composer.transcript === "修正后的转写", "layout switch lost state")
            root.toggleChat(); root.checkStep++
          }); break
        case 5:
          keys.mouseClick(compactTranscript.editor, 18, 14)
          keys.keyClick(Qt.Key_Return)
          root.checkStep++; break
        case 6:
          if (root.status !== "idle" || !root.reply) return
          root.insist(!root.chatOpen && !root.hasTranscript, "compact reply expanded or kept sent transcript")
          root.insist(composer.text === "保留的文字草稿" && composer.desktopId === "fixture-image", "sent the wrong draft or attachment")
          root.insist(replyBubble.visible && replyBubble.text === "嗯，已经记下了。", "reply did not reach bubble")
          root.capture("production-reply")
          root.checkStep++; break
        case 7:
          root.toggleChat(); root.checkStep++; break
        case 8:
          root.insist(root.separate(chat), "expanded text card covers character")
          root.capture("production-expanded", () => { root.toggleImmersive(); root.checkStep++ }); break
        case 9:
          root.capture("production-immersive"); root.checkStep++; break
        case 10:
          conversation.followTail = false
          root.receive(JSON.stringify({type: "delta", turnId: "2", text: "追加消息"}))
          root.insist(!conversation.followTail, "new content forced old history to bottom")
          root.openPage("work"); root.insist(drawer.visible, "work drawer did not open")
          root.openPage("settings"); root.insist(settingsPanel.visible, "settings drawer did not open")
          root.checkStep++; break
        case 11:
          root.insist(drawer.x >= art.x + art.width || drawer.x + drawer.width <= art.x || drawer.y + drawer.height <= art.y, "drawer covers character")
          root.immersive = false; root.openPage("history"); root.checkStep++; break
        case 12:
          root.insist(drawer.x + drawer.width <= art.x, "companion drawer covers character")
          root.companionGeometry = root.geometry()
          root.togglePage("history"); root.checkStep++; break
        case 13:
          root.insist(!drawer.visible && root.geometry() === root.companionGeometry, "closing history moved character")
          keys.mouseClick(dockWork, 18, 18); root.checkStep++; break
        case 14:
          root.insist(drawer.visible && dockWork.selected && root.geometry() === root.companionGeometry, "work button did not highlight or moved character")
          keys.mouseClick(dockWork, 18, 18); root.checkStep++; break
        case 15:
          root.insist(!drawer.visible && !dockWork.selected && root.geometry() === root.companionGeometry, "second work click did not close panel cleanly")
          root.togglePage("desktop"); root.checkStep++; break
        case 16:
          root.insist(drawer.visible && root.separate(drawer) && root.geometry() === root.companionGeometry, "desktop panel moved or covered character")
          keys.mouseClick(dockChat, 18, 18); window.implicitWidth = 390; root.checkStep++; break
        case 17:
          root.insist(chat.visible && chat.height > 250 && root.separate(chat), "narrow text card covers character")
          root.capture("production-narrow-expanded")
          root.companionGeometry = root.geometry()
          keys.mouseClick(dockWork, 18, 18); root.checkStep++; break
        case 18:
          root.insist(root.separate(drawer) && dockWork.selected && root.geometry() === root.companionGeometry, "narrow drawer covers or moves character")
          keys.mouseClick(dockWork, 18, 18); root.checkStep++; break
        case 19:
          root.insist(!drawer.visible && chat.visible && !dockWork.selected, "narrow drawer did not return to text card")
          root.setVisibility(false)
          console.log("HMI_PASSED"); Qt.quit(); break
        }
      } catch (error) { console.log("HMI_FAILED: " + error); Qt.quit() }
    } }
`;
    const source = offscreenShell(await readFile(join(dir, "shell.qml"), "utf8"))
      .replace("import QtQuick\n", "import QtQuick\nimport QtTest\n")
      .replace(/}\s*$/, `${checks}\n}`);
    await writeFile(join(dir, "shell.qml"), source);
    let log = "";
    const child = spawn("quickshell", ["--path", join(dir, "shell.qml")], {
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen", XDG_RUNTIME_DIR: dir, VOIDMAKER_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      log += data;
    });
    child.stderr.on("data", (data) => {
      log += data;
    });
    try {
      await expect.poll(() => log, { timeout: 20_000 }).toMatch(/HMI_PASSED|HMI_FAILED|Failed to load/);
      expect(log).toContain("HMI_PASSED");
      expect(log).not.toMatch(/HMI_FAILED|ReferenceError|TypeError|Failed to load|Cannot assign|Binding loop/);
      expect(failures).toEqual([]);
      expect(commands.filter((command) => command.type === "composer_send")).toHaveLength(1);
      expect(commands.filter((command) => command.type === "stop")).toHaveLength(1);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
      }
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
  25_000,
);
