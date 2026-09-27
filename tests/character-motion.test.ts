import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { inspectionFrames } from "../apps/tools/src/characters/preview.js";

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

it.skipIf(process.env.VOIDMAKER_QML_SMOKE !== "1")(
  "keeps the inspector baseline neutral by default and synchronizes authored poses only when requested",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "voidmaker-inspector-pose-"));
    try {
      const avatar = {
        height: 20,
        centerY: 10,
        restEyes: 0.3,
        expressions: ["sleepy", "smile"],
        poses: ["yawn", "think", "greet"],
        parts: [{ meshUrl: "#Rectangle", textureUrl: "", color: [1, 1, 1, 1] }],
      };
      const frames = inspectionFrames.filter((frame) => frame.name.endsWith("-detail"));
      expect(frames.map((frame) => frame.name)).toEqual(["yawn-detail", "think-detail", "greet-detail"]);
      expect(frames.every((frame) => "poseWeight" in frame && frame.poseWeight === 1)).toBe(true);
      const config = join(directory, "preview.json");
      await writeFile(config, JSON.stringify({ before: avatar, after: avatar, frames, reference: "" }));
      const source = (
        await readFile(new URL("../apps/tools/qml/CharacterInspector.qml", import.meta.url), "utf8")
      ).replace('"../../shell"', JSON.stringify(new URL("../apps/shell", import.meta.url).href));
      // Exercise the actual inspector and real MorphTarget weights without
      // asking a software backend to validate GPU pixels or capture images.
      const probe = `
    property int auditStep: 0
    function verify(ok, label) {
        if (!ok) { console.error("POSE_SYNC_FAILED", label); Qt.quit(); throw new Error(label) }
    }
    function close(a, b) { return Math.abs(a - b) < 0.00001 }
    Timer {
        interval: 350; repeat: true; running: true
        onTriggered: {
            const before = beforeScene.motionSnapshot().weights
            const after = afterScene.motionSnapshot().weights
            root.verify(!beforeScene.automaticMotion, "baseline automatic motion remains disabled")
            if (root.auditStep === 0) {
                root.verify(!root.syncPoses && close(before[5], 0) && close(after[5], 1), "default is neutral versus yawn")
                root.preview = Object.assign({}, root.preview, {syncPoses:true})
                root.poseWeight = 0.6; root.poseOpacity = 0.4
            } else if (root.auditStep === 1) {
                root.verify(close(before[5], 0.6) && close(after[5], 0.6), "diagnostic weight synchronized")
                root.verify(close(beforeScene.opacity, 0.4) && close(afterScene.opacity, 0.4), "opacity synchronized")
                root.applyFrame(1)
            } else if (root.auditStep === 2) {
                root.verify(close(before[6], 1) && close(after[6], 1) && close(before[5], 0), "think synchronized")
                root.verify(close(beforeScene.opacity, 1), "pose fade completes")
                root.applyFrame(2)
            } else if (root.auditStep === 3) {
                root.verify(close(before[7], 1) && close(after[7], 1) && close(before[6], 0), "greet synchronized")
                root.preview = Object.assign({}, root.preview, {syncPoses:false})
                root.poseOpacity = 0.3
            } else {
                root.verify(close(before[7], 0) && close(after[7], 1), "disabling sync restores neutral baseline")
                root.verify(close(beforeScene.opacity, 1) && close(afterScene.opacity, 0.3), "default baseline opacity restored")
                console.log("POSE_SYNC_OK"); Qt.quit()
            }
            root.auditStep++
        }
    }
`;
      const path = join(directory, "Inspector.qml");
      await writeFile(path, `${source.slice(0, source.lastIndexOf("}"))}${probe}}\n`);
      const result = await promisify(execFile)("quickshell", ["--path", path], {
        env: {
          ...process.env,
          QT_QPA_PLATFORM: "offscreen",
          QT_QUICK_BACKEND: "software",
          QML_XHR_ALLOW_FILE_READ: "1",
          VOIDMAKER_CHARACTER_PREVIEW: pathToFileURL(config).href,
        },
        timeout: 15_000,
      });
      const log = result.stdout + result.stderr;
      expect(log).toContain("POSE_SYNC_OK");
      expect(log).not.toMatch(
        /POSE_SYNC_FAILED|ReferenceError|TypeError|Unable to assign|Failed to load configuration/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
