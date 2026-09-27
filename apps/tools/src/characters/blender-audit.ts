import type { BlenderGeometry } from "./blender-gltf.js";
import type { PmxModel } from "./pmx.js";

const error = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));
const unit = (v: readonly number[]) => {
  const length = Math.hypot(...v);
  return v.map((n) => (length > 1e-8 ? n / length : 0));
};
const triangle = (m: number, ids: readonly number[]) => {
  const start = ids.indexOf(Math.min(...ids));
  return `${m}:${[0, 1, 2].map((i) => ids[(start + i) % 3]).join(",")}`;
};

/** Match original identities and oriented triangles, not exported vertex order/count.
 * Blender/glTF legitimately splits corners at UV seams and custom normal boundaries.
 */
export function auditBlenderGeometry(source: PmxModel, geometry: BlenderGeometry) {
  const metrics = { position: 0, normal: 0, uv: 0, outline: 0, morph: 0 };
  const changed = { position: 0, normal: 0, uv: 0, outline: 0, morph: 0 };
  const tolerances = { position: 0.00001, normal: 0.0005, uv: 0.000001, outline: 0.000001, morph: 0.00001 };
  const record = (key: keyof typeof metrics, value: number) => {
    metrics[key] = Math.max(metrics[key], value);
    if (value > tolerances[key]) changed[key]++;
  };
  let zeroNormals = 0;
  let rawNormalMaxError = 0,
    rawNormalOverTolerance = 0;
  const seen = new Set<number>();
  for (const vertex of geometry.vertices) {
    const original = source.vertices[vertex.id];
    if (!original) throw new Error("Blender 顶点 ID 越界");
    seen.add(vertex.id);
    record("position", error(vertex.position, original.position));
    if (Math.hypot(...original.normal) < 1e-8) zeroNormals++;
    record("normal", error(unit(vertex.normal), unit(original.normal)));
    const rawError = error(unit(vertex.rawNormal), unit(original.normal));
    rawNormalMaxError = Math.max(rawNormalMaxError, rawError);
    if (rawError > tolerances.normal) rawNormalOverTolerance++;
    record("uv", error(vertex.uv, original.uv));
    record("outline", Math.abs(vertex.edgeRatio - original.edgeRatio));
  }
  const faces = new Map<string, number>();
  let offset = 0;
  source.materials.forEach((m, index) => {
    for (const f of source.faces.slice(offset, offset + m.faceCount)) {
      const key = triangle(index, f.indices);
      faces.set(key, (faces.get(key) ?? 0) + 1);
    }
    offset += m.faceCount;
  });
  const parts = new Set<number>();
  let faceCount = 0;
  for (const part of geometry.parts) {
    if (!source.materials[part.material] || parts.has(part.material)) throw new Error("Blender 材质映射无效或重复");
    parts.add(part.material);
    for (let i = 0; i < part.indices.length; i += 3) {
      const ids = part.indices.slice(i, i + 3).map((n) => geometry.vertices[n]?.id ?? -1);
      const key = triangle(part.material, ids),
        remaining = faces.get(key) ?? 0;
      if (!remaining) throw new Error("Blender 拓扑、绕序或材质分配发生变化");
      faces.set(key, remaining - 1);
      faceCount++;
    }
  }
  if ([...faces.values()].some((n) => n !== 0)) throw new Error("Blender 导出遗漏三角形");
  const names = new Set<string>();
  for (const morph of geometry.morphs) {
    if (names.has(morph.name)) throw new Error("Blender 表情名称重复");
    names.add(morph.name);
    const original = source.morphs.filter((m) => m.name === morph.name && m.type === 1);
    if (original.length !== 1) throw new Error("Blender 表情映射无效");
    const before = new Map(original[0]?.elements.map((e) => [e.index, e.position ?? [0, 0, 0]]));
    const after = new Map(morph.elements.map((e) => [e.index, e.position]));
    geometry.vertices.forEach((vertex, i) => {
      record("morph", error(after.get(i) ?? [0, 0, 0], before.get(vertex.id) ?? [0, 0, 0]));
    });
  }
  return {
    passed: Object.values(changed).every((n) => n === 0),
    sourceVertices: source.vertices.length,
    exportedVertices: geometry.vertices.length,
    referencedSourceVertices: seen.size,
    triangles: faceCount,
    materials: parts.size,
    morphs: [...names],
    maxError: metrics,
    overTolerance: changed,
    tolerances,
    restoredZeroNormalCorners: zeroNormals,
    rawBlenderNormals: { maxError: rawNormalMaxError, overTolerance: rawNormalOverTolerance },
  };
}

export function applyBlenderGeometry(source: PmxModel, geometry: BlenderGeometry): PmxModel {
  auditBlenderGeometry(source, geometry); // Structural changes are rejected even for an intentional edit.
  const parts = [...geometry.parts].sort((a, b) => a.material - b.material);
  return {
    ...source,
    vertices: geometry.vertices.map((v) => {
      const original = source.vertices[v.id];
      if (!original) throw new Error("Blender 顶点 ID 越界");
      return {
        ...original,
        position: v.position,
        normal: v.normal,
        uv: v.uv,
        edgeRatio: original.edgeRatio,
      };
    }),
    faces: parts.flatMap((p) =>
      Array.from({ length: p.indices.length / 3 }, (_, i) => ({ indices: p.indices.slice(i * 3, i * 3 + 3) })),
    ),
    materials: source.materials.map((m, i) => ({
      ...m,
      faceCount: (parts.find((p) => p.material === i)?.indices.length ?? 0) / 3,
    })),
    morphs: geometry.morphs.map((m) => ({ ...m, type: 1 })),
  };
}
