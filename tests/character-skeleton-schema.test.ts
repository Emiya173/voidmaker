import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readPreview } from "../apps/tools/src/characters/preview.js";
import { readMotionRig } from "../packages/adapters/src/character-motion.js";
import { loadCharacters } from "../packages/adapters/src/characters.js";
import { avatarLook, avatarManifest } from "../packages/contracts/src/character.js";
import {
  motionClipFile,
  motionLimits,
  motionRigFile,
  validateMotionClip,
} from "../packages/contracts/src/character-motion.js";

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const neutral = { name: "root", parent: -1, translation: [0, 2, 0], rotation: [1, 0, 0, 0], inverseBind: identity };
const rig = () => ({
  version: 1,
  sourceSha256: "a".repeat(64),
  joints: [structuredClone(neutral)],
  clips: [{ name: "yawn", file: "yawn.json", duration: 1 }],
});
const clip = () => ({
  version: 1,
  duration: 1,
  tracks: [
    {
      joint: 0,
      times: [0, 0.5, 1],
      rotations: [
        [1, 0, 0, 0],
        [Math.SQRT1_2, 0, Math.SQRT1_2, 0],
        [-1, 0, 0, 0],
      ],
      translations: [
        [0, 2, 0],
        [0, 2.1, 0],
        [0, 2, 0],
      ],
    },
  ],
  expression: [
    { time: 0, weight: 0 },
    { time: 0.5, weight: 1 },
    { time: 1, weight: 0 },
  ],
});
function trackOf(value: ReturnType<typeof clip>) {
  const track = value.tracks[0];
  if (!track) throw new Error("Missing fixture track");
  return track;
}
const manifest = () => ({
  height: 20,
  centerY: 10,
  motionRig: "motions/rig.json",
  poses: ["yawn"],
  parts: [{ mesh: "model.mesh", color: [1, 1, 1, 1] }],
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "voidmaker-skeleton-"));
  paths.push(directory);
  const root = join(directory, "demo");
  await mkdir(join(root, "motions"), { recursive: true });
  await writeFile(
    join(root, "character.json"),
    JSON.stringify({
      version: 1,
      id: "demo",
      name: "Demo",
      persona: "test",
      avatar: { kind: "quick3d", manifest: "avatar.json" },
    }),
  );
  await writeFile(join(root, "avatar.json"), JSON.stringify(manifest()));
  await writeFile(join(root, "model.mesh"), Buffer.alloc(64));
  await writeFile(join(root, "motions/rig.json"), JSON.stringify(rig()));
  await writeFile(join(root, "motions/yawn.json"), JSON.stringify(clip()));
  return { root, directory };
}

it("accepts neutral TR distinct from source bind and quaternion sign-equivalent closed clips", () => {
  const parsed = motionRigFile.parse(rig());
  expect(parsed.joints[0]?.translation).toEqual([0, 2, 0]);
  expect(validateMotionClip(clip(), parsed.joints, 1).tracks).toHaveLength(1);
  const translationOnly = clip();
  const { rotations: _, ...track } = trackOf(translationOnly);
  expect(validateMotionClip({ ...translationOnly, tracks: [track], expression: [] }, parsed.joints, 1)).toBeDefined();
  const legacy = { height: 20, centerY: 10, parts: [{ mesh: "model.mesh", color: [1, 1, 1, 1] }] };
  expect(avatarManifest.parse(legacy).motionRig).toBeUndefined();
  expect(avatarLook.parse({ motionRig: "motions/rig.json" }).motionRig).toBe("motions/rig.json");
  expect(avatarLook.safeParse({ motionRig: "motions/rig.json", idleMotion: true }).success).toBe(false);
  expect(
    avatarManifest.safeParse({ ...manifest(), idleRig: { version: 1, pivots: Array(6).fill([0, 0, 0]) } }).success,
  ).toBe(false);
});

it("rejects duplicate, cyclic, multi-root, nonfinite and non-normalized skeleton data", () => {
  const invalid = [
    { ...rig(), sourceSha256: "not-a-hash" },
    { ...rig(), joints: [{ ...neutral, parent: 0 }] },
    { ...rig(), joints: [neutral, { ...neutral, name: "child" }] },
    { ...rig(), joints: [neutral, { ...neutral, parent: 0 }] },
    { ...rig(), joints: [{ ...neutral, rotation: [0, 0, 0, 0] }] },
    { ...rig(), joints: [{ ...neutral, rotation: [1, 1, 0, 0] }] },
    { ...rig(), joints: [{ ...neutral, translation: [Infinity, 0, 0] }] },
    { ...rig(), joints: [{ ...neutral, inverseBind: Array(16).fill(0) }] },
    { ...rig(), clips: [...rig().clips, ...rig().clips] },
    { ...rig(), clips: [{ name: "yawn", file: "../escape.json", duration: 1 }] },
  ];
  for (const value of invalid) expect(motionRigFile.safeParse(value).success).toBe(false);
});

it("rejects malformed timelines, tracks, bounds and non-neutral endpoints", () => {
  const input = clip(),
    track = trackOf(input);
  for (const badTrack of [
    { ...track, times: [0, 0.5, 0.5] },
    { ...track, times: [0, 0.5, 2] },
    { ...track, rotations: [[1, 0, 0, 0]] },
    {
      ...track,
      rotations: [
        [1, 0, 0, 0],
        [NaN, 0, 0, 0],
        [1, 0, 0, 0],
      ],
    },
    { joint: 0, times: [0, 1] },
  ])
    expect(motionClipFile.safeParse({ ...input, tracks: [badTrack] }).success).toBe(false);
  expect(motionClipFile.safeParse({ ...input, tracks: [track, track] }).success).toBe(false);
  expect(motionClipFile.safeParse({ ...input, duration: 61 }).success).toBe(false);
  expect(
    motionClipFile.safeParse({
      ...input,
      expression: [
        { time: 0, weight: 0 },
        { time: 1, weight: 1 },
      ],
    }).success,
  ).toBe(false);
  const joints = motionRigFile.parse(rig()).joints;
  expect(() => validateMotionClip({ ...input, tracks: [{ ...track, joint: 1 }] }, joints, 1)).toThrow("索引越界");
  expect(() => validateMotionClip(input, joints, 2)).toThrow("时长不符");
  expect(() => validateMotionClip({ ...input, tracks: [{ ...track, times: [0.1, 0.5, 1] }] }, joints, 1)).toThrow(
    "完整时长",
  );
  const moved = clip();
  trackOf(moved).translations[2] = [0, 2.01, 0];
  expect(() => validateMotionClip(moved, joints, 1)).toThrow("首尾位移");
  const rotated = clip();
  trackOf(rotated).rotations[2] = [Math.SQRT1_2, 0, Math.SQRT1_2, 0];
  expect(() => validateMotionClip(rotated, joints, 1)).toThrow("首尾旋转");
  const manyTimes = Array.from({ length: motionLimits.keysPerTrack }, (_, i) => i / (motionLimits.keysPerTrack - 1));
  const manyRotations = manyTimes.map(() => [1, 0, 0, 0]);
  expect(
    motionClipFile.safeParse({
      ...input,
      tracks: Array.from({ length: 33 }, (_, joint) => ({ joint, times: manyTimes, rotations: manyRotations })),
    }).success,
  ).toBe(false);
});

it("projects the same validated rig in Host and preview without sending tracks, with content-stable identity", async () => {
  const { root, directory } = await fixture();
  const catalog = await loadCharacters(directory);
  const avatar = catalog.entries[1]?.avatar;
  const preview = await readPreview(join(root, "avatar.json"));
  expect(catalog.warnings).toEqual([]);
  expect(preview.motionRig).toEqual(avatar?.motionRig);
  expect(avatar?.motionRig?.clips[0]?.url).toMatch(/\/motions\/yawn.json$/);
  expect(avatar?.motionRig?.assetKey).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(avatar?.motionRig)).not.toContain('"tracks"');
  const changed = clip();
  trackOf(changed).translations[1] = [0, 2.2, 0];
  await writeFile(join(root, "motions/yawn.json"), JSON.stringify(changed));
  const reloaded = await loadCharacters(directory);
  expect(reloaded.entries[1]?.revision).toBe(catalog.entries[1]?.revision);
  expect(reloaded.entries[1]?.avatar?.motionRig?.assetKey).not.toBe(avatar?.motionRig?.assetKey);
});

it("requires a matching face slot only for clips that actually drive expression", async () => {
  const { root, directory } = await fixture();
  await writeFile(join(root, "avatar.json"), JSON.stringify({ ...manifest(), poses: [] }));
  await expect(readPreview(join(root, "avatar.json"))).rejects.toThrow("对应形态槽");
  expect((await loadCharacters(directory)).entries[1]?.avatar).toBeUndefined();
  await writeFile(join(root, "motions/yawn.json"), JSON.stringify({ ...clip(), expression: [] }));
  expect((await readPreview(join(root, "avatar.json"))).motionRig?.clips[0]?.name).toBe("yawn");
  expect((await loadCharacters(directory)).warnings).toEqual([]);
});

it("rejects escaping rigs/clips and oversized files; missing or bad motion falls back without losing the character", async () => {
  const { root, directory } = await fixture();
  const outside = join(directory, "outside.json");
  await writeFile(outside, JSON.stringify(clip()));
  await rm(join(root, "motions/yawn.json"));
  await symlink(outside, join(root, "motions/yawn.json"));
  await expect(readMotionRig(root, "motions/rig.json")).rejects.toThrow("越出");
  await expect(readPreview(join(root, "avatar.json"))).rejects.toThrow("越出");
  let catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.id).toBe("demo");
  expect(catalog.entries[1]?.avatar).toBeUndefined();
  expect(catalog.warnings).toEqual(["Demo：3D 素材不可用，使用立绘回退"]);
  await rm(join(root, "motions/yawn.json"));
  await expect(readMotionRig(root, "motions/rig.json")).rejects.toThrow();
  catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.id).toBe("demo");
  expect(catalog.entries[1]?.avatar).toBeUndefined();
  expect(catalog.warnings).toHaveLength(1);
  await writeFile(join(root, "motions/yawn.json"), "{}");
  await truncate(join(root, "motions/yawn.json"), motionLimits.clipBytes + 1);
  await expect(readMotionRig(root, "motions/rig.json")).rejects.toThrow("大小");
  await writeFile(
    join(root, "motions/yawn.json"),
    JSON.stringify({
      ...clip(),
      tracks: [
        {
          joint: 9,
          times: [0, 1],
          rotations: [
            [1, 0, 0, 0],
            [1, 0, 0, 0],
          ],
        },
      ],
    }),
  );
  catalog = await loadCharacters(directory);
  expect(catalog.entries[1]?.avatar).toBeUndefined();
  await writeFile(outside, JSON.stringify(rig()));
  await rm(join(root, "motions/rig.json"));
  await symlink(outside, join(root, "motions/rig.json"));
  await expect(readMotionRig(root, "motions/rig.json")).rejects.toThrow("越出");
});
