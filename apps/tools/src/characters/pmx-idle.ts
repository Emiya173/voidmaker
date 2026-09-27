import type { AvatarIdleRig } from "../../../../packages/contracts/src/character.js";

type Vec3 = readonly [number, number, number];
type Bone = Readonly<{ name: string; parentIndex: number; position: Vec3 }>;
type Vertex = Readonly<{ skinIndices: readonly number[]; skinWeights: readonly number[] }>;

// Presentation joints follow this order in glTF, the Qt mesh and Character3D.
export const idleJointNames = ["root", "chest", "neck", "head", "leftEye", "rightEye"] as const;
export const idleJointParents = [-1, 0, 1, 2, 3, 3] as const;

/** Collapse the original weighted bone hierarchy to six presentation joints.
 * Original skin weights are summed, never replaced by spatial guesses. The input
 * geometry is already in its authored/relaxed rest pose; this is a new bind pose.
 */
export function createIdleRig(vertices: readonly Vertex[], bones: readonly Bone[]) {
  const required = ["上半身", "首", "頭", "左目", "右目"];
  const indices = required.map((name) => {
    const found = bones.flatMap((bone, index) => (bone.name === name ? [index] : []));
    if (found.length !== 1 || found[0] === undefined) throw new Error(`待机需要唯一骨骼：${name}`);
    return found[0];
  });
  const mapped = new Map(indices.map((index, slot) => [index, slot + 1]));
  const cache = new Map<number, number>();
  const visiting = new Set<number>();
  const joint = (index: number): number => {
    if (index === -1) return 0;
    const saved = cache.get(index);
    if (saved !== undefined) return saved;
    const bone = bones[index];
    if (!bone || visiting.has(index)) throw new Error("待机骨骼索引或层级无效");
    visiting.add(index);
    // Always visit the parent, even for a mapped bone: malformed cycles must fail.
    const inherited = joint(bone.parentIndex);
    const result = mapped.get(index) ?? inherited;
    visiting.delete(index);
    cache.set(index, result);
    return result;
  };
  bones.forEach((_, i) => {
    joint(i);
  });
  const positions: [number, number, number][] = [
    [0, 0, 0],
    ...indices.map((index) => [...(bones[index]?.position ?? [0, 0, 0])] as [number, number, number]),
  ];
  if (positions.flat().some((v) => !Number.isFinite(v))) throw new Error("待机绑定坐标无效");
  const rig: AvatarIdleRig = { version: 1, pivots: positions };
  const skin = vertices.map((vertex) => {
    if (vertex.skinIndices.length !== vertex.skinWeights.length) throw new Error("待机蒙皮权重无效");
    const total = vertex.skinWeights.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total < 0.00001 || vertex.skinWeights.some((v) => v < 0 || v > 1))
      throw new Error("待机蒙皮权重无效");
    const combined = new Map<number, number>();
    vertex.skinWeights.forEach((weight, slot) => {
      if (!weight) return;
      const original = vertex.skinIndices[slot];
      if (original === undefined || original < 0) throw new Error("待机蒙皮骨骼索引无效");
      const index = joint(original);
      combined.set(index, (combined.get(index) ?? 0) + weight / total);
    });
    const pairs = [...combined].sort(([a], [b]) => a - b);
    const joints = [0, 0, 0, 0],
      weights = [0, 0, 0, 0];
    pairs.forEach(([index, weight], slot) => {
      joints[slot] = index;
      weights[slot] = weight;
    });
    return { joints, weights };
  });
  // glTF stores column-major matrices; QML will derive the same inverse from pivots.
  const inverseBindMatrices = positions.flatMap(([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1]);
  const nodes = positions.map((position, index) => {
    const parent = idleJointParents[index] ?? -1;
    const base = positions[parent] ?? [0, 0, 0];
    return {
      name: `idle_joint_${index}`,
      translation: position.map((v, axis) => v - (base[axis] ?? 0)),
      children: idleJointParents.flatMap((p, child) => (p === index ? [child] : [])),
    };
  });
  return { rig, skin, nodes, inverseBindMatrices };
}
