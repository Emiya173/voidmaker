import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { inspectionFrames } from "../apps/tools/src/characters/preview.js";

it("defines deterministic enter, hold, return and neutral endpoint samples for each action", () => {
  for (const name of ["yawn", "think", "greet"]) {
    const names = ["enter", "hold", "return", "end", "hold-side"].map((phase) => `${name}-${phase}`);
    const frames = inspectionFrames.filter(
      (frame) => "action" in frame && frame.action === name && names.includes(frame.name),
    );
    expect(frames.map((frame) => frame.name)).toEqual(names);
    expect(frames.map((frame) => ("actionProgress" in frame ? frame.actionProgress : -1))).toEqual([
      0.16, 0.5, 0.86, 1, 0.5,
    ]);
    expect(frames.every((frame) => !("pose" in frame))).toBe(true);
  }
});

it.skipIf(process.env.VOIDMAKER_QML_SMOKE !== "1").each(["static", "motion"] as const)(
  "samples and controls QML action playback with a %s baseline",
  async (baseline) => {
    const directory = await mkdtemp(join(tmpdir(), "voidmaker-action-inspector-"));
    try {
      const writeClips = async (before = false) =>
        Promise.all(
          [
            { name: "yawn", duration: 2.4 },
            { name: "think", duration: 1.6 },
            { name: "greet", duration: 1.2 },
          ].map(async ({ name, duration: candidateDuration }) => {
            const duration = candidateDuration + (before ? (name === "greet" ? -0.3 : 0.6) : 0);
            const file = join(directory, `${before ? "before-" : ""}${name}.json`);
            await writeFile(
              file,
              JSON.stringify({
                version: 1,
                duration,
                tracks: [
                  {
                    joint: 0,
                    times: [0, duration / 2, duration],
                    rotations: [
                      [1, 0, 0, 0],
                      [0.923879533, 0, 0, 0.382683432],
                      [1, 0, 0, 0],
                    ],
                  },
                ],
                expression: [
                  { time: 0, weight: 0 },
                  { time: duration / 2, weight: 1 },
                  { time: duration, weight: 0 },
                ],
              }),
            );
            return { name, duration, url: pathToFileURL(file).href };
          }),
        );
      const clips = await writeClips();
      const beforeClips = baseline === "motion" ? await writeClips(true) : [];
      const avatar = {
        height: 20,
        centerY: 10,
        restEyes: 0.3,
        expressions: ["sleepy", "smile"],
        poses: ["yawn", "think", "greet"],
        parts: [{ meshUrl: "#Rectangle", textureUrl: "", color: [1, 1, 1, 1] }],
      };
      const frames = [inspectionFrames[0], ...inspectionFrames.filter((frame) => "action" in frame)];
      const motionRig = {
        version: 1,
        assetKey: "inspector-fixture",
        joints: [
          {
            name: "root",
            parent: -1,
            translation: [0, 0, 0],
            rotation: [1, 0, 0, 0],
            inverseBind: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
        ],
        clips,
      };
      const config = join(directory, "preview.json");
      await writeFile(
        config,
        JSON.stringify({
          before: {
            ...avatar,
            ...(baseline === "motion"
              ? { motionRig: { ...motionRig, assetKey: "before-fixture", clips: beforeClips } }
              : {}),
          },
          after: {
            ...avatar,
            motionRig,
          },
          frames,
          reference: "",
          syncPoses: true,
        }),
      );
      const source = (
        await readFile(new URL("../apps/tools/qml/CharacterInspector.qml", import.meta.url), "utf8")
      ).replace('"../../shell"', JSON.stringify(new URL("../apps/shell", import.meta.url).href));
      // Exercise the production Inspector and Character3D. Pixel appearance is
      // accepted separately with real GPU captures, not this software backend.
      const probe = `
    property int auditStep: 0
    property int auditFrame: 1
    property int auditWaits: 0
    property real pausedAt: 0
    property bool motionBaseline: ${baseline === "motion"}
    function verifyAction(ok, label) {
        if (!ok) { console.error("ACTION_INSPECTOR_FAILED", label); Qt.quit(); throw new Error(label) }
    }
    function nearAction(a, b) { return Math.abs(a - b) < 0.0001 }
    function verifySynchronizedAction(label) {
        if (!root.motionBaseline) return
        root.verifyAction(beforeScene.action === afterScene.action, label + " action ID")
        root.verifyAction(root.nearAction(beforeScene.actionTime, Math.min(beforeScene.actionDuration, afterScene.actionTime)), label + " same seconds")
        root.verifyAction(!beforeScene.actionPlaying, label + " single clock")
        root.verifyAction(beforeScene.yawn === 0 && beforeScene.think === 0 && beforeScene.greet === 0, label + " no static overlap")
    }
    Timer {
        interval: 150; repeat: true; running: true
        onTriggered: {
            if (root.activeAction && (!afterScene.actionReady || (root.syncActions && !beforeScene.actionReady))) {
                root.verifyAction(++root.auditWaits < 40, "action loaded")
                return
            }
            root.auditWaits = 0
            if (root.auditStep === 0) {
                root.verifyAction(!root.activeAction && !afterScene.actionPlaying, "no autoplay on open")
                root.verifyAction(root.actionLabel("greet") === "远望" && root.frameLabel("greet-hold-side") === "远望 · 停留 · 侧面", "look labels")
                root.verifyAction(root.frameLabel("think-retract-e-side") === "思考 · 收回 · 第5段 · 侧面", "retraction closeup labels")
                root.verifyAction(actionMenu.model[3] === "远望" && poseMenu.model[3] === "远望", "menus label greet as looking into distance")
                root.verifyAction(frameMenu.model.indexOf("远望 · 停留") >= 0, "phase menu labels")
                root.selectAction("think")
                root.seekAction(0.592)
            } else if (root.auditStep === 1) {
                root.verifyAction(root.nearAction(afterScene.actionTime, 0.592), "manual seconds")
                root.verifyAction(!afterScene.actionPlaying, "selection and seek stay paused")
                root.verifyAction(beforeScene.think === (root.motionBaseline ? 0 : 1), "baseline chooses correct motion path")
                root.verifySynchronizedAction("seek")
                root.verifyAction(afterScene.yawn === 0 && afterScene.think === 0 && afterScene.greet === 0, "no body morph overlap")
                root.applyFrame(root.auditFrame)
            } else if (root.auditStep === 2) {
                const f = root.preview.frames[root.auditFrame]
                root.verifyAction(root.activeAction === f.action, "frame action")
                root.verifyAction(root.nearAction(afterScene.actionTime, root.clipDuration(f.action) * f.actionProgress), "manifest duration sample")
                root.verifyAction(!afterScene.actionPlaying && !root.actionAutomatic, "capture sample is static")
                root.verifyAction(beforeScene[f.action] === (root.motionBaseline ? 0 : 1) && afterScene[f.action] === 0, "static versus skeletal sample")
                root.verifySynchronizedAction("frame " + f.name)
                root.verifyAction(beforeScene.viewTargetX === (f.targetX || 0) && afterScene.viewTargetX === (f.targetX || 0), "shared horizontal framing")
                if (++root.auditFrame < root.preview.frames.length) { root.applyFrame(root.auditFrame); return }
                root.selectAction("think"); root.seekAction(0.7)
            } else if (root.auditStep === 3) {
                root.verifyAction(root.nearAction(afterScene.actionTime, 0.7), "new clip manual time before play")
                root.playAction(false)
            } else if (root.auditStep === 4) {
                root.verifyAction(afterScene.actionPlaying && afterScene.actionTime > 0.7, "play resumes manual time")
                root.verifySynchronizedAction("play")
                root.pauseAction(); root.pausedAt = afterScene.actionTime
            } else if (root.auditStep === 5) {
                root.verifyAction(!afterScene.actionPlaying && root.nearAction(afterScene.actionTime, root.pausedAt), "pause holds time")
                root.verifySynchronizedAction("pause")
                root.playAction(false)
            } else if (root.auditStep === 6) {
                root.verifyAction(afterScene.actionTime > root.pausedAt, "resume continues time")
                root.verifySynchronizedAction("resume")
                root.playAction(true)
            } else if (root.auditStep === 7) {
                root.verifyAction(afterScene.actionPlaying && afterScene.actionTime < 0.4, "replay starts over")
                root.verifySynchronizedAction("replay")
                root.stopAction()
            } else if (root.auditStep === 8) {
                root.verifyAction(!root.activeAction && !afterScene.actionPlaying && root.nearAction(afterScene.actionTime, 0), "stop restores neutral")
                root.verifyAction(root.selectedAction === "think", "stop retains menu selection")
                root.verifyAction(!beforeScene.action && root.nearAction(beforeScene.actionTime, 0), "baseline stop restores neutral")
                root.preview = Object.assign({}, root.preview, {syncPoses: false})
                root.selectAction("greet"); root.seekAction(0.3)
            } else {
                root.verifyAction(!beforeScene.action && root.nearAction(beforeScene.actionTime, 0), "unsynchronized baseline stays neutral")
                root.verifyAction(root.nearAction(afterScene.actionTime, 0.3) && actionMenu.currentText === "远望", "localized menu preserves greet ID")
                console.log("ACTION_INSPECTOR_OK"); Qt.quit()
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
      }).catch((error: unknown) => {
        const failure = error as { stdout?: string; stderr?: string };
        throw new Error(`Inspector QML failed:\n${failure.stdout ?? ""}${failure.stderr ?? ""}`, { cause: error });
      });
      const log = result.stdout + result.stderr;
      expect(log).toContain("ACTION_INSPECTOR_OK");
      expect(log).not.toMatch(
        /ACTION_INSPECTOR_FAILED|ReferenceError|TypeError|Unable to assign|Failed to load configuration/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
