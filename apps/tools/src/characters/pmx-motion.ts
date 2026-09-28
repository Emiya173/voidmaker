import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { assetPath, boundedFile } from "../../../../packages/adapters/src/character-assets.js";
import {
  motionLimits,
  motionRigFile,
  validateMotionClip,
} from "../../../../packages/contracts/src/character-motion.js";

type Rig = z.infer<typeof motionRigFile>;
type Vec = readonly number[];
type Model = Readonly<{
  bones: readonly Readonly<{ name: string }>[];
  vertices: readonly Readonly<{ skinIndices: readonly number[]; skinWeights: readonly number[] }>[];
}>;

function multiply(a: Vec, b: Vec): number[] {
  const [w = 1, x = 0, y = 0, z = 0] = a;
  const [v = 1, i = 0, j = 0, k = 0] = b;
  return [
    w * v - x * i - y * j - z * k,
    w * i + x * v + y * k - z * j,
    w * j - x * k + y * v + z * i,
    w * k + x * j - y * i + z * v,
  ];
}

function rotate(q: Vec, p: Vec): number[] {
  const [w = 1, x = 0, y = 0, z = 0] = q;
  const [a = 0, b = 0, c = 0] = p;
  const tx = 2 * (y * c - z * b),
    ty = 2 * (z * a - x * c),
    tz = 2 * (x * b - y * a);
  return [a + w * tx + y * tz - z * ty, b + w * ty + z * tx - x * tz, c + w * tz + x * ty - y * tx];
}

/** Keep every original influence. Neutral is a pose, never a second baked bind. */
export function createMotionSkin(model: Model, rig: Rig) {
  const names = new Map(rig.joints.map((joint, index) => [joint.name, index]));
  const sourceNames = new Set<string>();
  for (const bone of model.bones) {
    if (sourceNames.has(bone.name)) throw new Error(`动作绑定需要唯一源骨骼：${bone.name}`);
    sourceNames.add(bone.name);
  }
  const skin = model.vertices.map((vertex) => {
    if (vertex.skinIndices.length !== vertex.skinWeights.length || vertex.skinWeights.length > 4)
      throw new Error("动作蒙皮权重数量无效");
    const sum = vertex.skinWeights.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(sum) || sum <= 0 || vertex.skinWeights.some((n) => !Number.isFinite(n) || n < 0 || n > 1))
      throw new Error("动作蒙皮权重无效");
    const joints = [0, 0, 0, 0],
      weights = [0, 0, 0, 0];
    vertex.skinWeights.forEach((weight, slot) => {
      if (!weight) return;
      const bone = model.bones[vertex.skinIndices[slot] ?? -1];
      const index = bone ? names.get(bone.name) : undefined;
      if (index === undefined) throw new Error(`动作骨架缺少蒙皮骨骼：${bone?.name ?? "索引无效"}`);
      joints[slot] = index;
      weights[slot] = weight / sum;
    });
    return { joints, weights };
  });
  const nodes = rig.joints.map((joint, index) => ({
    name: `motion_joint_${index}`,
    translation: joint.translation,
    rotation: [joint.rotation[1], joint.rotation[2], joint.rotation[3], joint.rotation[0]],
    children: rig.joints.flatMap((child, i) => (child.parent === index ? [i] : [])),
  }));
  const inverseBindMatrices = rig.joints.flatMap((joint) =>
    Array.from({ length: 16 }, (_, index) => joint.inverseBind[(index % 4) * 4 + Math.floor(index / 4)] ?? 0),
  );
  const globals: { translation: number[]; rotation: number[] }[] = [];
  for (const joint of rig.joints) {
    const parent = globals[joint.parent];
    globals.push(
      parent
        ? {
            translation: rotate(parent.rotation, joint.translation).map((n, i) => n + (parent.translation[i] ?? 0)),
            rotation: multiply(parent.rotation, joint.rotation),
          }
        : { translation: [...joint.translation], rotation: [...joint.rotation] },
    );
  }
  const neutralPosition = (point: Vec, vertex: number): number[] => {
    const binding = skin[vertex];
    if (!binding) throw new Error("动作蒙皮顶点越界");
    const result = [0, 0, 0];
    binding.weights.forEach((weight, slot) => {
      if (!weight) return;
      const index = binding.joints[slot] ?? -1,
        joint = rig.joints[index],
        global = globals[index];
      if (!joint || !global) throw new Error("动作蒙皮关节越界");
      const local = [0, 1, 2].map(
        (row) =>
          (joint.inverseBind[row * 4] ?? 0) * (point[0] ?? 0) +
          (joint.inverseBind[row * 4 + 1] ?? 0) * (point[1] ?? 0) +
          (joint.inverseBind[row * 4 + 2] ?? 0) * (point[2] ?? 0) +
          (joint.inverseBind[row * 4 + 3] ?? 0),
      );
      rotate(global.rotation, local).forEach((n, axis) => {
        result[axis] = (result[axis] ?? 0) + weight * (n + (global.translation[axis] ?? 0));
      });
    });
    return result;
  };
  return { skin, nodes, inverseBindMatrices, neutralPosition };
}

/** Copy only validated numeric resources into the atomic conversion staging dir. */
export async function prepareMotionRig(model: Model, sourceSha256: string, root: string, path: string, output: string) {
  const source = await assetPath(await realpath(root), path);
  const bytes = await boundedFile(source, motionLimits.rigBytes);
  const rig = motionRigFile.parse(JSON.parse(bytes.toString("utf8")));
  if (rig.sourceSha256 !== sourceSha256) throw new Error("动作骨架与源模型指纹不符");
  const result = createMotionSkin(model, rig);
  const clips = [];
  const requiredFaceTargets: Rig["clips"][number]["name"][] = [];
  const clipHashes = [];
  const destination = join(output, "motions");
  await mkdir(destination);
  for (const descriptor of rig.clips) {
    const file = await assetPath(dirname(source), descriptor.file);
    const data = await boundedFile(file, motionLimits.clipBytes);
    const clip = validateMotionClip(JSON.parse(data.toString("utf8")), rig.joints, descriptor.duration);
    if (clip.expression.some((key) => key.weight > 0)) requiredFaceTargets.push(descriptor.name);
    const name = `${descriptor.name}.json`;
    await writeFile(join(destination, name), data);
    clips.push({ ...descriptor, file: name });
    clipHashes.push({ name: descriptor.name, sha256: createHash("sha256").update(data).digest("hex") });
  }
  await writeFile(join(destination, "rig.json"), `${JSON.stringify({ ...rig, clips })}\n`);
  return {
    ...result,
    rig,
    requiredFaceTargets,
    manifestPath: "motions/rig.json",
    provenance: {
      rigSha256: createHash("sha256").update(bytes).digest("hex"),
      clips: clipHashes,
      joints: rig.joints.length,
      weights: "original PMX influences without ancestor aggregation",
      bindPose: "original source rest",
    },
  };
}
