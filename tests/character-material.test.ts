import { expect, it } from "vitest";
import { avatarLook, avatarManifest, avatarMaterialStyle } from "../packages/contracts/src/character.js";

const feather = { center: [0.4921875, 0.5], scale: [3.2 / 1.54, 3.6 / 1.72], inner: 0.5, outer: 0.76 };

it("keeps legacy materials opaque by default and retains optional feathering through both asset contracts", () => {
  expect(avatarMaterialStyle.parse({})).toEqual({
    tint: [1, 1, 1],
    saturation: 1,
    contrast: 1,
    shadeStrength: 0,
    textureStrength: 0,
    specularStrength: 1,
    outlineScale: 1,
  });
  const style = { alphaFeather: feather, outlineScale: 0 };
  expect(avatarLook.parse({ materials: { crown: style } }).materials.crown?.alphaFeather).toEqual(feather);
  const manifest = avatarManifest.parse({
    height: 20,
    centerY: 10,
    parts: [{ mesh: "crown.mesh", color: [1, 1, 1, 1], style }],
  });
  expect(manifest.parts[0]?.style?.alphaFeather).toEqual(feather);
});

it("rejects malformed, nonfinite, inverted and unbounded UV alpha masks", () => {
  for (const value of [
    null,
    { ...feather, center: [0.5] },
    { ...feather, center: [NaN, 0.5] },
    { ...feather, center: [9, 0.5] },
    { ...feather, scale: [0, 1] },
    { ...feather, scale: [-1, 1] },
    { ...feather, scale: [Infinity, 1] },
    { ...feather, scale: [65, 1] },
    { ...feather, inner: -0.1 },
    { ...feather, inner: Infinity },
    { ...feather, outer: 33 },
    { ...feather, outer: NaN },
    { ...feather, outer: 0.5 },
    { ...feather, outer: 0.4 },
    { ...feather, typo: 1 },
  ]) {
    expect(avatarMaterialStyle.safeParse({ alphaFeather: value }).success).toBe(false);
  }
});
