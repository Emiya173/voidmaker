import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.env.VOIDMAKER_SHELL_SMOKE !== "1")(
  "keeps host draft updates out of user edits and sends the visible text with Enter",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "voidmaker-text-entry-"));
    await cp("apps/shell", dir, { recursive: true });
    await writeFile(
      join(dir, "shell.qml"),
      `import QtQuick
import QtQuick.Window
import QtTest
import Quickshell
ShellRoot {
    id: root
    property string draft: ""
    property int edits: 0
    property var sent: []
    property int step: 0
    function insist(value, message) { if (!value) throw new Error(message) }
    TestCase { id: keys; when: false }
    Window {
        id: window; visible: true; width: 420; height: 240
        TextEntry {
            id: input; anchors.fill: parent; value: root.draft
            onEdited: value => { root.edits++; root.draft = value }
            onSubmitted: { root.sent.push(root.draft); root.draft = "" }
        }
        TextEdit { id: clipboard; visible: false }
    }
    Timer { interval: 100; running: true; repeat: true; onTriggered: {
        try {
            switch (root.step++) {
            case 0:
                window.requestActivate(); input.focusEditor()
                root.draft = "第一行\\r\\n第二行"
                break
            case 1:
                root.insist(root.edits === 0, "host projection emitted a user edit")
                keys.keyClick(Qt.Key_Return)
                root.insist(root.sent.length === 1 && root.sent[0] === "第一行\\r\\n第二行", "Return did not send the projected draft")
                root.insist(root.edits === 0 && input.editor.text === "", "clearing sent text emitted an edit or retained text")
                clipboard.text = "中文输入和粘贴"; clipboard.selectAll(); clipboard.copy()
                keys.keyClick(Qt.Key_V, Qt.ControlModifier)
                break
            case 2:
                root.insist(root.draft === "中文输入和粘贴" && root.edits === 1, "paste did not update the draft once")
                keys.keyClick(Qt.Key_Return, Qt.ShiftModifier)
                keys.keyClick(Qt.Key_X)
                root.insist(root.sent.length === 1 && root.draft === "中文输入和粘贴\\nx", "Shift+Return did not preserve a multiline draft")
                keys.keyClick(Qt.Key_Z, Qt.ControlModifier)
                root.insist(input.editor.canRedo && root.draft === input.editor.text && root.draft !== "中文输入和粘贴\\nx", "draft synchronization broke undo")
                input.editor.redo()
                root.insist(root.draft === "中文输入和粘贴\\nx", "draft synchronization broke redo")
                keys.keyClick(Qt.Key_Enter)
                root.insist(root.sent.length === 2 && root.sent[1] === "中文输入和粘贴\\nx" && input.editor.text === "", "keypad Enter did not send and clear the draft")
                console.log("TEXT_ENTRY_PASSED"); Qt.quit(); break
            }
        } catch (error) { console.log("TEXT_ENTRY_FAILED", error); Qt.quit() }
    } }
}`,
    );
    let log = "";
    const child = spawn("quickshell", ["--path", join(dir, "shell.qml")], {
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen", XDG_RUNTIME_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      log += data;
    });
    child.stderr.on("data", (data) => {
      log += data;
    });
    try {
      await expect.poll(() => log, { timeout: 10_000 }).toMatch(/TEXT_ENTRY_PASSED|TEXT_ENTRY_FAILED|Failed to load/);
      expect(log).toContain("TEXT_ENTRY_PASSED");
      expect(log).not.toMatch(/TEXT_ENTRY_FAILED|ReferenceError|TypeError|Failed to load|Binding loop/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
