import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.env.VOIDMAKER_QML_SMOKE !== "1")(
  "resets actual QML joints and expressions across offline, hidden, resumed and replaced avatars",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "voidmaker-motion-"));
    try {
      const qml = (await readFile(new URL("helpers/character-motion.qml", import.meta.url), "utf8")).replace(
        '"APP_SHELL"',
        JSON.stringify(new URL("../apps/shell", import.meta.url).href),
      );
      const path = join(root, "Motion.qml");
      await writeFile(path, qml);
      const result = await promisify(execFile)("quickshell", ["--path", path], {
        env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software" },
        timeout: 15_000,
      });
      // Software rendering intentionally skips GPU display; this exercises real
      // QML bindings/animations/Skin nodes, separately from visible Qt acceptance.
      const log = result.stdout + result.stderr;
      expect(log).toContain("MOTION_PROBE_OK");
      expect(log).not.toContain("MOTION_PROBE_FAILED");
      expect(log).not.toMatch(/ReferenceError|TypeError|Unable to assign|Failed to load configuration/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
