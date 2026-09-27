import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { createIdleRig } from "../apps/tools/src/characters/pmx-idle.js";
import { avatarLook, avatarManifest } from "../packages/contracts/src/character.js";

const bones = [
  { name: "root", parentIndex: -1, position: [0, 0, 0] as const },
  { name: "上半身", parentIndex: 0, position: [0, 10, 0] as const },
  { name: "首", parentIndex: 1, position: [0, 15, 0] as const },
  { name: "頭", parentIndex: 2, position: [0, 17, 0] as const },
  { name: "左目", parentIndex: 3, position: [0.5, 18, 1] as const },
  { name: "右目", parentIndex: 3, position: [-0.5, 18, 1] as const },
  { name: "hair", parentIndex: 3, position: [0, 20, 0] as const },
  { name: "hand", parentIndex: 1, position: [5, 11, 0] as const },
  { name: "foot", parentIndex: 0, position: [0, 0, 1] as const },
];
const weighted = (skinIndices: number[], skinWeights: number[]) => ({ skinIndices, skinWeights });

it("aggregates original ancestor weights while keeping feet fixed and eyes/head separate", () => {
  const vertices = [weighted([6, 3, 2, -1], [0.2, 0.4, 0.4, 0]), weighted([4, 7], [0.6, 0.4]), weighted([8], [1])];
  const input = structuredClone(vertices);
  const idle = createIdleRig(vertices, bones);
  expect(idle.skin[0]?.joints).toEqual([2, 3, 0, 0]);
  expect(idle.skin[0]?.weights[0]).toBeCloseTo(0.4);
  expect(idle.skin[0]?.weights[1]).toBeCloseTo(0.6);
  expect(idle.skin[1]?.joints).toEqual([1, 4, 0, 0]);
  expect(idle.skin[2]).toEqual({ joints: [0, 0, 0, 0], weights: [1, 0, 0, 0] });
  expect(vertices).toEqual(input);
  const globals: number[][] = [];
  const parents = [-1, 0, 1, 2, 3, 3];
  idle.nodes.forEach((node, index) => {
    const parent = globals[parents[index] ?? -1] ?? [0, 0, 0];
    const position = node.translation.map((v, axis) => v + (parent[axis] ?? 0));
    globals.push(position);
    // Joint world transform times inverse bind must be identity at rest.
    position.forEach((v, axis) => {
      expect(v + (idle.inverseBindMatrices[index * 16 + 12 + axis] ?? 0)).toBe(0);
    });
  });
});

it("rejects missing controls, cyclic ancestry, sentinel influences and invalid weights", () => {
  expect(() => createIdleRig([], bones.slice(0, 4))).toThrow("唯一骨骼");
  expect(() =>
    createIdleRig(
      [],
      bones.map((b, i) => (i === 0 ? { ...b, parentIndex: 3 } : b)),
    ),
  ).toThrow("层级");
  expect(() => createIdleRig([weighted([-1], [1])], bones)).toThrow("索引");
  expect(() => createIdleRig([weighted([4], [0])], bones)).toThrow("权重");
  expect(() => createIdleRig([weighted([4, 3], [1])], bones)).toThrow("权重");
});

it("keeps motion bounded, neutral on reset and continuous at the authored loop boundary", async () => {
  const source = await readFile(new URL("../apps/shell/CharacterMotion.js", import.meta.url), "utf8");
  const sample = runInNewContext(`${source}; sample`) as (seconds: number) => Record<string, number>;
  expect(Object.values(sample(0)).every((value) => value === 0)).toBe(true);
  expect(sample(2.4).breath).toBeCloseTo(1);
  expect(sample(4.19).blink).toBeCloseTo(1);
  expect(sample(4.4).blink).toBe(0);
  for (let seconds = 0; seconds <= 120; seconds += 0.031) {
    const value = sample(seconds);
    expect(Math.abs(value.headYaw ?? 0)).toBeLessThanOrEqual(1.6);
    expect(Math.abs(value.eyeYaw ?? 0)).toBeLessThanOrEqual(2.9);
    expect(value.breath).toBeGreaterThanOrEqual(0);
    expect(value.breath).toBeLessThanOrEqual(1);
    expect(value.blink).toBeGreaterThanOrEqual(0);
    expect(value.blink).toBeLessThanOrEqual(1);
  }
  Object.values(sample(120)).forEach((value) => {
    expect(value).toBeCloseTo(0, 9);
  });
});

it("accepts legacy assets and bounds runtime rig, expression, pose and style metadata", () => {
  const legacy = { height: 20, centerY: 10, parts: [{ mesh: "model.mesh", color: [1, 1, 1, 1] }] };
  expect(avatarManifest.parse(legacy).idleRig).toBeUndefined();
  const rig = createIdleRig([], bones).rig;
  expect(
    avatarManifest.parse({ ...legacy, idleRig: rig, expressions: ["sleepy", "smile"], poses: ["greet"] }).idleRig,
  ).toEqual(rig);
  expect(avatarManifest.safeParse({ ...legacy, idleRig: { ...rig, pivots: [] } }).success).toBe(false);
  expect(avatarManifest.safeParse({ ...legacy, expressions: ["smile", "smile"] }).success).toBe(false);
  expect(avatarLook.safeParse({ poses: { greet: "../pose.json" } }).success).toBe(false);
  expect(avatarLook.safeParse({ expressions: { smile: { morphs: {} } } }).success).toBe(false);
  expect(avatarLook.safeParse({ materials: { hair: { rampStrength: 2 } } }).success).toBe(false);
});
