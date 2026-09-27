import { expect, it } from "vitest";
import { createPose } from "../apps/tools/src/characters/pmx-pose.js";
import { avatarLook, avatarManifest } from "../packages/contracts/src/character.js";

const bones = [
  { name: "root", parentIndex: -1, position: [0, 0, 0] as const },
  { name: "左腕", parentIndex: 0, position: [1, 10, 0] as const },
  { name: "右腕", parentIndex: 0, position: [-1, 10, 0] as const },
  { name: "hand", parentIndex: 1, position: [3, 10, 0] as const },
];
const vertex = (index: number, x: number) => ({
  position: [x, 10, 0] as const,
  normal: [1, 0, 0] as const,
  skinIndices: [index],
  skinWeights: [1],
});
it("lowers both arms symmetrically, carries child bones and leaves torso and input intact", () => {
  const vertices = [vertex(3, 4), vertex(2, -4), vertex(0, 0)];
  const saved = structuredClone(vertices);
  const posed = createPose(vertices, bones, "relaxed");
  const left = posed.vertices[0],
    right = posed.vertices[1];
  expect(left?.position[0]).toBeLessThan(4);
  expect(left?.position[1]).toBeLessThan(10);
  expect(left?.position[0]).toBeCloseTo(-(right?.position[0] ?? 0));
  expect(left?.position[1]).toBeCloseTo(right?.position[1] ?? 0);
  expect(Math.hypot((left?.position[0] ?? 0) - 1, (left?.position[1] ?? 0) - 10)).toBeCloseTo(3);
  expect(Math.hypot(...(left?.normal ?? []))).toBeCloseTo(1);
  expect(posed.vertices[2]?.position).toEqual(vertices[2]?.position);
  expect(vertices).toEqual(saved);
  expect(createPose(vertices, bones, "original").vertices[0]?.position).toEqual([4, 10, 0]);
});
it("rotates morph displacements without translating them and normalizes blended weights", () => {
  const vertices = [{ ...vertex(3, 4), skinIndices: [3, 0, -1], skinWeights: [0.4, 0.4, 0] }];
  const posed = createPose(vertices, bones, "relaxed");
  expect(posed.delta(0, [0, 0, 0])).toEqual([0, 0, 0]);
  expect(posed.delta(0, [0, 0, 0.5])).toEqual([0, 0, 0.5]);
  const delta = posed.delta(0, [1, 0, 0]);
  const moved = createPose(
    vertices.map((v) => ({ ...v, position: [5, 10, 0] as const })),
    bones,
    "relaxed",
  );
  delta.forEach((d, axis) => {
    expect(d).toBeCloseTo((moved.vertices[0]?.position[axis] ?? 0) - (posed.vertices[0]?.position[axis] ?? 0));
  });
});
it("rejects absent arm mappings, bone cycles and invalid weighted indices", () => {
  expect(() => createPose([], bones.slice(0, 2), "relaxed")).toThrow("唯一骨骼");
  expect(() =>
    createPose(
      [],
      bones.map((b, i) => (i === 1 ? { ...b, parentIndex: 3 } : b)),
      "relaxed",
    ),
  ).toThrow("层级");
  expect(() => createPose([vertex(99, 0)], bones, "relaxed")).toThrow("索引");
  expect(() => createPose([{ ...vertex(1, 0), skinWeights: [0] }], bones, "relaxed")).toThrow("权重");
});
it("validates toon assets and bounded framing while accepting previous avatar manifests", () => {
  const old = { height: 20, centerY: 10, parts: [{ mesh: "model.mesh", color: [1, 1, 1, 1] }] };
  expect(avatarManifest.parse(old).framing).toEqual({ yaw: 0, zoom: 1, targetY: 0 });
  expect(avatarManifest.safeParse({ ...old, framing: { zoom: 0 } }).success).toBe(false);
  expect(
    avatarManifest.safeParse({
      ...old,
      parts: [
        {
          ...old.parts[0],
          toon: {
            ambient: [0.5, 0.5, 0.5],
            specular: [0, 0, 0],
            shininess: 50,
            edgeColor: [0, 0, 0, 1],
            edgeSize: 1,
            ramp: "../outside.png",
          },
        },
      ],
    }).success,
  ).toBe(false);
});
it("keeps material grading neutral by default and validates authored eye/ink adjustments", () => {
  expect(avatarLook.parse({ materials: { cloth: {} } }).materials.cloth).toEqual({
    tint: [1, 1, 1],
    saturation: 1,
    contrast: 1,
    shadeStrength: 0,
    textureStrength: 0,
    specularStrength: 1,
    outlineScale: 1,
  });
  expect(avatarLook.safeParse({ restEyes: { morph: "eyes", weight: 1.2 } }).success).toBe(false);
  expect(avatarLook.safeParse({ materials: { cloth: { tint: [3, 0, 0] } } }).success).toBe(false);
  expect(avatarLook.safeParse({ materials: { cloth: { fragmentShader: "arbitrary.frag" } } }).success).toBe(false);
});
