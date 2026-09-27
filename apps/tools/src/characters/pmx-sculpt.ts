import type { AvatarLook } from "../../../../packages/contracts/src/character.js";

type Vec3 = readonly number[];
type Vertex = Readonly<{ position: Vec3; normal: Vec3; edgeRatio: number; uv?: readonly number[] }>;
type Sculpt = NonNullable<AvatarLook["geometry"]>[string];
const rotate = (value: Vec3, angles: Vec3): number[] => {
  const result = [...value];
  for (let axis = 0; axis < 3; axis++) {
    const a = (axis + 1) % 3,
      b = (axis + 2) % 3,
      angle = ((angles[axis] ?? 0) * Math.PI) / 180;
    const x = result[a] ?? 0,
      y = result[b] ?? 0;
    result[a] = x * Math.cos(angle) - y * Math.sin(angle);
    result[b] = x * Math.sin(angle) + y * Math.cos(angle);
  }
  return result;
};
const cross = (a: Vec3, b: Vec3) => [
  (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
  (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
  (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
];
const dot = (a: Vec3, b: Vec3) => a.reduce((sum, n, i) => sum + n * (b[i] ?? 0), 0);
const influence = (position: Vec3, brush: Sculpt["brushes"][number], uv?: readonly number[]) => {
  if (brush.uvRegion) {
    if (!uv) throw new Error("UV 选择需要顶点纹理坐标");
    if (brush.uvRegion.min.some((n, i) => (uv[i] ?? 0) < n || (uv[i] ?? 0) > (brush.uvRegion?.max[i] ?? 0))) return 0;
  }
  const distance = Math.sqrt(
    position.reduce((sum, n, i) => sum + ((n - (brush.center[i] ?? 0)) / (brush.radius[i] ?? 1)) ** 2, 0),
  );
  const t = Math.max(0, Math.min(1, (distance - brush.inner) / (1 - brush.inner)));
  return 1 - t * t * t * (t * (t * 6 - 15) + 10);
};

/** Local edits in posed PMX coordinates. Compact C2 falloff keeps seams continuous.
 * Morph endpoints use the same deformation; normals use its inverse transpose.
 */
export function sculptVertex(vertex: Vertex, sculpt?: Sculpt) {
  const deform = (position: Vec3) => {
    const result = [...position];
    for (const brush of sculpt?.brushes ?? []) {
      const weight = influence(position, brush, vertex.uv);
      brush.offset.forEach((n, i) => {
        result[i] = (result[i] ?? 0) + n * weight;
      });
    }
    const t = sculpt?.transform;
    return t
      ? rotate(
          result.map((n, i) => (n - (t.pivot[i] ?? 0)) * t.scale),
          t.rotation,
        ).map((n, i) => n + (t.pivot[i] ?? 0) + (t.translation[i] ?? 0))
      : result;
  };
  const position = deform(vertex.position);
  let normal = [...vertex.normal],
    edgeRatio = vertex.edgeRatio;
  if (sculpt) {
    const epsilon = 0.0001;
    const columns = [0, 1, 2].map((axis) => {
      const plus = deform(vertex.position.map((n, i) => n + (i === axis ? epsilon : 0)));
      const minus = deform(vertex.position.map((n, i) => n - (i === axis ? epsilon : 0)));
      return plus.map((n, i) => (n - (minus[i] ?? 0)) / (2 * epsilon));
    });
    const cofactors = [
      cross(columns[1] ?? [0, 0, 0], columns[2] ?? [0, 0, 0]),
      cross(columns[2] ?? [0, 0, 0], columns[0] ?? [0, 0, 0]),
      cross(columns[0] ?? [0, 0, 0], columns[1] ?? [0, 0, 0]),
    ];
    if (dot(columns[0] ?? [0, 0, 0], cofactors[0] ?? [0, 0, 0]) < 0.00001)
      throw new Error("局部形变造成网格翻转或塌陷");
    normal = [0, 1, 2].map((axis) =>
      cofactors.reduce((sum, column, i) => sum + (column[axis] ?? 0) * (vertex.normal[i] ?? 0), 0),
    );
    const length = Math.hypot(...normal);
    normal = normal.map((n) => (length > 0.00001 ? n / length : 0));
    for (const brush of sculpt.brushes) {
      edgeRatio *= 1 + (brush.edgeScale - 1) * influence(vertex.position, brush, vertex.uv);
    }
  }
  return {
    position,
    normal,
    edgeRatio,
    delta: (value: Vec3) =>
      deform(vertex.position.map((n, i) => n + (value[i] ?? 0))).map((n, i) => n - (position[i] ?? 0)),
  };
}
