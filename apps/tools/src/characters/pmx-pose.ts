type Vec3 = readonly [number, number, number];
type Bone = Readonly<{ name: string; parentIndex: number; position: Vec3 }>;
type Vertex = Readonly<{
  position: Vec3;
  normal: Vec3;
  skinIndices: readonly number[];
  skinWeights: readonly number[];
}>;
export type PmxPose = "original" | "relaxed";
type Transform = Readonly<{ angle: number; offset: Vec3 }>;
const rotate = (v: Vec3, angle: number): [number, number, number] => [
  v[0] * Math.cos(angle) - v[1] * Math.sin(angle),
  v[0] * Math.sin(angle) + v[1] * Math.cos(angle),
  v[2],
];

/** Bake a conservative arm rest pose, including descendants and vertex morph deltas.
 * This is linear blend skinning, not an MMD IK / grant / physics evaluator.
 * SDEF vertices use their BDEF2 weights for this static presentation pose.
 */
export function createPose(vertices: readonly Vertex[], bones: readonly Bone[], pose: PmxPose) {
  if (pose === "original")
    return {
      vertices: vertices.map((v) => ({ position: [...v.position], normal: [...v.normal] })),
      delta: (_index: number, value: Vec3) => [...value],
    };
  const rotations = new Map<string, number>([
    ["左腕", -38],
    ["右腕", 38],
  ]);
  for (const name of rotations.keys()) {
    if (bones.filter((b) => b.name === name).length !== 1) throw new Error(`站姿需要唯一骨骼：${name}`);
  }
  const transforms = new Map<number, Transform>();
  const visiting = new Set<number>();
  const transform = (index: number): Transform => {
    const cached = transforms.get(index);
    if (cached) return cached;
    const bone = bones[index];
    if (!bone || visiting.has(index)) throw new Error("骨骼索引或层级无效");
    visiting.add(index);
    const parent = bone.parentIndex === -1 ? { angle: 0, offset: [0, 0, 0] as Vec3 } : transform(bone.parentIndex);
    const angle = parent.angle + ((rotations.get(bone.name) ?? 0) * Math.PI) / 180;
    const before = rotate(bone.position, parent.angle),
      after = rotate(bone.position, angle);
    const value = {
      angle,
      offset: before.map((v, i) => v + (parent.offset[i] ?? 0) - (after[i] ?? 0)) as [number, number, number],
    };
    transforms.set(index, value);
    visiting.delete(index);
    return value;
  };
  bones.forEach((_, i) => {
    transform(i);
  });
  const blend = (index: number, value: Vec3, direction: boolean): number[] => {
    const vertex = vertices[index];
    if (!vertex || vertex.skinIndices.length !== vertex.skinWeights.length) throw new Error("蒙皮权重无效");
    const total = vertex.skinWeights.reduce((sum, weight) => sum + weight, 0);
    if (!Number.isFinite(total) || total < 0.00001 || vertex.skinWeights.some((w) => w < 0 || w > 1))
      throw new Error("蒙皮权重无效");
    const result = [0, 0, 0];
    vertex.skinWeights.forEach((weight, slot) => {
      if (!weight) return; // Unused BDEF4 slots can have the sentinel index -1.
      const t = transform(vertex.skinIndices[slot] ?? -1);
      rotate(value, t.angle).forEach((v, axis) => {
        result[axis] = (result[axis] ?? 0) + (weight / total) * (v + (direction ? 0 : (t.offset[axis] ?? 0)));
      });
    });
    return result;
  };
  return {
    vertices: vertices.map((v, i) => {
      const normal = blend(i, v.normal, true),
        length = Math.hypot(...normal);
      // Collapsed, hidden expression geometry may legitimately have zero normals.
      return { position: blend(i, v.position, false), normal: normal.map((n) => (length > 0.00001 ? n / length : 0)) };
    }),
    delta: (index: number, value: Vec3) => blend(index, value, true),
  };
}
