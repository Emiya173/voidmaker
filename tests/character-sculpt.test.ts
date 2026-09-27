import { expect, it } from "vitest";
import { sculptVertex } from "../apps/tools/src/characters/pmx-sculpt.js";
import { avatarLook } from "../packages/contracts/src/character.js";

const vertex = { position: [1, 2, 0], normal: [0, 0, 1], edgeRatio: 0.8 };
const sculpt = (geometry: unknown) => avatarLook.parse({ geometry: { hair: geometry } }).geometry?.hair;

it("rotates an accessory around its pivot and carries morph directions without translation", () => {
  const result = sculptVertex(
    vertex,
    sculpt({
      transform: {
        pivot: [1, 2, 0],
        rotation: [0, -90, 0],
        translation: [0.2, 0.4, 0.3],
        scale: 1.2,
      },
    }),
  );
  expect(result.position).toEqual([1.2, 2.4, 0.3]);
  expect(result.normal[0]).toBeCloseTo(-1);
  expect(result.normal[2]).toBeCloseTo(0);
  expect(result.delta([0, 0, 0.1])[0]).toBeCloseTo(-0.12);
  expect(vertex.position).toEqual([1, 2, 0]);
});

it("keeps local edits outside their support unchanged and treats mirrored points independently", () => {
  const edit = sculpt({
    brushes: [{ center: [1, 2, 0], radius: [1, 1, 1], offset: [0.1, 0.2, 0], edgeScale: 0, inner: 0.2 }],
  });
  expect(sculptVertex(vertex, edit).position).toEqual([1.1, 2.2, 0]);
  expect(sculptVertex(vertex, edit).edgeRatio).toBe(0);
  const other = { ...vertex, position: [-1, 2, 0] };
  expect(sculptVertex(other, edit).position).toEqual(other.position);
  expect(sculptVertex(other, edit).edgeRatio).toBe(0.8);
});

it("keeps transformed normals perpendicular to the deformed surface and deforms morph endpoints", () => {
  const edit = sculpt({ brushes: [{ center: [0, 0, 0], radius: [2, 2, 2], offset: [0, 0, 0.4] }] });
  const point = { ...vertex, position: [0.7, 0.3, 0] };
  const result = sculptVertex(point, edit);
  const dx = result.delta([0.00001, 0, 0]);
  expect(dx.reduce((sum, n, i) => sum + n * (result.normal[i] ?? 0), 0)).toBeCloseTo(0, 8);
  expect(Math.hypot(...result.normal)).toBeCloseTo(1);
  const endpoint = sculptVertex({ ...point, position: [0.9, 0.4, 0.1] }, edit).position;
  result.delta([0.2, 0.1, 0.1]).forEach((n, i) => {
    expect(n + (result.position[i] ?? 0)).toBeCloseTo(endpoint[i] ?? 0);
  });
});

it("rejects collapsed or inverted local deformation", () => {
  const edit = sculpt({ brushes: [{ center: [0, 0, 0], radius: [1, 1, 1], offset: [2, 0, 0] }] });
  expect(() => sculptVertex({ ...vertex, position: [0.5, 0, 0] }, edit)).toThrow("翻转或塌陷");
});

it("validates local edit bounds and keeps old look files compatible", () => {
  expect(avatarLook.parse({})).toEqual({ materials: {} });
  expect(() => sculpt({ brushes: [{ center: [0, 0, 0], radius: [0, 1, 1], offset: [0, 0, 0] }] })).toThrow();
  expect(() => avatarLook.parse({ textures: { "tex.png": "../outside.png" } })).toThrow();
  expect(() => sculpt({ transform: { pivot: [0, 0, 0], rotation: [0, 360, 0], translation: [0, 0, 0] } })).toThrow();
});

it("can suppress inner hair card outlines while retaining the outer crown in another UV island", () => {
  const edit = sculpt({
    brushes: [
      {
        center: [1, 2, 0],
        radius: [1, 1, 1],
        offset: [0, 0, 0],
        edgeScale: 0,
        uvRegion: { min: [0, 0], max: [0.5, 1] },
      },
    ],
  });
  expect(sculptVertex({ ...vertex, uv: [0.2, 0.5] }, edit).edgeRatio).toBe(0);
  expect(sculptVertex({ ...vertex, uv: [0.7, 0.5] }, edit).edgeRatio).toBe(0.8);
});
