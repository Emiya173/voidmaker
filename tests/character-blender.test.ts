import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Parser } from "mmd-parser";
import { expect, it } from "vitest";
import { applyBlenderGeometry, auditBlenderGeometry } from "../apps/tools/src/characters/blender-audit.js";
import { type BlenderGeometry, readBlenderGeometry } from "../apps/tools/src/characters/blender-gltf.js";
import { pmxSchema } from "../apps/tools/src/characters/pmx.js";
import { comparePixels } from "../apps/tools/src/characters/preview.js";
import { trianglePmx } from "./helpers/pmx.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Incomplete test fixture");
  return value;
}

function fixture() {
  const bytes = trianglePmx();
  const source = pmxSchema.parse(
    new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true),
  );
  const order = [2, 0, 1, 0]; // glTF may reorder and split original vertices.
  const geometry: BlenderGeometry = {
    vertices: order.map((id) => ({ ...required(source.vertices[id]), id, rawNormal: [1, 0, 0] })),
    parts: [{ material: 0, indices: required(source.faces[0]).indices.map((id) => order.indexOf(id)) }],
    morphs: source.morphs.map((m) => ({
      name: m.name,
      elements: order.flatMap((id, index) =>
        m.elements.filter((e) => e.index === id).map((e) => ({ index, position: required(e.position) })),
      ),
    })),
  };
  return { source, geometry };
}

it("audits identities, split vertices, authored normals and morphs independently of glTF order", () => {
  const { source, geometry } = fixture();
  const audit = auditBlenderGeometry(source, geometry);
  expect(audit).toMatchObject({
    passed: true,
    sourceVertices: 3,
    exportedVertices: 4,
    rawBlenderNormals: { overTolerance: 4 },
  });
  const result = applyBlenderGeometry(source, geometry);
  expect(result.vertices[1]).toEqual(source.vertices[0]);
  expect(result.vertices[3]).toEqual(source.vertices[0]);
  expect(result.materials).toEqual(source.materials);
  expect(result.morphs[0]?.elements.map((e) => e.index)).toEqual([1, 3]);
  required(geometry.vertices[1]).position = [1, 12, 0];
  required(geometry.vertices[1]).normal = [0, 1, 0];
  required(geometry.vertices[1]).edgeRatio = 0.25;
  expect(auditBlenderGeometry(source, geometry)).toMatchObject({
    passed: false,
    overTolerance: { position: 1, normal: 1, outline: 1 },
  });
  expect(applyBlenderGeometry(source, geometry).vertices[1]).toMatchObject({
    position: [1, 12, 0],
    normal: [0, 1, 0],
    edgeRatio: 0.25,
  });
});

it("rejects lost faces, changed winding, wrong material assignments and expression damage", () => {
  const { source, geometry } = fixture();
  const flipped = structuredClone(geometry);
  required(flipped.parts[0]).indices.reverse();
  expect(() => applyBlenderGeometry(source, flipped)).toThrow("绕序");
  expect(() => auditBlenderGeometry(source, { ...geometry, parts: [] })).toThrow("遗漏");
  expect(() => auditBlenderGeometry(source, { ...geometry, parts: [{ material: 99, indices: [0, 1, 2] }] })).toThrow(
    "材质",
  );
  required(geometry.morphs[0]).elements = [];
  expect(auditBlenderGeometry(source, geometry)).toMatchObject({ passed: false, overTolerance: { morph: 2 } });
});

it("localizes edited normals and edge weights to their material without counting repeated triangle corners", () => {
  const { source, geometry } = fixture();
  source.materials.push({ ...required(source.materials[0]), name: "untouched" });
  source.faces.push(structuredClone(required(source.faces[0])), structuredClone(required(source.faces[0])));
  required(source.materials[0]).faceCount = 2;
  const firstPart = required(geometry.parts[0]);
  geometry.parts.push({ material: 1, indices: firstPart.indices.map((i) => (i === 1 ? 3 : i)) });
  firstPart.indices.push(...firstPart.indices);
  required(geometry.vertices[1]).normal = [0, 1, 0];
  required(geometry.vertices[1]).edgeRatio = 0.25;
  const audit = auditBlenderGeometry(source, geometry);
  expect(audit.byMaterial).toMatchObject([
    { material: 0, vertices: 3, overTolerance: { normal: 1, outline: 1, position: 0, uv: 0, morph: 0 } },
    { material: 1, name: "untouched", overTolerance: { normal: 0, outline: 0, position: 0, uv: 0, morph: 0 } },
  ]);
});

it("reads sparse morphs and rejects corrupt bounds and external buffer paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "voidmaker-gltf-"));
  try {
    const buffers: Buffer[] = [];
    const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
    const accessors: object[] = [];
    let offset = 0;
    const data = (values: number[], type: string, width: number) => {
      const buffer = Buffer.alloc(values.length * 4);
      values.forEach((v, i) => {
        buffer.writeFloatLE(v, i * 4);
      });
      buffers.push(buffer);
      views.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length });
      offset += buffer.length;
      accessors.push({ bufferView: views.length - 1, componentType: 5126, count: values.length / width, type });
      return accessors.length - 1;
    };
    const attributes = {
      POSITION: data([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", 3),
      NORMAL: data([0, 0, 1, 0, 0, 1, 0, 0, 1], "VEC3", 3),
      _VM_NORMAL: data([0, 0, 1, 0, 0, 1, 0, 0, 1], "VEC3", 3),
      TEXCOORD_0: data([0, 0, 1, 0, 0, 1], "VEC2", 2),
      _PMX_ID: data([0, 1, 2], "SCALAR", 1),
      _PMX_EDGE: data([0, 0.5, 1], "SCALAR", 1),
    };
    const indices = data([0, 0, 0], "SCALAR", 1);
    required(buffers[buffers.length - 1]).writeUInt32LE(0, 0);
    required(buffers[buffers.length - 1]).writeUInt32LE(1, 4);
    required(buffers[buffers.length - 1]).writeUInt32LE(2, 8);
    accessors[indices] = { ...accessors[indices], componentType: 5125 };
    const sparseIndex = data([0], "SCALAR", 1);
    required(buffers[buffers.length - 1]).writeUInt32LE(1, 0);
    const sparseValues = data([0, 0.25, 0], "VEC3", 3);
    const target = accessors.length;
    accessors.push({
      componentType: 5126,
      count: 3,
      type: "VEC3",
      sparse: {
        count: 1,
        indices: { bufferView: sparseIndex, componentType: 5125 },
        values: { bufferView: sparseValues },
      },
    });
    const gltf = {
      asset: { version: "2.0" },
      buffers: [{ uri: "mesh.bin", byteLength: offset }],
      bufferViews: views,
      accessors,
      nodes: [{ mesh: 0 }],
      materials: [{ name: "pmx_0" }],
      meshes: [
        {
          extras: { targetNames: ["あ"] },
          primitives: [{ attributes, indices, material: 0, targets: [{ POSITION: target }] }],
        },
      ],
    };
    const path = join(root, "mesh.gltf");
    await writeFile(join(root, "mesh.bin"), Buffer.concat(buffers));
    await writeFile(path, JSON.stringify(gltf));
    const geometry = await readBlenderGeometry(path);
    expect(geometry.morphs[0]?.elements).toEqual([{ index: 1, position: [0, 0.25, 0] }]);
    expect(geometry.vertices.map((v) => v.edgeRatio)).toEqual([0, 0.5, 1]);
    required(buffers[attributes._PMX_EDGE]).writeFloatLE(-0.1, 0);
    await writeFile(join(root, "mesh.bin"), Buffer.concat(buffers));
    await expect(readBlenderGeometry(path)).rejects.toThrow();
    required(buffers[attributes._PMX_EDGE]).writeFloatLE(0, 0);
    await writeFile(join(root, "mesh.bin"), Buffer.concat(buffers));
    required(views[0]).byteLength = 1;
    await writeFile(path, JSON.stringify(gltf));
    await expect(readBlenderGeometry(path)).rejects.toThrow("越界");
    required(gltf.buffers[0]).uri = "../outside.bin";
    await writeFile(path, JSON.stringify(gltf));
    await expect(readBlenderGeometry(path)).rejects.toThrow("路径无效");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not accept matching empty screenshots as visual verification", () => {
  const empty = Buffer.alloc(256);
  expect(() => comparePixels(empty, empty)).toThrow("截图为空");
  const opaque = Buffer.alloc(256, 255);
  expect(comparePixels(opaque, opaque)).toMatchObject({ meanAbsoluteError: 0, pixels: 64, beforeVisible: 64 });
});

it.skipIf(process.env.VOIDMAKER_BLENDER_SMOKE !== "1")(
  "roundtrips a self-authored PMX through pinned Blender and real Balsam",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "voidmaker-blender-"));
    try {
      const source = join(root, "triangle.pmx"),
        output = join(root, "baseline");
      await writeFile(source, trianglePmx());
      const bmp = Buffer.alloc(58);
      bmp.write("BM");
      bmp.writeUInt32LE(58, 2);
      bmp.writeUInt32LE(54, 10);
      bmp.writeUInt32LE(40, 14);
      bmp.writeInt32LE(1, 18);
      bmp.writeInt32LE(1, 22);
      bmp.writeUInt16LE(1, 26);
      bmp.writeUInt16LE(24, 28);
      bmp.fill(255, 54);
      await writeFile(join(root, "toon.png"), bmp);
      const run = promisify(execFile);
      await run("pnpm", ["character:roundtrip", source, output], { timeout: 120_000 });
      expect(JSON.parse(await readFile(join(output, "audit.json"), "utf8"))).toMatchObject({
        passed: true,
        sourceVertices: 3,
        triangles: 1,
      });
      const reopened = join(root, "reopened");
      await run("pnpm", ["character:roundtrip", source, reopened, "--blend", join(output, "baseline.blend")], {
        timeout: 120_000,
      });
      expect(JSON.parse(await readFile(join(reopened, "audit.json"), "utf8"))).toMatchObject({ passed: true });
      // A control rig adds mesh widgets and may be saved in Pose Mode. Export
      // only the mesh carrying our source snapshots, without evaluating posing.
      const riggedBlend = join(root, "rigged.blend");
      const rigged = [
        "import bpy",
        `bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(join(output, "baseline.blend"))}, use_scripts=False)`,
        "mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH')",
        "mesh.data.shape_keys.key_blocks[1].value = 0.7",
        "skin = next(m.object for m in mesh.modifiers if m.type == 'ARMATURE')",
        "skin.data.pose_position = 'POSE'",
        "skin.pose.bones[0].location.x = 3",
        "bpy.context.view_layer.update()",
        "posed = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())",
        "assert max((a.co - b.co).length for a, b in zip(posed.data.vertices, mesh.data.vertices)) > 1",
        "bpy.ops.mesh.primitive_cube_add()",
        "widget = bpy.context.object",
        "widget.name = 'Control widget'",
        "bpy.ops.object.armature_add()",
        "rig = bpy.context.object",
        "bpy.ops.object.mode_set(mode='POSE')",
        "rig.pose.bones[0].custom_shape = widget",
        "rig.pose.bones[0].location.x = 7",
        `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(riggedBlend)})`,
      ].join("\n");
      await run(
        "blender",
        ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python-expr", rigged],
        { timeout: 120_000 },
      );
      const riggedOutput = join(root, "rigged-output");
      await run("pnpm", ["character:roundtrip", source, riggedOutput, "--blend", riggedBlend], { timeout: 120_000 });
      expect(JSON.parse(await readFile(join(riggedOutput, "audit.json"), "utf8"))).toMatchObject({
        passed: true,
        toolchain: { ignoredSceneMeshes: ["Control widget"] },
      });
      const ambiguousBlend = join(root, "ambiguous.blend");
      const ambiguous = [
        "import bpy",
        `bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(riggedBlend)}, use_scripts=False)`,
        "bpy.ops.object.mode_set(mode='OBJECT')",
        "mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH' and '_PMX_ID' in o.data.attributes)",
        "bpy.context.scene.collection.objects.link(mesh.copy())",
        `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(ambiguousBlend)})`,
      ].join("\n");
      await run(
        "blender",
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--python-exit-code",
          "1",
          "--python-expr",
          ambiguous,
        ],
        { timeout: 120_000 },
      );
      await expect(
        run("pnpm", ["character:roundtrip", source, join(root, "ambiguous-output"), "--blend", ambiguousBlend], {
          timeout: 120_000,
        }),
      ).rejects.toThrow("Expected one PMX mesh");
      const editedBlend = join(root, "edited.blend");
      const edit = [
        "import bpy",
        `bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(join(output, "baseline.blend"))}, use_scripts=False)`,
        "obj = next(o for o in bpy.context.scene.objects if o.type == 'MESH')",
        "for key in obj.data.shape_keys.key_blocks: key.data[0].co.y += 0.25",
        "obj.data.normals_split_custom_set_from_vertices([(1, 0, 0)] * 3)",
        `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(editedBlend)})`,
      ].join("\n");
      await run(
        "blender",
        ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python-expr", edit],
        { timeout: 120_000 },
      );
      const rejected = join(root, "rejected");
      await expect(
        run("pnpm", ["character:roundtrip", source, rejected, "--blend", editedBlend], { timeout: 120_000 }),
      ).rejects.toThrow("超出容差");
      expect(JSON.parse(await readFile(join(rejected, "audit.json"), "utf8"))).toMatchObject({
        passed: false,
        overTolerance: { position: 1, normal: 3 },
      });
      const edited = join(root, "edited");
      await run("pnpm", ["character:roundtrip", source, edited, "--blend", editedBlend, "--allow-edits"], {
        timeout: 120_000,
      });
      expect(JSON.parse(await readFile(join(edited, "audit.json"), "utf8"))).toMatchObject({
        passed: false,
        intentionalEdits: true,
        toolchain: { preservedNormalCorners: 0, editedNormalCorners: 3 },
      });
      await expect(run("pnpm", ["character:roundtrip", source, reopened], { timeout: 120_000 })).rejects.toThrow(
        "EEXIST",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
