import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { convertPmx } from "../apps/tools/src/characters/pmx.js";
import { avatarLook, avatarManifest } from "../packages/contracts/src/character.js";

import { trianglePmx } from "./helpers/pmx.js";

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
        version: 4,
        pose: "relaxed",
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      await writeFile(source, trianglePmx(false, true));
      const look = avatarLook.parse({
        materials: { surface: { tint: [0.9, 0.8, 0.7], outlineScale: 0.7 } },
        restEyes: { morph: "neutral eyes", weight: 0.2 },
      });
      const styled = join(root, "styled");
      await convertPmx(source, styled, "あ", "まばたき", "relaxed", look);
      const styledManifest = avatarManifest.parse(JSON.parse(await readFile(join(styled, "avatar.json"), "utf8")));
      expect(styledManifest.restEyes).toBe(0.2);
      expect(styledManifest.parts[0]?.style).toMatchObject({ tint: [0.9, 0.8, 0.7], outlineScale: 0.7, contrast: 1 });
      expect(await readFile(join(styled, "qt", "Avatar.qml"), "utf8")).toContain('objectName: "restEyes"');
      const lookRoot = join(root, "look");
      await mkdir(lookRoot);
      const replacement = Buffer.from(bmp);
      replacement[54] = 80;
      await writeFile(join(lookRoot, "ink.png"), replacement);
      const refined = join(root, "refined");
      await convertPmx(
        source,
        refined,
        "あ",
        "まばたき",
        "original",
        avatarLook.parse({
          sourceSha256: createHash("sha256")
            .update(await readFile(source))
            .digest("hex"),
          textures: { "toon.png": "ink.png" },
          geometry: { surface: { transform: { pivot: [0, 0, 0], rotation: [0, 0, 0], translation: [0, 0.5, 0] } } },
        }),
        lookRoot,
      );
      const provenance = JSON.parse(await readFile(join(refined, "conversion.json"), "utf8"));
      expect(provenance.textures[0].replacement.sha256).toBe(createHash("sha256").update(replacement).digest("hex"));
      expect(avatarManifest.parse(JSON.parse(await readFile(join(refined, "avatar.json"), "utf8"))).centerY).toBe(11);
      await expect(
        convertPmx(
          source,
          join(root, "wrong-model"),
          "あ",
          "まばたき",
          "original",
          avatarLook.parse({ sourceSha256: "0".repeat(64) }),
        ),
      ).rejects.toThrow("指纹不符");
      await expect(
        convertPmx(
          source,
          join(root, "wrong-texture"),
          "あ",
          "まばたき",
          "original",
          avatarLook.parse({ textures: { "absent.png": "ink.png" } }),
          lookRoot,
        ),
      ).rejects.toThrow("未匹配");
      await symlink(join(root, "toon.png"), join(lookRoot, "escape.png"));
      await expect(
        convertPmx(
          source,
          join(root, "outside-texture"),
          "あ",
          "まばたき",
          "original",
          avatarLook.parse({ textures: { "toon.png": "escape.png" } }),
          lookRoot,
        ),
      ).rejects.toThrow("越界");
      expect(
        (await readdir(root)).filter((name) => ["wrong-model", "wrong-texture", "outside-texture"].includes(name)),
      ).toEqual([]);
      await expect(
        convertPmx(
          source,
          join(root, "bad-look"),
          "あ",
          "まばたき",
          "relaxed",
          avatarLook.parse({ materials: { absent: {} } }),
        ),
      ).rejects.toThrow("唯一材质");
      await expect(
        convertPmx(
          source,
          join(root, "bad-eyes"),
          "あ",
          "まばたき",
          "relaxed",
          avatarLook.parse({ restEyes: { morph: "absent", weight: 0.2 } }),
        ),
      ).rejects.toThrow("唯一顶点表情");
      await expect(
        convertPmx(
          source,
          join(root, "repeated-eyes"),
          "あ",
          "まばたき",
          "relaxed",
          avatarLook.parse({ restEyes: { morph: "まばたき", weight: 0.2 } }),
        ),
      ).rejects.toThrow("不能重复");
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
