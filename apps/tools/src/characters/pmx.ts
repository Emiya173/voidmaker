import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Parser } from "mmd-parser";
import { z } from "zod";
import { type AvatarLook, avatarLook, avatarManifest } from "../../../../packages/contracts/src/character.js";
import { applyBlenderGeometry, auditBlenderGeometry } from "./blender-audit.js";
import { readBlenderGeometry } from "./blender-gltf.js";
import { createPose, type PmxPose } from "./pmx-pose.js";
import { sculptVertex } from "./pmx-sculpt.js";

const run = promisify(execFile);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const pmxSchema = z.object({
  vertices: z
    .array(
      z.object({
        position: vec3,
        normal: vec3,
        uv: z.tuple([z.number(), z.number()]),
        edgeRatio: z.number().min(0).max(100),
        skinIndices: z.array(z.number().int()).min(1).max(4),
        // Some PMX exporters leave tiny negative residuals in BDEF4 weights.
        skinWeights: z
          .array(
            z
              .number()
              .min(-0.002)
              .max(1.002)
              .transform((v) => Math.max(0, Math.min(1, v))),
          )
          .min(1)
          .max(4),
      }),
    )
    .min(1)
    .max(500_000),
  faces: z.array(z.object({ indices: z.array(z.number().int().nonnegative()).length(3) })).max(1_000_000),
  textures: z.array(z.string()).max(128),
  materials: z
    .array(
      z.object({
        name: z.string(),
        diffuse: z.array(z.number()).length(4),
        ambient: vec3,
        specular: vec3,
        shininess: z.number().min(0).max(1000),
        edgeColor: z.array(z.number()).length(4),
        edgeSize: z.number().min(0).max(10),
        flag: z.number(),
        textureIndex: z.number().int(),
        toonFlag: z.number().int().min(0).max(1),
        toonIndex: z.number().int(),
        faceCount: z.number().int().nonnegative(),
      }),
    )
    .max(128),
  bones: z.array(z.object({ name: z.string(), parentIndex: z.number().int(), position: vec3 })).max(4096),
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
export type PmxModel = z.infer<typeof pmxSchema>;

/** Desktop presentation conversion: geometry, toon materials, static pose and vertex expressions.
 * MMD physics, VMD motion, sphere maps and runtime skeletal animation are not exported.
 */
export async function convertPmx(
  source: string,
  output: string,
  mouthName = "あ",
  blinkName = "まばたき",
  pose: PmxPose = "original",
  look: AvatarLook = { materials: {} },
  lookDirectory = dirname(source),
  blenderGltf?: string,
) {
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target);
  let staging: string | undefined;
  try {
    staging = await mkdtemp(join(dirname(target), ".pmx-"));
    const result = await convertPmxFiles(
      source,
      staging,
      mouthName,
      blinkName,
      pose,
      avatarLook.parse(look),
      lookDirectory,
      blenderGltf,
    );
    await rename(staging, target);
    return { ...result, manifest: join(target, "avatar.json") };
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rmdir(target).catch(() => undefined);
    throw error;
  }
}

async function convertPmxFiles(
  source: string,
  output: string,
  mouthName: string,
  blinkName: string,
  pose: PmxPose,
  look: AvatarLook,
  lookDirectory: string,
  blenderGltf?: string,
) {
  if ((await stat(source)).size > 64 * 1024 * 1024) throw new Error("PMX 文件过大");
  const bytes = await readFile(source);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  if (look.sourceSha256 && look.sourceSha256 !== sourceSha256) throw new Error("外观配置与源模型指纹不符");
  let pmx = pmxSchema.parse(
    new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true),
  );
  let exchange: object | undefined;
  if (blenderGltf) {
    const toolchainPath = join(dirname(blenderGltf), "blender-toolchain.json");
    if ((await stat(toolchainPath)).size > 64 * 1024) throw new Error("Blender 来源记录过大");
    const toolchain = z
      .object({ sourceSha256: z.literal(sourceSha256), blender: z.string(), mmdTools: z.string() })
      .parse(JSON.parse(await readFile(toolchainPath, "utf8")));
    const geometry = await readBlenderGeometry(blenderGltf);
    const audit = auditBlenderGeometry(pmx, geometry);
    pmx = applyBlenderGeometry(pmx, geometry);
    exchange = {
      ...toolchain,
      audit,
      gltfSha256: createHash("sha256")
        .update(await readFile(blenderGltf))
        .digest("hex"),
    };
  }
  for (const name of [...Object.keys(look.materials), ...Object.keys(look.geometry ?? {})]) {
    if (pmx.materials.filter((m) => m.name === name).length !== 1) throw new Error(`外观配置需要唯一材质：${name}`);
  }
  const morphNames = [mouthName, blinkName, ...(look.restEyes ? [look.restEyes.morph] : [])];
  if (new Set(morphNames).size !== morphNames.length) throw new Error("表情映射不能重复");
  const morphs = morphNames.map((name) => {
    const matches = pmx.morphs.filter((m) => m.name === name && m.type === 1);
    if (matches.length !== 1 || !matches[0]) throw new Error(`需要唯一顶点表情：${name}`);
    return matches[0];
  });
  const posed = createPose(pmx.vertices, pmx.bones, pose);
  const owners = new Map<number, string>();
  let materialOffset = 0;
  for (const material of pmx.materials) {
    for (const face of pmx.faces.slice(materialOffset, materialOffset + material.faceCount)) {
      for (const index of face.indices) {
        if (index >= pmx.vertices.length) throw new Error("三角形索引无效");
        const previous = owners.get(index);
        if (previous && previous !== material.name && (look.geometry?.[previous] || look.geometry?.[material.name]))
          throw new Error("局部形变不能跨共享顶点材质");
        owners.set(index, material.name);
      }
    }
    materialOffset += material.faceCount;
  }
  if (materialOffset !== pmx.faces.length) throw new Error("材质面数不匹配");
  const sculpted = posed.vertices.map((vertex, i) => {
    const original = pmx.vertices[i];
    if (!original) throw new Error("形变顶点索引无效");
    return sculptVertex(
      { ...vertex, edgeRatio: original.edgeRatio, uv: original.uv },
      look.geometry?.[owners.get(i) ?? ""],
    );
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
    sculpted.flatMap((v) => v.position),
    "VEC3",
    false,
    true,
  );
  const normal = accessor(
    sculpted.flatMap((v) => v.normal),
    "VEC3",
  );
  const uv = accessor(
    pmx.vertices.flatMap((v) => v.uv),
    "VEC2",
  );
  // A second UV channel transports the original per-vertex outline multiplier.
  const edge = accessor(
    sculpted.flatMap((v) => [v.edgeRatio, 0]),
    "VEC2",
  );
  const targets = morphs.map((morph) => {
    const deltas = Array(pmx.vertices.length * 3).fill(0) as number[];
    for (const element of morph.elements) {
      if (element.index >= pmx.vertices.length || !element.position) throw new Error("表情顶点无效");
      sculpted[element.index]?.delta(posed.delta(element.index, element.position)).forEach((v, axis) => {
        deltas[element.index * 3 + axis] = v;
      });
    }
    return { POSITION: accessor(deltas, "VEC3", false, true) };
  });
  const images: { uri: string }[] = [],
    textures: { source: number }[] = [];
  const usedTextures = new Map<number, number>();
  const textureHashes: { path: string; sha256: string; replacement?: { path: string; sha256: string } }[] = [];
  const usedOverrides = new Set<string>();
  for (const index of new Set(
    pmx.materials.flatMap((m) => [m.textureIndex, m.toonFlag === 0 ? m.toonIndex : -1]).filter((i) => i >= 0),
  )) {
    const path = pmx.textures[index]?.replaceAll("\\", "/");
    if (!path || isAbsolute(path)) throw new Error("贴图路径无效");
    const resolved = await realpath(join(root, path)),
      rel = relative(root, resolved);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || (await stat(resolved)).size > 16 * 1024 * 1024)
      throw new Error("贴图越界或过大");
    const replacement = look.textures?.[path];
    let input = resolved;
    if (replacement) {
      const lookRoot = await realpath(lookDirectory);
      input = await realpath(join(lookRoot, replacement));
      const local = relative(lookRoot, input);
      if (local === ".." || local.startsWith("../") || isAbsolute(local) || (await stat(input)).size > 16 * 1024 * 1024)
        throw new Error("替换贴图越界或过大");
      usedOverrides.add(path);
    }
    const name = `texture-${images.length}.png`;
    await run("ffmpeg", ["-v", "error", "-nostdin", "-i", input, "-frames:v", "1", join(output, name)], {
      timeout: 30_000,
    });
    usedTextures.set(index, images.length);
    textures.push({ source: images.length });
    images.push({ uri: name });
    textureHashes.push({
      path,
      ...(replacement
        ? {
            replacement: {
              path: replacement,
              sha256: createHash("sha256")
                .update(await readFile(input))
                .digest("hex"),
            },
          }
        : {}),
      sha256: createHash("sha256")
        .update(await readFile(resolved))
        .digest("hex"),
    });
  }
  if (Object.keys(look.textures ?? {}).some((path) => !usedOverrides.has(path)))
    throw new Error("替换贴图未匹配源模型");
  let faceOffset = 0;
  const primitives = pmx.materials.map((material, i) => {
    const faces = pmx.faces.slice(faceOffset, faceOffset + material.faceCount);
    faceOffset += material.faceCount;
    const indices = faces.flatMap((f) => f.indices);
    if (indices.some((n) => n >= pmx.vertices.length)) throw new Error("三角形索引无效");
    return {
      attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv, TEXCOORD_1: edge },
      indices: accessor(indices, "SCALAR", true),
      material: i,
      targets,
    };
  });
  if (faceOffset !== pmx.faces.length) throw new Error("材质面数不匹配");
  const materials = pmx.materials.map((m, i) => ({
    name: `material_${i}`,
    doubleSided: !!(m.flag & 1),
    alphaMode: m.diffuse[3] !== undefined && m.diffuse[3] < 1 ? "BLEND" : "MASK",
    alphaCutoff: 0.1,
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
        weights: morphs.map(() => 0),
        extras: { targetNames: ["mouth", "blink", ...(look.restEyes ? ["restEyes"] : [])] },
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
      "--disable-transformUVCoordinates",
      "--disable-removeComponentUVs",
      "--disable-findInvalidData",
    ],
    { timeout: 120_000 },
  );
  const bounds = [0, 1, 2].map((axis) =>
    sculpted.reduce(
      (range, v) => [
        Math.min(range[0] ?? Infinity, v.position[axis] ?? 0),
        Math.max(range[1] ?? -Infinity, v.position[axis] ?? 0),
      ],
      [Infinity, -Infinity],
    ),
  );
  const [minY, maxY] = bounds[1] as [number, number];
  const manifest = avatarManifest.parse({
    height: maxY - minY,
    centerY: (maxY + minY) / 2,
    width: (bounds[0]?.[1] ?? 0) - (bounds[0]?.[0] ?? 0),
    depth: Math.max(0.01, (bounds[2]?.[1] ?? 0) - (bounds[2]?.[0] ?? 0)),
    centerX: ((bounds[0]?.[1] ?? 0) + (bounds[0]?.[0] ?? 0)) / 2,
    framing: { yaw: 0, zoom: 1, targetY: 0 },
    ...(look.restEyes ? { restEyes: look.restEyes.weight } : {}),
    parts: pmx.materials.map((material, i) => ({
      mesh: `qt/meshes/part_${i}_mesh.mesh`,
      color: material.diffuse.map((v) => Math.max(0, Math.min(1, v))),
      doubleSided: !!(material.flag & 1),
      ...(look.materials[material.name] ? { style: look.materials[material.name] } : {}),
      toon: {
        ambient: material.ambient.map((v) => Math.max(0, Math.min(1, v))),
        specular: material.specular.map((v) => Math.max(0, Math.min(1, v))),
        shininess: material.shininess,
        edgeColor: material.edgeColor.map((v) => Math.max(0, Math.min(1, v))),
        edgeSize: material.flag & 16 ? material.edgeSize : 0,
        ...(material.toonFlag === 0 && usedTextures.has(material.toonIndex)
          ? { ramp: images[usedTextures.get(material.toonIndex) ?? -1]?.uri }
          : {}),
      },
      ...(usedTextures.has(material.textureIndex)
        ? { texture: images[usedTextures.get(material.textureIndex) ?? -1]?.uri }
        : {}),
    })),
  });
  for (const part of manifest.parts) {
    if ((await stat(join(output, part.mesh))).size < 32) throw new Error("转换网格缺失或无效");
  }
  await writeFile(join(output, "avatar.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(output, "conversion.json"),
    `${JSON.stringify(
      {
        version: 4,
        sourceSha256,
        ...(exchange ? { blender: exchange } : {}),
        textures: textureHashes,
        pose,
        armRotationDegrees: pose === "relaxed" ? { 左腕: -38, 右腕: 38 } : {},
        morphs: morphNames,
        look,
        shading: "PMX diffuse + ambient, authored toon ramps, vertex-weighted inverted hull outlines",
        limitations: [
          "static BDEF skinning (SDEF approximated)",
          "no IK, grant solver, VMD, physics or sphere maps",
          "shared toon textures use a procedural ramp",
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { parts: manifest.parts.length, height: manifest.height, manifest: join(output, "avatar.json") };
}
