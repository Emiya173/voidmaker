import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";

const index = z.number().int().nonnegative();
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const gltfSchema = z.object({
  asset: z.object({ version: z.literal("2.0") }),
  buffers: z
    .array(z.object({ uri: z.string(), byteLength: index }))
    .min(1)
    .max(8),
  bufferViews: z.array(
    z.object({ buffer: index, byteOffset: index.default(0), byteLength: index, byteStride: index.optional() }),
  ),
  accessors: z.array(
    z.object({
      bufferView: index.optional(),
      byteOffset: index.default(0),
      componentType: z.number(),
      count: index.max(2_000_000),
      type: z.enum(["SCALAR", "VEC2", "VEC3", "VEC4"]),
      normalized: z.boolean().optional(),
      sparse: z
        .object({
          count: index,
          indices: z.object({ bufferView: index, byteOffset: index.default(0), componentType: z.number() }),
          values: z.object({ bufferView: index, byteOffset: index.default(0) }),
        })
        .optional(),
    }),
  ),
  materials: z.array(z.object({ name: z.string() })).max(128),
  nodes: z
    .array(
      z.object({
        mesh: index,
        translation: vec3.optional(),
        rotation: z.array(z.number()).optional(),
        scale: vec3.optional(),
        matrix: z.array(z.number()).optional(),
        children: z.array(index).optional(),
      }),
    )
    .length(1),
  meshes: z
    .array(
      z.object({
        extras: z.object({ targetNames: z.array(z.string()) }),
        primitives: z.array(
          z.object({
            attributes: z.record(z.string(), index),
            indices: index,
            material: index,
            mode: z.literal(4).optional(),
            targets: z.array(z.record(z.string(), index)),
          }),
        ),
      }),
    )
    .length(1),
});

export type ExchangeVertex = {
  id: number;
  position: [number, number, number];
  normal: [number, number, number];
  rawNormal: [number, number, number];
  uv: [number, number];
  edgeRatio: number;
};
export type BlenderGeometry = {
  vertices: ExchangeVertex[];
  parts: { material: number; indices: number[] }[];
  morphs: { name: string; elements: { index: number; position: [number, number, number] }[] }[];
};

/** Read only the geometry exchange emitted by our pinned Blender adapter. No URLs,
 * arbitrary scene transforms, skins, compression or application material conversion.
 */
export async function readBlenderGeometry(path: string): Promise<BlenderGeometry> {
  if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error("Blender glTF 过大");
  const g = gltfSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const node = g.nodes[0];
  if (
    node?.mesh !== 0 ||
    node.translation?.some((v) => v !== 0) ||
    node.scale?.some((v) => v !== 1) ||
    node.matrix ||
    node.children?.length ||
    node.rotation?.some((v, i) => v !== (i === 3 ? 1 : 0))
  )
    throw new Error("Blender 导出必须应用物体变换且只含一个网格");
  const root = await realpath(dirname(path));
  const buffers: Buffer[] = [];
  for (const b of g.buffers) {
    if (isAbsolute(b.uri) || b.uri.includes(":") || b.uri.includes("\\") || b.uri.split("/").includes(".."))
      throw new Error("glTF 缓冲区路径无效");
    const location = await realpath(join(root, b.uri));
    const local = relative(root, location);
    if (
      local.startsWith("../") ||
      isAbsolute(local) ||
      b.byteLength > 256 * 1024 * 1024 ||
      (await stat(location)).size !== b.byteLength
    )
      throw new Error("glTF 缓冲区越界或大小不符");
    buffers.push(await readFile(location));
  }
  const size = (type: number) => ({ 5121: 1, 5123: 2, 5125: 4, 5126: 4 })[type];
  const read = (viewIndex: number, offset: number, type: number) => {
    const view = g.bufferViews[viewIndex],
      bytes = size(type);
    if (!view || !bytes) throw new Error("glTF 缓冲区类型无效");
    const buffer = buffers[view.buffer];
    if (!buffer || offset < 0 || offset + bytes > view.byteLength || view.byteOffset + offset + bytes > buffer.length)
      throw new Error("glTF 访问器越界");
    const at = view.byteOffset + offset;
    return type === 5126
      ? buffer.readFloatLE(at)
      : type === 5125
        ? buffer.readUInt32LE(at)
        : type === 5123
          ? buffer.readUInt16LE(at)
          : buffer.readUInt8(at);
  };
  const cache = new Map<number, number[][]>();
  const accessor = (id: number | undefined, type: "SCALAR" | "VEC2" | "VEC3") => {
    if (id === undefined) throw new Error(`Blender 导出缺少 ${type} 属性`);
    const a = g.accessors[id];
    if (!a || a.type !== type || a.normalized) throw new Error("glTF 访问器类型不匹配");
    const cached = cache.get(id);
    if (cached) return cached;
    const bytes = size(a.componentType),
      width = type === "SCALAR" ? 1 : type === "VEC2" ? 2 : 3;
    if (!bytes) throw new Error("glTF 访问器类型无效");
    const stride = (a.bufferView === undefined ? undefined : g.bufferViews[a.bufferView]?.byteStride) ?? bytes * width;
    if (stride < bytes * width) throw new Error("glTF 访问器步长无效");
    const values = Array.from({ length: a.count }, (_, i) =>
      Array.from({ length: width }, (_, j) =>
        a.bufferView === undefined ? 0 : read(a.bufferView, a.byteOffset + i * stride + j * bytes, a.componentType),
      ),
    );
    if (a.sparse) {
      const sparseBytes = size(a.sparse.indices.componentType);
      if (!sparseBytes || a.sparse.indices.componentType === 5126 || a.sparse.count > a.count)
        throw new Error("glTF 稀疏访问器无效");
      let previous = -1;
      for (let i = 0; i < a.sparse.count; i++) {
        const target = read(
          a.sparse.indices.bufferView,
          a.sparse.indices.byteOffset + i * sparseBytes,
          a.sparse.indices.componentType,
        );
        if (target <= previous || target >= a.count) throw new Error("glTF 稀疏索引无效");
        previous = target;
        values[target] = Array.from({ length: width }, (_, j) =>
          read(
            a.sparse?.values.bufferView ?? -1,
            (a.sparse?.values.byteOffset ?? 0) + (i * width + j) * bytes,
            a.componentType,
          ),
        );
      }
    }
    if (values.some((v) => v.some((n) => !Number.isFinite(n)))) throw new Error("glTF 属性含无效数值");
    cache.set(id, values);
    return values;
  };
  const mesh = g.meshes[0];
  if (!mesh) throw new Error("Blender 网格缺失");
  const result: BlenderGeometry = {
    vertices: [],
    parts: [],
    morphs: mesh.extras.targetNames.map((name) => ({ name, elements: [] })),
  };
  for (const p of mesh.primitives) {
    const materialName = g.materials[p.material]?.name;
    if (!materialName || !/^pmx_\d+$/.test(materialName)) throw new Error("Blender 材质映射缺失");
    const positions = accessor(p.attributes.POSITION, "VEC3"),
      normals = accessor(p.attributes._VM_NORMAL, "VEC3"),
      rawNormals = accessor(p.attributes.NORMAL, "VEC3"),
      uv = accessor(p.attributes.TEXCOORD_0, "VEC2"),
      ids = accessor(p.attributes._PMX_ID, "SCALAR"),
      edges = accessor(p.attributes._PMX_EDGE, "SCALAR");
    if (
      [normals, rawNormals, uv, ids, edges].some((a) => a.length !== positions.length) ||
      p.targets.length !== result.morphs.length
    )
      throw new Error("Blender 顶点或表情数量不符");
    const offset = result.vertices.length;
    positions.forEach((position, i) => {
      const id = ids[i]?.[0];
      if (id === undefined || !Number.isInteger(id) || id < 0) throw new Error("原始顶点 ID 无效");
      result.vertices.push({
        id,
        position: vec3.parse(position),
        normal: vec3.parse(normals[i]),
        rawNormal: vec3.parse(rawNormals[i]),
        uv: z.tuple([z.number(), z.number()]).parse(uv[i]),
        edgeRatio: z.number().min(0).max(100).parse(edges[i]?.[0]),
      });
    });
    const indices = accessor(p.indices, "SCALAR").map((v) => {
      const i = v[0];
      if (i === undefined || !Number.isInteger(i) || i < 0 || i >= positions.length)
        throw new Error("Blender 三角形索引无效");
      return i + offset;
    });
    if (indices.length % 3 || result.vertices.length > 500_000) throw new Error("Blender 网格数量无效");
    result.parts.push({ material: Number(materialName.slice(4)), indices });
    p.targets.forEach((target, m) => {
      const values = accessor(target.POSITION, "VEC3");
      if (values.length !== positions.length) throw new Error("Blender 表情顶点数量不符");
      values.forEach((v, i) => {
        if (v.some((n) => n !== 0)) result.morphs[m]?.elements.push({ index: offset + i, position: vec3.parse(v) });
      });
    });
  }
  return result;
}
