import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.env.VOIDMAKER_SHELL_SMOKE !== "1")(
  "switches sessions by clicking in real Quickshell, renders history/memories and ignores stale pages",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "voidmaker-history-shell-"));
    await copyFile("apps/shell/HistoryPanel.qml", join(dir, "HistoryPanel.qml"));
    await writeFile(
      join(dir, "shell.qml"),
      `import QtQuick
import Quickshell
import QtTest
ShellRoot {
 TestCase { id: clicks; when: false }
 FloatingWindow {
  visible: true; width: 520; height: 700
  HistoryPanel {
   id: panel; anchors.fill: parent; online: true; canEdit: true
   property int selected: 0
   onCommand: value => {
    if (value.type === "session_select") {
     if (value.id !== "other") throw new Error("wrong session selected")
     selected++
     receive({type:"snapshot",sessionId:value.id,character:{selectedId:"default"}})
    }
    if (value.type === "session_list") receive({type: value.type, requestId: value.requestId, characterId: "default", page: {items: [{id:"session", title:"Original", archived:false, revision:0},{id:"other",title:"Second",archived:false,revision:0}], next:null}})
    if (value.type === "history_list") receive({type: value.type, requestId: value.requestId, sessionId: panel.historySession, page: {items:[{id:"message", role:"user",text:"history fixture",createdAt:"today"}],next:null}})
    if (value.type === "memory_list") receive({type: value.type, requestId: value.requestId, sessionId:panel.sessionId, items:[{id:"memory",sessionId:null,text:"manual fact",enabled:true,revision:0}]})
   }
  }
  Timer { interval: 100; running: true; onTriggered: {
   panel.receive({type:"snapshot", sessionId:"session", character:{selectedId:"default"}})
   panel.receive({type:"session_list", requestId:"obsolete",characterId:"default",page:{items:[],next:null}})
   if (panel.sessions.length !== 2 || panel.history.length !== 1 || panel.memories.length !== 1) throw new Error("projection missing")

  } }
  Timer { interval: 220; running: true; onTriggered: {
   const button = clicks.findChild(panel, "select-session-other")
   if (!button || !button.enabled) throw new Error("session switch missing or disabled")
   clicks.mouseClick(button)
   if (panel.selected !== 1 || panel.sessionId !== "other") throw new Error("session click did not switch")
  } }
  Timer { interval: 350; running: true; onTriggered: {
   const current = clicks.findChild(panel, "select-session-other")
   if (!current || current.enabled || current.text !== "当前") throw new Error("current session not reflected in button")
   panel.currentSection = 1
  } }
  Timer { interval: 450; running: true; onTriggered: { panel.currentSection = 2 } }
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
