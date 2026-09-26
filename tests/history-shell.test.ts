import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.env.VOIDMAKER_SHELL_SMOKE !== "1")(
  "renders session/history/memory lists in real Quickshell and ignores stale pages",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "voidmaker-history-shell-"));
    await copyFile("apps/shell/HistoryPanel.qml", join(dir, "HistoryPanel.qml"));
    await writeFile(
      join(dir, "shell.qml"),
      `import QtQuick
import Quickshell
ShellRoot {
 FloatingWindow {
  visible: true; width: 520; height: 700
  HistoryPanel {
   id: panel; anchors.fill: parent; online: true; canEdit: true
   onCommand: value => {
    if (value.type === "session_list") receive({type: value.type, requestId: value.requestId, characterId: "default", page: {items: [{id:"session", title:"Original", archived:false, revision:0}], next:null}})
    if (value.type === "history_list") receive({type: value.type, requestId: value.requestId, sessionId: "session", page: {items:[{id:"message", role:"user",text:"history fixture",createdAt:"today"}],next:null}})
    if (value.type === "memory_list") receive({type: value.type, requestId: value.requestId, sessionId:"session", items:[{id:"memory",sessionId:null,text:"manual fact",enabled:true,revision:0}]})
   }
  }
  Timer { interval: 100; running: true; onTriggered: {
   panel.receive({type:"snapshot", sessionId:"session", character:{selectedId:"default"}})
   panel.receive({type:"session_list", requestId:"obsolete",characterId:"default",page:{items:[],next:null}})
   if (panel.sessions.length !== 1 || panel.history.length !== 1 || panel.memories.length !== 1) throw new Error("projection missing")
   panel.currentSection = 1
  } }
  Timer { interval: 300; running: true; onTriggered: { panel.currentSection = 2 } }
  Timer { interval: 600; running: true; onTriggered: { console.log("HISTORY_RENDERED"); Qt.quit() } }
 }
}`,
    );
    let log = "";
    const child = spawn("quickshell", ["--path", join(dir, "shell.qml")], {
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      log += data.toString();
    });
    child.stderr.on("data", (data) => {
      log += data.toString();
    });
    try {
      await expect.poll(() => log, { timeout: 5000 }).toContain("HISTORY_RENDERED");
      expect(log).not.toMatch(/ReferenceError|TypeError|Error:|Failed to load|Cannot assign|Binding loop/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
      }
      await rm(dir, { recursive: true });
    }
  },
  10000,
);
