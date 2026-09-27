import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { avatarManifest } from "../../../../packages/contracts/src/character.js";

/** Load local previews without the Host, a session, or any voice device. */
export async function readPreview(path: string) {
  if ((await stat(path)).size > 256 * 1024) throw new Error("预览清单过大");
  const manifest = avatarManifest.parse(JSON.parse(await readFile(path, "utf8")));
  const root = await realpath(dirname(path));
  const assetUrl = async (name: string | undefined) => {
    if (!name) return "";
    const file = await realpath(join(root, name));
    const local = relative(root, file);
    if (local.startsWith("../") || isAbsolute(local) || !(await stat(file)).isFile())
      throw new Error("预览素材路径越界或无效");
    return pathToFileURL(file).href;
  };
  return {
    ...manifest,
    parts: await Promise.all(
      manifest.parts.map(async (p) => ({
        ...p,
        meshUrl: await assetUrl(p.mesh),
        textureUrl: await assetUrl(p.texture),
        ...(p.toon ? { toon: { ...p.toon, rampUrl: await assetUrl(p.toon.ramp) } } : {}),
      })),
    ),
  };
}

export const inspectionFrames = [
  { name: "front", yaw: 0, pitch: 0, zoom: 3, targetY: 0.34, mode: 0, mouth: 0, blink: 0 },
  { name: "head", yaw: 0, pitch: 0, zoom: 4.5, targetY: 0.4, mode: 0, mouth: 0, blink: 0 },
  { name: "torso", yaw: 0, pitch: 0, zoom: 4, targetY: 0.23, mode: 0, mouth: 0, blink: 0 },
  { name: "left", yaw: -65, pitch: 0, zoom: 3, targetY: 0.34, mode: 0, mouth: 0, blink: 0 },
  { name: "right", yaw: 65, pitch: 0, zoom: 3, targetY: 0.34, mode: 0, mouth: 0, blink: 0 },
  { name: "back", yaw: 180, pitch: 0, zoom: 2, targetY: 0.24, mode: 0, mouth: 0, blink: 0 },
  { name: "crown", yaw: 0, pitch: 35, zoom: 3, targetY: 0.34, mode: 0, mouth: 0, blink: 0 },
  { name: "texture", yaw: 0, pitch: 0, zoom: 2, targetY: 0.24, mode: 1, mouth: 0, blink: 0 },
  { name: "clay", yaw: 0, pitch: 35, zoom: 3, targetY: 0.34, mode: 2, mouth: 0, blink: 0 },
  { name: "wire", yaw: 0, pitch: 35, zoom: 3, targetY: 0.34, mode: 3, mouth: 0, blink: 0 },
  { name: "normals", yaw: 0, pitch: 0, zoom: 3, targetY: 0.34, mode: 4, mouth: 0, blink: 0 },
  { name: "mouth", yaw: 0, pitch: 0, zoom: 3, targetY: 0.34, mode: 0, mouth: 1, blink: 0 },
  { name: "blink", yaw: 0, pitch: 0, zoom: 3, targetY: 0.34, mode: 0, mouth: 0, blink: 1 },
  { name: "desktop", yaw: 0, pitch: 0, zoom: 1, targetY: 0, mode: 0, mouth: 0, blink: 0 },
  { name: "sleepy", yaw: 0, pitch: 0, zoom: 4.5, targetY: 0.4, mode: 0, mouth: 0, blink: 0, sleepy: 1 },
  { name: "smile", yaw: 0, pitch: 0, zoom: 4.5, targetY: 0.4, mode: 0, mouth: 0, blink: 0, smile: 1 },
  { name: "talk", yaw: 0, pitch: 0, zoom: 4.5, targetY: 0.4, mode: 0, mouth: 0.45, blink: 0 },
  { name: "idle-a", yaw: 0, pitch: 0, zoom: 2, targetY: 0.24, mode: 0, mouth: 0, blink: 0, motionSeconds: 2.4 },
  { name: "idle-b", yaw: 0, pitch: 0, zoom: 2, targetY: 0.24, mode: 0, mouth: 0, blink: 0, motionSeconds: 8.4 },
  {
    name: "offline",
    yaw: 0,
    pitch: 0,
    zoom: 3,
    targetY: 0.34,
    mode: 0,
    mouth: 1,
    blink: 1,
    motionSeconds: 2.4,
    online: false,
  },
  { name: "yawn", yaw: 0, pitch: 0, zoom: 1.8, targetY: 0.21, mode: 0, mouth: 0, blink: 0, pose: "yawn" },
  { name: "think", yaw: 0, pitch: 0, zoom: 1.8, targetY: 0.21, mode: 0, mouth: 0, blink: 0, pose: "think" },
  { name: "greet", yaw: 0, pitch: 0, zoom: 1.8, targetY: 0.21, mode: 0, mouth: 0, blink: 0, pose: "greet" },
  {
    name: "yawn-detail",
    yaw: 0,
    pitch: 0,
    zoom: 3,
    targetY: 0.34,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "yawn",
    poseWeight: 1,
  },
  {
    name: "think-detail",
    yaw: 0,
    pitch: 0,
    zoom: 3,
    targetY: 0.34,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "think",
    poseWeight: 1,
  },
  {
    name: "greet-detail",
    yaw: 0,
    pitch: 0,
    zoom: 3,
    targetY: 0.34,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "greet",
    poseWeight: 1,
  },
  {
    name: "yawn-side",
    yaw: -45,
    pitch: 0,
    zoom: 3,
    targetY: 0.34,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "yawn",
    poseWeight: 1,
  },
  {
    name: "think-side",
    yaw: -45,
    pitch: 0,
    zoom: 3,
    targetY: 0.34,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "think",
    poseWeight: 1,
  },
  {
    name: "greet-side",
    yaw: 45,
    pitch: 0,
    zoom: 3,
    targetY: 0.34,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "greet",
    poseWeight: 1,
  },
  {
    // Turn the hanging palm toward the camera; a front view stacks its fingers.
    name: "yawn-hand",
    yaw: -65,
    pitch: 0,
    zoom: 4,
    targetY: -0.03,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "yawn",
    poseWeight: 1,
  },
  {
    name: "think-hand",
    yaw: -65,
    pitch: 0,
    zoom: 4,
    targetY: -0.03,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "think",
    poseWeight: 1,
  },
  {
    name: "greet-hand",
    yaw: 65,
    pitch: 0,
    zoom: 4,
    targetY: -0.03,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "greet",
    poseWeight: 1,
  },
  {
    name: "think-fingers",
    yaw: -75,
    pitch: 0,
    zoom: 4,
    targetY: 0.32,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "think",
    poseWeight: 1,
  },
  {
    name: "greet-fingers",
    yaw: 75,
    pitch: 0,
    zoom: 4,
    targetY: 0.36,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "greet",
    poseWeight: 1,
  },
  {
    name: "yawn-half",
    yaw: 0,
    pitch: 0,
    zoom: 1.8,
    targetY: 0.21,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "yawn",
    poseWeight: 0.5,
  },
  {
    name: "think-half",
    yaw: 0,
    pitch: 0,
    zoom: 1.8,
    targetY: 0.21,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "think",
    poseWeight: 0.5,
  },
  {
    name: "greet-half",
    yaw: 0,
    pitch: 0,
    zoom: 1.8,
    targetY: 0.21,
    mode: 0,
    mouth: 0,
    blink: 0,
    pose: "greet",
    poseWeight: 0.5,
  },
] as const;

export function comparePixels(before: Buffer, after: Buffer) {
  if (before.length !== after.length || !before.length || before.length % 4) throw new Error("截图尺寸不匹配");
  let total = 0,
    max = 0,
    changed = 0,
    beforeVisible = 0,
    afterVisible = 0;
  for (let i = 0; i < before.length; i += 4) {
    if ((before[i + 3] ?? 0) > 2) beforeVisible++;
    if ((after[i + 3] ?? 0) > 2) afterVisible++;
    let pixel = 0;
    for (let c = 0; c < 4; c++) {
      const difference = Math.abs((before[i + c] ?? 0) - (after[i + c] ?? 0));
      total += difference;
      pixel = Math.max(pixel, difference);
    }
    max = Math.max(max, pixel);
    if (pixel > 2) changed++;
  }
  if (beforeVisible < 32 || afterVisible < 32) throw new Error("截图为空，无法作为视觉验收证据");
  return {
    meanAbsoluteError: total / before.length,
    maxChannelError: max,
    pixelsOver2: changed,
    pixels: before.length / 4,
    beforeVisible,
    afterVisible,
  };
}
