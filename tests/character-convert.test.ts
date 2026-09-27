import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { convertPmx } from "../apps/tools/src/characters/pmx.js";
import { avatarManifest } from "../packages/contracts/src/character.js";

// An original three-vertex PMX fixture, independent of downloaded character assets.
function trianglePmx(badIndex = false) {
  const chunks: Buffer[] = [];
  const byte = (...v: number[]) => {
    chunks.push(Buffer.from(v));
  };
  const uint = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    chunks.push(b);
  };
  const float = (...v: number[]) => {
    for (const n of v) {
      const b = Buffer.alloc(4);
      b.writeFloatLE(n);
      chunks.push(b);
    }
  };
  const string = (v: string) => {
    const b = Buffer.from(v, "utf16le");
    uint(b.length);
    chunks.push(b);
  };
  chunks.push(Buffer.from("PMX "));
  float(2);
  byte(8, 0, 0, 1, 1, 1, 1, 1, 1);
  for (const text of ["Triangle", "", "Original regression fixture", ""]) string(text);
  uint(3);
  for (const [i, pos] of [
    [1, 10, 0],
    [2, 10, 0],
    [1, 11, 0],
  ].entries()) {
    float(...pos, 0, 0, -1, 0, 0);
    byte(0, 1);
    float(i / 2);
  }
  uint(3);
  byte(0, 1, badIndex ? 99 : 2);
  uint(1);
  string("toon.png");
  uint(1);
  string("surface");
  string("");
  float(1, 1, 1, 1, 0, 0, 0, 50, 0.5, 0.5, 0.5);
  byte(16);
  float(0.1, 0.1, 0.1, 1, 1);
  byte(255, 255, 0, 0, 0);
  string("");
  uint(3);
  uint(3);
  for (const [i, name] of ["root", "左腕", "右腕"].entries()) {
    string(name);
    string("");
    float(i === 1 ? 1 : i === 2 ? -1 : 0, i ? 10 : 0, 0);
    byte(i ? 0 : 255);
    uint(0);
    byte(0, 0);
    float(0, 0, 0);
  }
  uint(2);
  for (const name of ["あ", "まばたき"]) {
    string(name);
    string("");
    byte(1, 1);
    uint(1);
    byte(0);
    float(0, 0.1, 0);
  }
  uint(0);
  uint(0);
  uint(0);
  return Buffer.concat(chunks);
}

it.skipIf(process.env.VOIDMAKER_PMX_SMOKE !== "1")(
  "converts original PMX geometry, edge weights, toon ramp and morphs with real Balsam",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "voidmaker-pmx-smoke-"));
    try {
      const source = join(root, "triangle.pmx"),
        output = join(root, "avatar");
      await writeFile(source, trianglePmx());
      // Tiny uncompressed BMP, accepted by ffmpeg regardless of the source suffix.
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
      await convertPmx(source, output, "あ", "まばたき", "relaxed");
      const manifest = avatarManifest.parse(JSON.parse(await readFile(join(output, "avatar.json"), "utf8")));
      expect(manifest.parts[0]?.toon?.ramp).toBe("texture-0.png");
      const mesh = await readFile(join(output, manifest.parts[0]?.mesh ?? "missing"));
      // Assimp's UV optimization used to silently discard the edge-weight channel.
      expect(mesh.includes(Buffer.from("attr_uv1"))).toBe(true);
      const qml = await readFile(join(output, "qt", "Avatar.qml"), "utf8");
      expect(qml).toContain('objectName: "mouth"');
      expect(qml).toContain('objectName: "blink"');
      expect(JSON.parse(await readFile(join(output, "conversion.json"), "utf8"))).toMatchObject({
        version: 2,
        pose: "relaxed",
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      await writeFile(source, trianglePmx(true));
      await expect(convertPmx(source, join(root, "invalid"))).rejects.toThrow("三角形索引");
      expect(await readdir(root)).not.toContain("invalid");
      await rm(join(root, "toon.png"));
      await writeFile(source, trianglePmx());
      await expect(convertPmx(source, join(root, "missing"))).rejects.toThrow();
      expect((await readdir(root)).some((name) => name.startsWith(".pmx-"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
