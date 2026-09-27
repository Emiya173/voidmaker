import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Parser } from "mmd-parser";
import { z } from "zod";

const run = promisify(execFile);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const pmxSchema = z.object({
  vertices: z
    .array(z.object({ position: vec3, normal: vec3, uv: z.tuple([z.number(), z.number()]) }))
    .min(1)
    .max(500_000),
  faces: z.array(z.object({ indices: z.array(z.number().int().nonnegative()).length(3) })).max(1_000_000),
  textures: z.array(z.string()).max(128),
  materials: z
    .array(
      z.object({
        name: z.string(),
        diffuse: z.array(z.number()).length(4),
        flag: z.number(),
        textureIndex: z.number().int(),
        faceCount: z.number().int().nonnegative(),
      }),
    )
    .max(128),
  morphs: z
    .array(
      z.object({
        name: z.string(),
        type: z.number(),
        elements: z.array(
          z.object({
            index: z.number().int().nonnegative(),
            position: vec3.optional(),
          }),
        ),
      }),
    )
    .max(256),
});

/** Desktop presentation conversion: geometry, diffuse textures, mouth and blink.
 * MMD physics, VMD motion, toon/sphere shaders and skeletal animation are not exported.
 */
export async function convertPmx(source: string, output: string, mouthName = "あ", blinkName = "まばたき") {
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target);
  let staging: string | undefined;
  try {
    staging = await mkdtemp(join(dirname(target), ".pmx-"));
    const result = await convertPmxFiles(source, staging, mouthName, blinkName);
    await rename(staging, target);
    return { ...result, manifest: join(target, "avatar.json") };
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rmdir(target).catch(() => undefined);
    throw error;
  }
}

async function convertPmxFiles(source: string, output: string, mouthName: string, blinkName: string) {
  if ((await stat(source)).size > 64 * 1024 * 1024) throw new Error("PMX 文件过大");
  const bytes = await readFile(source);
  const pmx = pmxSchema.parse(
    new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true),
  );
  const morphs = [mouthName, blinkName].map((name) => {
    const morph = pmx.morphs.find((m) => m.name === name && m.type === 1);
    if (!morph) throw new Error(`缺少顶点表情：${name}`);
    return morph;
  });
  const root = await realpath(dirname(source));
  const binary: Buffer[] = [];
  const bufferViews: object[] = [],
    accessors: object[] = [];
  let offset = 0;
  const accessor = (values: number[], type: "SCALAR" | "VEC2" | "VEC3", indices = false, bounds = false) => {
    if (values.some((v) => !Number.isFinite(v))) throw new Error("模型数值无效");
    const data = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => {
      if (indices) data.writeUInt32LE(v, i * 4);
      else data.writeFloatLE(v, i * 4);
    });
    const view = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
    offset += data.length;
    binary.push(data);
    const size = type === "SCALAR" ? 1 : type === "VEC2" ? 2 : 3;
    const min = Array(size).fill(Infinity) as number[],
      max = Array(size).fill(-Infinity) as number[];
    if (bounds)
      values.forEach((v, i) => {
        min[i % size] = Math.min(min[i % size] ?? Infinity, v);
        max[i % size] = Math.max(max[i % size] ?? -Infinity, v);
      });
    accessors.push({
      bufferView: view,
      componentType: indices ? 5125 : 5126,
      count: values.length / size,
      type,
      ...(bounds ? { min, max } : {}),
    });
    return accessors.length - 1;
  };
  const position = accessor(
    pmx.vertices.flatMap((v) => v.position),
    "VEC3",
    false,
    true,
  );
  const normal = accessor(
    pmx.vertices.flatMap((v) => v.normal),
    "VEC3",
  );
  const uv = accessor(
    pmx.vertices.flatMap((v) => v.uv),
    "VEC2",
  );
  const targets = morphs.map((morph) => {
    const deltas = Array(pmx.vertices.length * 3).fill(0) as number[];
    for (const element of morph.elements) {
      if (element.index >= pmx.vertices.length || !element.position) throw new Error("表情顶点无效");
      element.position.forEach((v, axis) => {
        deltas[element.index * 3 + axis] = v;
      });
    }
    return { POSITION: accessor(deltas, "VEC3", false, true) };
  });
  const images: { uri: string }[] = [],
    textures: { source: number }[] = [];
  const usedTextures = new Map<number, number>();
  for (const index of new Set(pmx.materials.map((m) => m.textureIndex).filter((i) => i >= 0))) {
    const path = pmx.textures[index]?.replaceAll("\\", "/");
    if (!path || isAbsolute(path)) throw new Error("贴图路径无效");
    const resolved = await realpath(join(root, path)),
      rel = relative(root, resolved);
    if (rel.startsWith("../") || isAbsolute(rel) || (await stat(resolved)).size > 16 * 1024 * 1024)
      throw new Error("贴图越界或过大");
    const name = `texture-${images.length}.png`;
    await run("ffmpeg", ["-v", "error", "-nostdin", "-i", resolved, "-frames:v", "1", join(output, name)], {
      timeout: 30_000,
    });
    usedTextures.set(index, images.length);
    textures.push({ source: images.length });
    images.push({ uri: name });
  }
  let faceOffset = 0;
  const primitives = pmx.materials.map((material, i) => {
    const faces = pmx.faces.slice(faceOffset, faceOffset + material.faceCount);
    faceOffset += material.faceCount;
    const indices = faces.flatMap((f) => f.indices);
    if (indices.some((n) => n >= pmx.vertices.length)) throw new Error("三角形索引无效");
    return {
      attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv },
      indices: accessor(indices, "SCALAR", true),
      material: i,
      targets,
    };
  });
  if (faceOffset !== pmx.faces.length) throw new Error("材质面数不匹配");
  const materials = pmx.materials.map((m, i) => ({
    name: `material_${i}`,
    doubleSided: !!(m.flag & 1),
    alphaMode: "BLEND",
    pbrMetallicRoughness: {
      baseColorFactor: m.diffuse.map((v) => Math.max(0, Math.min(1, v))),
      metallicFactor: 0,
      roughnessFactor: 1,
      ...(usedTextures.has(m.textureIndex) ? { baseColorTexture: { index: usedTextures.get(m.textureIndex) } } : {}),
    },
  }));
  await writeFile(join(output, "avatar.bin"), Buffer.concat(binary));
  await writeFile(
    join(output, "avatar.gltf"),
    JSON.stringify({
      asset: { version: "2.0", generator: "VoidMaker PMX presentation converter" },
      scene: 0,
      scenes: [{ nodes: primitives.map((_, i) => i) }],
      nodes: primitives.map((_, i) => ({ mesh: i, name: `part_${i}` })),
      meshes: primitives.map((primitive, i) => ({
        name: `part_${i}`,
        primitives: [primitive],
        weights: [0, 0],
        extras: { targetNames: ["mouth", "blink"] },
      })),
      buffers: [{ uri: "avatar.bin", byteLength: offset }],
      bufferViews,
      accessors,
      images,
      textures,
      materials,
    }),
  );
  await run(
    "balsam",
    [
      join(output, "avatar.gltf"),
      "-o",
      join(output, "qt"),
      "--disable-generateMeshLevelsOfDetail",
      "--disable-removeRedundantMaterials",
      "--disable-optimizeMeshes",
      "--disable-optimizeGraph",
      "--disable-preTransformVertices",
    ],
    { timeout: 120_000 },
  );
  const ys = pmx.vertices.map((v) => v.position[1]);
  const minY = ys.reduce((a, b) => Math.min(a, b)),
    maxY = ys.reduce((a, b) => Math.max(a, b));
  const manifest = {
    height: maxY - minY,
    centerY: (maxY + minY) / 2,
    parts: pmx.materials.map((material, i) => ({
      mesh: `qt/meshes/part_${i}_mesh.mesh`,
      color: material.diffuse.map((v) => Math.max(0, Math.min(1, v))),
      doubleSided: !!(material.flag & 1),
      ...(usedTextures.has(material.textureIndex)
        ? { texture: images[usedTextures.get(material.textureIndex) ?? -1]?.uri }
        : {}),
    })),
  };
  await writeFile(join(output, "avatar.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { parts: manifest.parts.length, height: manifest.height, manifest: join(output, "avatar.json") };
}
