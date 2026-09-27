import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { convertPmx } from "../apps/tools/src/characters/pmx.js";
import { avatarLook } from "../packages/contracts/src/character.js";
import { trianglePmx } from "./helpers/pmx.js";

it.skipIf(process.env.VOIDMAKER_QT_RENDER_SMOKE !== "1")(
  "renders all eight targets with Skin and deforms both custom surface and outline shaders",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "voidmaker-render-"));
    // Private X server, never the user's Wayland/Xwayland desktop. Mesa executes
    // the real OpenGL shader pipeline; this is not Qt's 2D software fallback.
    const server = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x1600x24", "-nolisten", "tcp", "-noreset"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const display = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Xvfb 启动超时")), 10_000);
        server.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        server.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("Xvfb 提前退出"));
        });
        server.stdout.once("data", (data: Buffer) => {
          clearTimeout(timeout);
          const value = data.toString().trim();
          if (/^\d+$/.test(value)) resolve(`:${value}`);
          else reject(new Error("Xvfb 显示编号无效"));
        });
      });
      const bytes = trianglePmx(false, true, true);
      const source = join(root, "triangle.pmx"),
        output = join(root, "qt");
      await writeFile(source, bytes);
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
      const poses = {
        yawn: [
          [1, 10, 0],
          [2.1, 10, 0],
          [1, 11.2, 0],
        ],
        think: [
          [1, 10, 0],
          [2, 10, 0],
          [1, 11, 0],
        ],
        greet: [
          [1, 10, 0],
          [2.2, 10.1, 0],
          [1, 11.5, 0],
        ],
      };
      for (const [name, positions] of Object.entries(poses))
        await writeFile(
          join(root, `${name}.json`),
          JSON.stringify({
            sourceSha256: createHash("sha256").update(bytes).digest("hex"),
            positions,
            // Think is a normal-only target: its render must change even though
            // positions are exactly the neutral mesh, exercising NORMAL data.
            normals: Array(3).fill(
              name === "yawn" ? [0, 0.6, 0.8] : name === "think" ? [0, -0.8, -0.6] : [-0.6, 0, 0.8],
            ),
          }),
        );
      const neutralLook = avatarLook.parse({
        idleMotion: true,
        materials: { surface: { rampStrength: 0.3, shadeTint: [1, 0.98, 0.99], shadeStrength: 0.2 } },
        restEyes: { morph: "neutral eyes", weight: 0 },
        // A full-weight, zero-position smile tests that an untouched surface
        // retains its shading and extrusion when another target has normals.
        expressions: { sleepy: { morphs: { まばたき: 0.24 } }, smile: { morphs: { あ: 0 } } },
      });
      const baselineOutput = join(root, "baseline");
      await convertPmx(source, baselineOutput, "あ", "まばたき", "relaxed", neutralLook, root);
      await convertPmx(
        source,
        output,
        "あ",
        "まばたき",
        "relaxed",
        avatarLook.parse({
          ...neutralLook,
          poses: { yawn: "yawn.json", think: "think.json", greet: "greet.json" },
        }),
        root,
      );
      const manifestPath = join(output, "avatar.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const baselinePath = join(baselineOutput, "avatar.json");
      const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
      // Keep the triangle's upper tip in the portrait eye/mouth closeups.
      manifest.centerX = baseline.centerX = 1.1;
      const env = {
        ...process.env,
        DISPLAY: display,
        QT_QPA_PLATFORM: "xcb",
        QT_QUICK_BACKEND: "rhi",
        LIBGL_ALWAYS_SOFTWARE: "1",
      };
      const featherQml = join(root, "Feather.qml");
      await writeFile(
        featherQml,
        (await readFile(new URL("helpers/character-feather.qml", import.meta.url), "utf8"))
          .replace('"APP_SHELL"', JSON.stringify(pathToFileURL(join(process.cwd(), "apps/shell")).href))
          .replaceAll(
            '"APP_SHADER"',
            JSON.stringify(pathToFileURL(join(process.cwd(), "apps/shell/shaders/character-toon.frag")).href),
          ),
      );
      const feather = await promisify(execFile)("quickshell", ["--path", featherQml], {
        env: { ...env, QSG_RHI_BACKEND: "opengl", VOIDMAKER_FEATHER_OUTPUT: root },
        timeout: 15_000,
      });
      const featherLog = feather.stdout + feather.stderr;
      expect(featherLog).toContain("FEATHER_PROBE_OK");
      expect(featherLog).not.toMatch(/FEATHER_PROBE_FAILED|shader.*(?:error|failed)|not functional|Unable to assign/);
      const featherPixels = await Promise.all(
        [0, 1, 2, 3].map(async (phase) => {
          const result = await promisify(execFile)(
            "ffmpeg",
            ["-v", "error", "-i", join(root, `${phase}.png`), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
            { encoding: "buffer", maxBuffer: 1024 * 1024 },
          );
          return result.stdout;
        }),
      );
      const [support, opaque, blended, restored] = featherPixels as [Buffer, Buffer, Buffer, Buffer];
      expect(opaque.equals(restored)).toBe(true); // Removing feather restores every legacy pixel.
      const pixel = (image: Buffer, x: number, y = 128) =>
        Array.from(image.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));
      expect(pixel(blended, 128)).toEqual(pixel(opaque, 128)); // Solid authored cap center.
      expect(pixel(blended, 223)).toEqual(pixel(support, 223)); // Opaque strands below transparent edge.
      const red = (image: Buffer, x: number) => pixel(image, x)[0] ?? 0;
      const transition = Array.from({ length: 49 }, (_, i) => red(blended, 170 + i));
      expect(red(opaque, 128) - red(support, 128)).toBeGreaterThan(150);
      expect(new Set(transition).size).toBeGreaterThan(30);
      expect(transition.every((value, i) => i === 0 || value <= (transition[i - 1] ?? 0))).toBe(true);
      expect(Math.max(...transition.slice(1).map((value, i) => Math.abs(value - (transition[i] ?? 0))))).toBeLessThan(
        15,
      );
      expect(red(blended, 213)).toBeGreaterThan(red(support, 213)); // Tail survives below the old 0.1 cutout.
      expect(pixel(blended, 193)[3]).toBe(255); // Blending must not punch holes through the opaque support.
      for (const surface of [false, true]) {
        // The fixture faces away from the camera: with backface culling only
        // its inverted-hull outline is visible. Then exercise the surface too.
        manifest.parts[0].doubleSided = surface;
        manifest.parts[0].toon.edgeSize = surface ? 0 : 1;
        await writeFile(manifestPath, JSON.stringify(manifest));
        baseline.parts[0].doubleSided = surface;
        baseline.parts[0].toon.edgeSize = surface ? 0 : 1;
        await writeFile(baselinePath, JSON.stringify(baseline));
        const capture = join(root, surface ? "surface" : "outline");
        const result = await promisify(execFile)(
          "pnpm",
          [
            "character:inspect",
            baselinePath,
            manifestPath,
            "--portrait",
            "--frames",
            "desktop,mouth,blink,smile,yawn,think,greet,greet-half,idle-a",
            "--capture",
            capture,
          ],
          {
            env,
            timeout: 45_000,
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        const log = result.stdout + result.stderr;
        expect(log).not.toMatch(
          /Failed to build|shader.*(?:error|failed)|not functional|Unsupported texture|non-integer type indices/,
        );
        const pixels = JSON.parse(await readFile(join(capture, "pixels.json"), "utf8")) as {
          frames: { frame: string; pixelsOver2: number }[];
        };
        expect(pixels.frames.find((frame) => frame.frame === "desktop")?.pixelsOver2).toBe(0);
        // The position-only baseline and mixed-channel candidate must render
        // identically at full facial weight. Missing normal channels used to
        // erase normals across the entire mesh, darkening it and losing edges.
        for (const name of ["mouth", "blink", "smile"])
          expect(pixels.frames.find((frame) => frame.frame === name)?.pixelsOver2, `${surface}:${name}`).toBe(0);
        for (const name of ["yawn", "think", "greet", "greet-half", "idle-a"])
          expect(pixels.frames.find((frame) => frame.frame === name)?.pixelsOver2).toBeGreaterThan(100);
        expect(
          new Set(
            pixels.frames
              .filter((frame) => ["yawn", "think", "greet"].includes(frame.frame))
              .map((frame) => frame.pixelsOver2),
          ).size,
        ).toBe(3);
      }
    } finally {
      server.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    }
  },
  100_000,
);
