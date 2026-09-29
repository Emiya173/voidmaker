import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";
import { offscreenShell } from "./helpers/shell.js";

it.skipIf(process.env.VOIDMAKER_SHELL_SMOKE !== "1")(
  "opens tray destinations in the real shell without losing unsaved settings",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "voidmaker-tray-navigation-"));
    await cp("apps/shell", dir, { recursive: true });
    // Offscreen Qt has no layer-shell backend. Keep the real views and handlers,
    // substituting only the window container and compositor-specific properties.
    const source = offscreenShell(await readFile(join(dir, "shell.qml"), "utf8"));
    const checks = `
    Timer { interval: 100; running: true; onTriggered: {
        settingsPanel.receive({type: "settings", settings: {revision: "test", config: ${JSON.stringify(voiceConfigSchema.parse({}))}, busy: false, error: "", canRestore: false}})
        settingsPanel.dirty = true
        const pages = {chat: 0, desktop: 1, work: 2, history: 3, settings: 4, diagnostics: 4}
        for (const page of Object.keys(pages)) {
            root.setVisibility(false)
            root.receive(JSON.stringify({type: "shell_visibility", action: "show", page: page}))
            if (!root.interfaceVisible || (page === "chat" ? !root.companionExpanded || root.drawerPage !== "" : root.drawerPage !== (page === "diagnostics" ? "settings" : page))) throw new Error("Wrong destination: " + page)
            if (page === "settings" && settingsPanel.currentSection !== 0) throw new Error("Wrong config tab")
            if (page === "diagnostics" && settingsPanel.currentSection !== 1) throw new Error("Wrong diagnostics tab")
        }
        if (!settingsPanel.dirty) throw new Error("Discarded unsaved settings")
        root.receive(JSON.stringify({type: "shell_visibility", action: "toggle"}))
        if (root.interfaceVisible) throw new Error("Failed to hide")
        root.receive(JSON.stringify({type: "shell_visibility", action: "show", page: "invalid"}))
        if (root.interfaceVisible) throw new Error("Accepted unknown destination")
        console.log("TRAY_NAVIGATION_PASSED")
        Qt.quit()
    } }
`;
    await writeFile(join(dir, "shell.qml"), source.replace(/}\s*$/, `${checks}\n}`));
    let log = "";
    const child = spawn("quickshell", ["--path", join(dir, "shell.qml")], {
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen", VOIDMAKER_SOCKET: join(dir, "missing.sock") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => {
      log += data;
    });
    child.stderr.on("data", (data) => {
      log += data;
    });
    try {
      await expect.poll(() => log, { timeout: 5000 }).toContain("TRAY_NAVIGATION_PASSED");
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
