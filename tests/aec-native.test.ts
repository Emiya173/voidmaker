import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { aecArguments, nearendProtectionSettings } from "../packages/contracts/src/aec.js";

const pkg = process.env.VOIDMAKER_AEC_PACKAGE;
it.skipIf(!pkg)(
  "exports complete native linear frames and rejects invalid settings, truncation and overwrite",
  async () => {
    if (!pkg) throw new Error("缺少插件包");
    const directory = await mkdtemp(join(tmpdir(), "voidmaker-native-"));
    const capture = join(directory, "capture.f32"),
      reference = join(directory, "reference.f32");
    const output = join(directory, "output.f32"),
      linear = join(directory, "linear.f32");
    const statistics = join(directory, "statistics.jsonl");
    const run = (destination: string, args: string[]) =>
      promisify(execFile)(
        join(pkg, "bin/voidmaker-aec-replay"),
        [join(pkg, "lib/spa-0.2/aec/libspa-aec-voidmaker.so"), capture, reference, destination, ...args],
        { timeout: 5000 },
      );
    try {
      await writeFile(capture, Buffer.alloc(48000 * 4), { mode: 0o600 });
      await writeFile(reference, Buffer.alloc(48000 * 4), { mode: 0o600 });
      await run(output, [
        ...Object.entries(aecArguments(nearendProtectionSettings)).map(([key, value]) => `${key}=${value}`),
        `webrtc.aec3.linear-dump=${linear}`,
        `webrtc.aec3.stats-dump=${statistics}`,
      ]);
      expect((await stat(output)).size).toBe(48000 * 4);
      expect((await stat(linear)).size).toBe(16000 * 4);
      expect((await stat(linear)).mode & 0o777).toBe(0o600);
      expect((await stat(statistics)).mode & 0o777).toBe(0o600);
      const metrics = JSON.parse((await readFile(statistics, "utf8")).trim()) as Record<string, number>;
      expect(metrics.seconds).toBe(1);
      expect(Object.values(metrics).every(Number.isFinite)).toBe(true);
      const before = await readFile(output);
      await expect(run(output, [])).rejects.toMatchObject({ code: 8 });
      expect(await readFile(output)).toEqual(before);
      for (const arg of [
        "webrtc.aec3.nearend-snr=NaN",
        "webrtc.aec3.nearend-trigger=1.5",
        "webrtc.aec3.nearend-initial=yes",
        `webrtc.aec3.linear-dump=${linear}`,
        `webrtc.aec3.stats-dump=${statistics}`,
        "webrtc.aec3.stats-dump=relative.jsonl",
      ])
        await expect(run(join(directory, "invalid.f32"), [arg])).rejects.toMatchObject({ code: 7 });
      await writeFile(capture, Buffer.alloc(48000 * 4 + 1));
      await expect(run(join(directory, "truncated.f32"), [])).rejects.toMatchObject({ code: 9 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
