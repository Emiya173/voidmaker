import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

type Joint = { parent: number; translation: number[]; rotation: number[] };
type Clip = {
  version: number;
  duration: number;
  tracks: { joint: number; times: number[]; rotations?: number[][]; translations?: number[][] }[];
  expression: { time: number; weight: number }[];
};
const identity = [1, 0, 0, 0];
const quarter = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const joints: Joint[] = [
  { parent: -1, translation: [0, 0, 0], rotation: identity },
  { parent: 0, translation: [0, 1, 0], rotation: identity },
  { parent: 1, translation: [0, 2, 0], rotation: identity },
];
const clip: Clip = {
  version: 1,
  duration: 2,
  tracks: [{ joint: 1, times: [0, 1, 2], rotations: [identity, quarter, identity] }],
  expression: [
    { time: 0, weight: 0 },
    { time: 1, weight: 1 },
    { time: 2, weight: 0 },
  ],
};
async function motion() {
  const source = await readFile(new URL("../apps/shell/SkeletonMotion.js", import.meta.url), "utf8");
  return runInNewContext(`${source}; ({sample, validClip, slerp})`) as {
    sample: (rig: Joint[], clip: Clip | null, seconds: number) => { joints: Joint[]; expression: number };
    validClip: (clip: unknown, joints: number, duration: number) => boolean;
    slerp: (a: number[], b: number[], amount: number) => number[];
  };
}

it("interpolates local rotations before FK, retaining bone lengths through large arm turns", async () => {
  const m = await motion(),
    original = structuredClone({ joints, clip });
  expect(m.validClip(clip, 3, 2)).toBe(true);
  const halfway = m.sample(joints, clip, 0.5);
  expect(halfway.joints[2]?.translation[0]).toBeCloseTo(-Math.SQRT2);
  expect(halfway.joints[2]?.translation[1]).toBeCloseTo(1 + Math.SQRT2);
  expect(halfway.expression).toBe(0.5);
  for (let time = 0; time < 2; time += 0.013) {
    const frame = m.sample(joints, clip, time).joints;
    const upper = frame[1]?.translation ?? [],
      tip = frame[2]?.translation ?? [];
    expect(Math.hypot(...tip.map((value, i) => value - (upper[i] ?? 0)))).toBeCloseTo(2, 10);
  }
  expect({ joints, clip }).toEqual(original);
});

it("uses the short quaternion path and restores authored neutral on exit and cancellation", async () => {
  const m = await motion();
  m.slerp(
    quarter,
    quarter.map((value) => -value),
    0.5,
  ).forEach((value, index) => {
    expect(value).toBeCloseTo(quarter[index] ?? 0, 12);
  });
  const rotatedNeutral = joints.map((joint, i) => ({ ...joint, rotation: i === 1 ? quarter : identity }));
  const neutral = m.sample(rotatedNeutral, null, 0);
  expect(neutral.joints[2]?.translation[0]).toBeCloseTo(-2);
  expect(m.sample(rotatedNeutral, clip, 2)).toEqual(neutral);
  expect(m.sample(rotatedNeutral, clip, 100)).toEqual(neutral);
  expect(m.sample(rotatedNeutral, clip, -1)).toEqual(neutral);
  const untranslated: Clip = {
    ...clip,
    tracks: [
      {
        joint: 0,
        times: [0, 1],
        translations: [
          [0, 0, 0],
          [2, 0, 0],
        ],
      },
    ],
  };
  expect(m.sample(rotatedNeutral, untranslated, 0.5).joints[2]?.translation[0]).toBeCloseTo(-1);
});

it("rejects asynchronous clip shape failures without accepting invalid joint access or quaternions", async () => {
  const m = await motion();
  for (const bad of [
    null,
    { ...clip, duration: 3 },
    { ...clip, tracks: [{ joint: 3, times: [0], rotations: [identity] }] },
    { ...clip, tracks: [clip.tracks[0], clip.tracks[0]] },
    { ...clip, tracks: [{ joint: 0, times: [0, 0], rotations: [identity, identity] }] },
    { ...clip, tracks: [{ joint: 0, times: [0], rotations: [[0, 0, 0, 0]] }] },
    { ...clip, tracks: [{ joint: 0, times: [0, 1], translations: [[0, 0, 0]] }] },
    { ...clip, expression: [{ time: 0, weight: Number.NaN }] },
    { ...clip, duration: 61 },
    { ...clip, expression: Array.from({ length: 4097 }, (_, i) => ({ time: i / 4096, weight: 0 })) },
    {
      ...clip,
      tracks: [
        { joint: 0, times: Array.from({ length: 4097 }, (_, i) => i / 4096), rotations: Array(4097).fill(identity) },
      ],
    },
  ])
    expect(m.validClip(bad, 3, 2)).toBe(false);
  expect(m.validClip(clip, 257, 2)).toBe(false);
});

it.skipIf(process.env.VOIDMAKER_QML_SMOKE !== "1")(
  "drives real QML Skin nodes, pauses, exits and ignores cancelled or replaced asynchronous clips",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "voidmaker-skeleton-"));
    const authoredNeutral = [Math.cos(Math.PI / 8), 0, 0, Math.sin(Math.PI / 8)];
    const payload = JSON.stringify({
      ...clip,
      duration: 0.6,
      tracks: [
        { joint: 1, times: [0, 0.2, 0.4, 0.6], rotations: [authoredNeutral, quarter, quarter, authoredNeutral] },
      ],
      expression: [
        { time: 0, weight: 0 },
        { time: 0.2, weight: 1 },
        { time: 0.4, weight: 1 },
        { time: 0.6, weight: 0 },
      ],
    });
    const server = createServer((request, response) => {
      const reply = () => {
        response.setHeader("Content-Type", "application/json");
        response.end(request.url === "/bad" ? "broken" : payload);
      };
      if (request.url === "/slow") setTimeout(reply, 350);
      else reply();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture server address");
      const clipPath = join(directory, "本地 action.json");
      await writeFile(clipPath, payload);
      const qml = (await readFile(new URL("helpers/character-skeleton-motion.qml", import.meta.url), "utf8"))
        .replace('"APP_SHELL"', JSON.stringify(new URL("../apps/shell", import.meta.url).href))
        .replace('"LOCAL_CLIP"', JSON.stringify(pathToFileURL(clipPath).href))
        .replace('"CLIP_BASE"', JSON.stringify(`http://127.0.0.1:${address.port}`));
      const path = join(directory, "Skeleton.qml");
      await writeFile(path, qml);
      const result = await promisify(execFile)("quickshell", ["--path", path], {
        env: {
          ...process.env,
          QT_QPA_PLATFORM: "offscreen",
          QT_QUICK_BACKEND: "software",
          QML_XHR_ALLOW_FILE_READ: "0",
        },
        timeout: 15_000,
      }).catch((failure: { stdout?: string; stderr?: string; message?: string }) => {
        throw new Error(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
      });
      const log = result.stdout + result.stderr;
      expect(log).toContain("SKELETON_PROBE_OK");
      expect(log).not.toMatch(
        /SKELETON_PROBE_FAILED|ReferenceError|TypeError|Unable to assign|Failed to load configuration/,
      );
    } finally {
      server.closeAllConnections();
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
