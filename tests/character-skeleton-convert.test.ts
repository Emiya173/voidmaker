import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { convertPmx } from "../apps/tools/src/characters/pmx.js";
import { createMotionSkin, prepareMotionRig } from "../apps/tools/src/characters/pmx-motion.js";
import { readPreview } from "../apps/tools/src/characters/preview.js";
import { avatarLook, avatarManifest } from "../packages/contracts/src/character.js";
import { motionRigFile } from "../packages/contracts/src/character-motion.js";
import { trianglePmx } from "./helpers/pmx.js";

const inverseTranslation = (x: number, y: number, z: number) => [
  1,
  0,
  0,
  x ? -x : 0,
  0,
  1,
  0,
  y ? -y : 0,
  0,
  0,
  1,
  z ? -z : 0,
  0,
  0,
  0,
  1,
];
const clip = {
  version: 1,
  duration: 1,
  tracks: [
    {
      joint: 0,
      times: [0, 0.5, 1],
      translations: [
        [0, 2, 0],
        [0, 3, 0],
        [0, 2, 0],
      ],
    },
  ],
  expression: [],
};
const sourceSkin = [
  { bones: [5, 6, 7, 1], weights: [0.1, 0.2, 0.3, 0.4] },
  { bones: [5, 6, 7, 2], weights: [0.4, 0.3, 0.2, 0.1] },
  { bones: [7, 6, 5, 0], weights: [0.25, 0.25, 0.25, 0.25] },
];

function fixtureRig(sourceSha256: string) {
  const joints = [
    ["root", -1, [0, 2, 0], [0, 0, 0]],
    ["上半身", 0, [0, 10, 0], [0, 10, 0]],
    ["首", 1, [0, 0, 0], [0, 10, 0]],
    ["頭", 2, [0, 0, 0], [0, 10, 0]],
    ["左腕", 1, [1, 0, 0], [1, 10, 0]],
    ["右腕", 1, [-1, 0, 0], [-1, 10, 0]],
    ["左目", 3, [0, 0, 0], [0, 10, 0]],
    ["右目", 3, [0, 0, 0], [0, 10, 0]],
  ] as const;
  return motionRigFile.parse({
    version: 1,
    sourceSha256,
    joints: joints.map(([name, parent, translation, source]) => ({
      name,
      parent,
      translation,
      rotation: [1, 0, 0, 0],
      inverseBind: inverseTranslation(...source),
    })),
    clips: [{ name: "yawn", file: "source-yawn.json", duration: 1 }],
  });
}

async function writeFixture(root: string) {
  const bytes = trianglePmx(false, true, true, sourceSkin);
  const rig = fixtureRig(createHash("sha256").update(bytes).digest("hex"));
  await writeFile(join(root, "source.pmx"), bytes);
  await writeFile(join(root, "rig.json"), JSON.stringify(rig));
  await writeFile(join(root, "source-yawn.json"), JSON.stringify(clip));
  return { bytes, rig, look: avatarLook.parse({ motionRig: "rig.json" }) };
}

it("preserves all original influences by name without ancestor aggregation or slot collapse", () => {
  const rig = fixtureRig("a".repeat(64));
  const source = {
    bones: ["右目", "左腕", "root"].map((name) => ({ name })),
    vertices: [
      { skinIndices: [0, 1, 0, 2], skinWeights: [0.1, 0.2, 0.3, 0.4] },
      { skinIndices: [1, -1, -1, -1], skinWeights: [1, 0, 0, 0] },
    ],
  };
  const result = createMotionSkin(source, rig);
  expect(result.skin).toEqual([
    { joints: [7, 4, 7, 0], weights: [0.1, 0.2, 0.3, 0.4] },
    { joints: [4, 0, 0, 0], weights: [1, 0, 0, 0] },
  ]);
  expect(source.vertices[0]?.skinWeights).toEqual([0.1, 0.2, 0.3, 0.4]);
  expect(result.nodes.map((node) => node.name)).toEqual(rig.joints.map((_, i) => `motion_joint_${i}`));
  expect(result.nodes[0]?.children).toEqual([1]);
  expect(result.nodes[1]?.children).toEqual([2, 4, 5]);
});

it("uses row-major source inverse binds and hierarchical WXYZ neutral transforms exactly once", () => {
  const q = Math.SQRT1_2;
  const rig = motionRigFile.parse({
    version: 1,
    sourceSha256: "a".repeat(64),
    clips: [{ name: "yawn", file: "clip.json", duration: 1 }],
    joints: [
      {
        name: "root",
        parent: -1,
        translation: [10, 0, 0],
        rotation: [q, 0, 0, q],
        inverseBind: inverseTranslation(1, 0, 0),
      },
      {
        name: "arm",
        parent: 0,
        translation: [2, 0, 0],
        rotation: [q, 0, 0, q],
        inverseBind: [0, 1, 0, -2, -1, 0, 0, 3, 0, 0, 1, -4, 0, 0, 0, 1],
      },
      {
        name: "tip",
        parent: 1,
        translation: [0, 3, 0],
        rotation: [1, 0, 0, 0],
        inverseBind: inverseTranslation(0, 1, 2),
      },
    ],
  });
  const result = createMotionSkin(
    {
      bones: ["tip", "root", "arm"].map((name) => ({ name })),
      vertices: [{ skinIndices: [0, 1, 2], skinWeights: [0.2, 0.3, 0.5] }],
    },
    rig,
  );
  // Independently evaluated: tip*[.2]=[1.2,-1,.8], root*[.3]=[1.5,.9,1.8], arm*[.5]=[3.5,1.5,1].
  result.neutralPosition([4, 5, 6], 0).forEach((value, i) => {
    expect(value).toBeCloseTo([6.2, 1.4, 3.6][i] ?? NaN, 10);
  });
  expect(result.nodes[0]?.rotation).toEqual([0, 0, q, q]);
  expect(result.inverseBindMatrices.slice(16, 32)).toEqual([0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, -2, 3, -4, 1]);
  expect(() => result.neutralPosition([0, 0, 0], 1)).toThrow("顶点越界");
});

it("rejects invalid or absent nonzero source influences rather than silently rebinding them", () => {
  const rig = fixtureRig("a".repeat(64));
  const bones = [{ name: "root" }];
  for (const vertex of [
    { skinIndices: [0], skinWeights: [0] },
    { skinIndices: [0], skinWeights: [-0.1] },
    { skinIndices: [0], skinWeights: [NaN] },
    { skinIndices: [0], skinWeights: [1.1] },
    { skinIndices: [0], skinWeights: [0.5, 0.5] },
    { skinIndices: [0, 0, 0, 0, 0], skinWeights: [0.2, 0.2, 0.2, 0.2, 0.2] },
    { skinIndices: [-1], skinWeights: [1] },
    { skinIndices: [99], skinWeights: [1] },
  ])
    expect(() => createMotionSkin({ bones, vertices: [vertex] }, rig)).toThrow();
  expect(() => createMotionSkin({ bones: [...bones, ...bones], vertices: [] }, rig)).toThrow("唯一源骨骼");
  expect(() =>
    createMotionSkin({ bones: [{ name: "missing" }], vertices: [{ skinIndices: [0], skinWeights: [1] }] }, rig),
  ).toThrow("缺少蒙皮骨骼");
});

it("rejects mismatched binding, relaxed input, missing clips and absent face slots with atomic cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "voidmaker-motion-failure-"));
  try {
    const { rig, look } = await writeFixture(root);
    const source = join(root, "source.pmx");
    await expect(convertPmx(source, join(root, "relaxed"), "あ", "まばたき", "relaxed", look, root)).rejects.toThrow(
      "original",
    );
    await writeFile(join(root, "rig.json"), JSON.stringify({ ...rig, sourceSha256: "0".repeat(64) }));
    await expect(convertPmx(source, join(root, "hash"), "あ", "まばたき", "original", look, root)).rejects.toThrow(
      "指纹不符",
    );
    await writeFile(
      join(root, "rig.json"),
      JSON.stringify({ ...rig, clips: [...rig.clips, { name: "think", file: "missing.json", duration: 1 }] }),
    );
    await expect(convertPmx(source, join(root, "missing"), "あ", "まばたき", "original", look, root)).rejects.toThrow();
    await writeFile(join(root, "rig.json"), JSON.stringify(rig));
    await writeFile(
      join(root, "source-yawn.json"),
      JSON.stringify({
        ...clip,
        expression: [
          { time: 0, weight: 0 },
          { time: 0.5, weight: 1 },
          { time: 1, weight: 0 },
        ],
      }),
    );
    await expect(convertPmx(source, join(root, "face"), "あ", "まばたき", "original", look, root)).rejects.toThrow(
      "形态槽",
    );
    // A failed conversion never removes or alters an existing destination.
    await mkdir(join(root, "existing"));
    await writeFile(join(root, "existing", "keep.txt"), "keep");
    await expect(
      convertPmx(source, join(root, "existing"), "あ", "まばたき", "original", look, root),
    ).rejects.toThrow();
    expect(await readFile(join(root, "existing", "keep.txt"), "utf8")).toBe("keep");
    expect(
      (await readdir(root)).filter(
        (name) => name.startsWith(".pmx-") || ["relaxed", "hash", "missing", "face"].includes(name),
      ),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("copies the bounded bytes it validated and reports only clips with actual expression weights", async () => {
  const root = await mkdtemp(join(tmpdir(), "voidmaker-motion-copy-"));
  try {
    const { rig } = await writeFixture(root);
    const output = join(root, "out");
    await mkdir(output);
    const result = await prepareMotionRig(
      { bones: [{ name: "root" }], vertices: [{ skinIndices: [0], skinWeights: [1] }] },
      rig.sourceSha256,
      root,
      "rig.json",
      output,
    );
    expect(result.requiredFaceTargets).toEqual([]);
    expect(await readFile(join(output, "motions", "yawn.json"))).toEqual(
      await readFile(join(root, "source-yawn.json")),
    );
    expect(JSON.parse(await readFile(join(output, "motions", "rig.json"), "utf8")).clips).toEqual([
      { name: "yawn", file: "yawn.json", duration: 1 },
    ]);
    expect(result.provenance.clips[0]?.sha256).toBe(
      createHash("sha256")
        .update(await readFile(join(root, "source-yawn.json")))
        .digest("hex"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.env.VOIDMAKER_PMX_SMOKE !== "1")(
  "preserves full BDEF4, source binds and joint order through real Balsam",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "voidmaker-motion-balsam-"));
    try {
      const { rig, look } = await writeFixture(root);
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
      const output = join(root, "avatar");
      await convertPmx(join(root, "source.pmx"), output, "あ", "まばたき", "original", look, root);
      const manifest = avatarManifest.parse(JSON.parse(await readFile(join(output, "avatar.json"), "utf8")));
      expect(manifest.motionRig).toBe("motions/rig.json");
      expect(manifest.idleRig).toBeUndefined();
      expect(manifest.poses).toBeUndefined();
      expect(manifest.height).toBeCloseTo(1, 5);
      expect(manifest.centerY).toBeCloseTo(12.5, 5);
      const preview = await readPreview(join(output, "avatar.json"));
      expect(preview.motionRig?.joints).toEqual(rig.joints);
      expect(preview.motionRig?.clips[0]?.url).toContain("/avatar/motions/yawn.json");
      const gltf = JSON.parse(await readFile(join(output, "avatar.gltf"), "utf8"));
      const binary = await readFile(join(output, "avatar.bin"));
      const read = (index: number) => {
        const accessor = gltf.accessors[index],
          view = gltf.bufferViews[accessor.bufferView];
        const width = accessor.componentType === 5123 ? 2 : 4;
        return Array.from({ length: view.byteLength / width }, (_, i) =>
          accessor.componentType === 5123
            ? binary.readUInt16LE(view.byteOffset + i * width)
            : binary.readFloatLE(view.byteOffset + i * width),
        );
      };
      const attributes = gltf.meshes[0].primitives[0].attributes;
      read(attributes.POSITION).forEach((value, i) => {
        expect(value).toBeCloseTo([1, 10, 0, 2, 10, 0, 1, 11, 0][i] ?? NaN, 6);
      });
      expect(read(attributes.JOINTS_0)).toEqual([3, 6, 7, 4, 3, 6, 7, 5, 7, 6, 3, 0]);
      read(attributes.WEIGHTS_0).forEach((weight, i) => {
        expect(weight).toBeCloseTo(sourceSkin.flatMap((vertex) => vertex.weights)[i] ?? NaN, 6);
      });
      expect(gltf.skins[0].joints).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(gltf.nodes[1].translation).toEqual([0, 2, 0]);
      const bindMatrices = read(gltf.skins[0].inverseBindMatrices);
      expect(bindMatrices.slice(4 * 16, 5 * 16)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, -10, 0, 1]);
      const qml = await readFile(join(output, "qt", "Avatar.qml"), "utf8");
      const lists = [...qml.matchAll(/joints:\s*\[([^\]]+)\]/g)];
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists)
        expect(list[1]?.replace(/\s/g, "")).toBe(rig.joints.map((_, i) => `motion_joint_${i}`).join(","));
      const mesh = await readFile(join(output, manifest.parts[0]?.mesh ?? "missing"));
      expect(mesh.includes(Buffer.from("attr_joints"))).toBe(true);
      expect(mesh.includes(Buffer.from("attr_weights"))).toBe(true);
      expect((await readdir(root)).some((name) => name.startsWith(".pmx-"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
