import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.env.VOIDMAKER_SHELL_SMOKE !== "1")(
  "moves permission switches, keeps their colors without focus, and reflects host revocation and save failure",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "voidmaker-desktop-switch-"));
    await cp("apps/shell", dir, { recursive: true });
    await writeFile(
      join(dir, "shell.qml"),
      `import QtQuick
import QtQuick.Window
import QtTest
import Quickshell
ShellRoot {
    id: root
    property int step: 0
    property var command: null
    property var commands: []
    property bool failSave: false
    property var activeColors: []
    property real offX: 0
    property real onX: 0
    function insist(value, message) { if (!value) throw new Error(message) }
    function control(name) { return keys.findChild(panel, name) }
    function thumb(toggle) { return keys.findChild(toggle, "switchThumb") }
    function colors(toggle) { return [String(toggle.indicator.color), String(thumb(toggle).color), String(toggle.contentItem.color), toggle.opacity].join(",") }
    function project(changes) { panel.snapshot = Object.assign({}, panel.snapshot, changes) }
    function request(value) { commands.push(value); command = value; project({busy: true}); response.start() }
    TestCase { id: keys; when: false }
    Window {
        id: window; visible: true; width: 560; height: 1100; color: "#231f2b"
        DesktopPanel {
            id: panel; anchors.fill: parent; online: true
            snapshot: ({revision: 0, grants: {window: 0, media: 0, region: 0},
                policy: {proactive: false, allDay: false, intervalSeconds: 300, startHour: 9, endHour: 22, excludedApps: []},
                observations: [], busy: false, pauseReason: "", error: "", suggestion: "", nextCheckAt: 0})
            onCommand: value => root.request(value)
        }
    }
    Window { id: other; visible: false; width: 100; height: 100 }
    Timer { id: response; interval: 80; onTriggered: {
        if (root.failSave) {
            root.project({busy: false, grants: {window: 0, media: 0, region: 0}, error: "save failed"})
            return
        }
        const value = root.command
        if (value.type === "desktop_policy") root.project({busy: false, policy: value.policy})
        else {
            const grants = Object.assign({}, panel.snapshot.grants)
            grants[value.source] = value.type === "desktop_grant" ? -1 : 0
            root.project({busy: false, grants: grants})
        }
    } }
    Timer { interval: 350; running: true; repeat: true; onTriggered: {
        try {
            const permission = root.control("persistentGrant-window")
            const media = root.control("persistentGrant-media")
            const region = root.control("persistentGrant-region")
            const proactive = root.control("proactiveSwitch")
            const allDay = root.control("allDaySwitch")
            switch (root.step++) {
            case 0:
                root.insist(permission && media && region && proactive, "missing switch")
                root.insist(!permission.checked, "initial grant is not off")
                root.offX = root.thumb(permission).x
                window.requestActivate()
                keys.mouseClick(permission, 15, permission.height / 2); break
            case 1:
                root.insist(permission.checked && root.thumb(permission).x > root.offX + 12, "enabled thumb did not move right")
                root.insist(root.thumb(permission).color !== permission.indicator.color, "thumb blends into enabled rail")
                root.insist(root.commands[0].source === "window" && root.commands[0].persistent === true, "wrong grant command")
                root.activeColors = root.colors(permission); root.onX = root.thumb(permission).x
                other.visible = true; other.requestActivate(); break
            case 2:
                root.insist(!window.active && other.active, "focus transfer failed")
                root.insist(root.colors(permission) === root.activeColors && root.thumb(permission).x === root.onX, "inactive window dimmed or moved the switch")
                window.requestActivate()
                keys.mouseClick(permission, 15, permission.height / 2); break
            case 3:
                root.insist(!permission.checked && root.thumb(permission).x === root.offX, "second click did not move left")
                root.insist(root.commands[1].type === "desktop_revoke", "missing revoke command")
                permission.forceActiveFocus(); keys.keyClick(Qt.Key_Space); break
            case 4:
                root.insist(permission.checked && root.thumb(permission).x === root.onX, "keyboard toggle failed")
                root.project({grants: {window: 0, media: 0, region: 0}}); break
            case 5:
                root.insist(!permission.checked && root.thumb(permission).x === root.offX, "host revocation did not reset switch")
                keys.mouseClick(media, 15, media.height / 2); break
            case 6:
                root.insist(media.checked && root.command.source === "media", "media grant failed")
                keys.mouseClick(region, 15, region.height / 2); break
            case 7:
                root.insist(region.checked && root.command.source === "region", "region grant failed")
                keys.mouseClick(proactive, 15, proactive.height / 2); break
            case 8:
                root.insist(proactive.checked && root.command.type === "desktop_policy" && root.command.policy.proactive, "proactive switch failed")
                keys.mouseClick(proactive, 15, proactive.height / 2); break
            case 9:
                root.insist(!proactive.checked && !root.command.policy.proactive, "proactive switch did not turn off")
                root.failSave = true; keys.mouseClick(permission, 15, permission.height / 2); break
            case 10:
                root.insist(!permission.checked && root.thumb(permission).x === root.offX && panel.snapshot.error === "save failed", "failed save left a false enabled state")
                root.failSave = false; allDay.forceActiveFocus(); keys.keyClick(Qt.Key_Space); break
            case 11:
                root.insist(allDay.checked && root.command.policy.allDay, "all-day option did not persist")
                keys.keyClick(Qt.Key_Space); break
            case 12:
                root.insist(!allDay.checked && !root.command.policy.allDay, "all-day option did not turn off")
                panel.online = false
                const count = root.commands.length
                keys.mouseClick(permission, 15, permission.height / 2)
                root.insist(root.commands.length === count && !permission.enabled && permission.opacity < 1, "offline switch still accepts input")
                console.log("DESKTOP_SWITCH_PASSED"); Qt.quit(); break
            }
        } catch (error) { console.log("DESKTOP_SWITCH_FAILED", error); Qt.quit() }
    } }
}
`,
    );
    let log = "";
    const child = spawn("quickshell", ["--path", join(dir, "shell.qml")], {
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      log += data;
    });
    child.stderr.on("data", (data) => {
      log += data;
    });
    try {
      await expect
        .poll(() => log, { timeout: 8000 })
        .toMatch(/DESKTOP_SWITCH_PASSED|DESKTOP_SWITCH_FAILED|Failed to load/);
      expect(log).toContain("DESKTOP_SWITCH_PASSED");
      expect(log).not.toMatch(
        /DESKTOP_SWITCH_FAILED|ReferenceError|TypeError|Failed to load|Cannot assign|Binding loop/,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
  12000,
);
