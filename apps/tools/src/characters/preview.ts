import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { assetPath, boundedFile } from "../../../../packages/adapters/src/character-assets.js";
import { readMotionRig } from "../../../../packages/adapters/src/character-motion.js";
import { avatarManifest } from "../../../../packages/contracts/src/character.js";

/** Load local previews without the Host, a session, or any voice device. */
export async function readPreview(path: string) {
  const manifest = avatarManifest.parse(
    JSON.parse((await boundedFile(await realpath(path), 256 * 1024)).toString("utf8")),
  );
  const root = await realpath(dirname(path));
  const assetUrl = async (name: string | undefined) => {
    if (!name) return "";
    const file = await assetPath(root, name);
    if (!(await stat(file)).isFile()) throw new Error("预览素材类型无效");
    return pathToFileURL(file).href;
  };
  const { motionRig, ...appearance } = manifest;
  return {
    ...appearance,
    ...(motionRig ? { motionRig: await readMotionRig(root, motionRig, manifest.poses ?? []) } : {}),
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
  ...(["yawn", "think", "greet"] as const).flatMap((action) => [
    ...(
      [
        ["enter", 0.16],
        ["hold", 0.5],
        ["return", 0.86],
        ["end", 1],
      ] as const
    ).map(([phase, actionProgress]) => ({
      name: `${action}-${phase}`,
      yaw: 0,
      pitch: 0,
      zoom: 1.55,
      targetY: 0.21,
      mode: 0,
      mouth: 0,
      blink: 0,
      action,
      actionProgress,
    })),
    {
      name: `${action}-hold-side`,
      yaw: action === "greet" ? 45 : -45,
      pitch: 0,
      zoom: 3,
      targetY: 0.34,
      mode: 0,
      mouth: 0,
      blink: 0,
      action,
      actionProgress: 0.5,
    },
  ]),
  ...[
    { phase: "start", seconds: 3.35, targetY: 0.23, frontX: -0.04, sideX: -0.1 },
    { phase: "a", seconds: 3.5, targetY: 0.217, frontX: -0.048, sideX: -0.113 },
    { phase: "b", seconds: 3.9, targetY: 0.157, frontX: -0.154, sideX: -0.222 },
    { phase: "c", seconds: 4.15, targetY: 0.102, frontX: -0.21, sideX: -0.228 },
    { phase: "d", seconds: 4.4, targetY: 0.06, frontX: -0.203, sideX: -0.17 },
    { phase: "e", seconds: 4.6, targetY: 0.041, frontX: -0.175, sideX: -0.121 },
  ].flatMap(({ phase, seconds, targetY, frontX, sideX }) =>
    [false, true].map((side) => ({
      name: `think-retract-${phase}${side ? "-side" : ""}`,
      yaw: side ? -45 : 0,
      pitch: 0,
      zoom: 4,
      targetX: side ? sideX : frontX,
      targetY,
      mode: 0,
      mouth: 0,
      blink: 0,
      action: "think",
      actionProgress: seconds / 4.8,
    })),
  ),
  ...(
    [
      ["enter", 0.25],
      ["hold", 0.5],
      ["return", 0.8],
    ] as const
  ).map(([phase, actionProgress]) => ({
    name: `greet-look-${phase}-side`,
    yaw: 75,
    pitch: 0,
    zoom: 2.5,
    targetY: 0.31,
    mode: 0,
    mouth: 0,
    blink: 0,
    action: "greet",
    actionProgress,
  })),
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
