import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { captureAudio, playAudio } from "../packages/adapters/src/audio-process.js";
import { readWav, wavFromPcm } from "../packages/adapters/src/pcm.js";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";

it("captures bounded raw PCM, detects silence, and closes the recorder", async () => {
  const capture = captureAudio(
    voiceConfigSchema.parse({}),
    new AbortController().signal,
    () => undefined,
    process.execPath,
    [join(process.cwd(), "tests/fixtures/fake-recorder.mjs")],
  );
  const wav = await capture.result;
  expect(readWav(wav).duration).toBeCloseTo(1.11);
});
it("cancels capture and reports missing recording executables", async () => {
  const controller = new AbortController();
  const capture = captureAudio(voiceConfigSchema.parse({}), controller.signal, () => undefined, process.execPath, [
    join(process.cwd(), "tests/fixtures/fake-recorder.mjs"),
  ]);
  controller.abort();
  await expect(capture.result).rejects.toThrow();
  const missing = captureAudio(
    voiceConfigSchema.parse({}),
    new AbortController().signal,
    () => undefined,
    "/nonexistent/voidmaker-recorder",
  );
  await expect(missing.result).rejects.toThrow();
});
it.runIf(process.env.VOIDMAKER_AUDIO_SMOKE === "1")(
  "uses real mpv IPC timing with a null output and cleans temporary audio",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "voidmaker-player-test-"));
    try {
      const progress: number[] = [];
      await playAudio(
        wavFromPcm(Buffer.alloc(16_000)),
        new AbortController().signal,
        (value) => progress.push(value.position),
        { runtimeDirectory: directory, prefixArgs: ["--ao=null"] },
      );
      expect(progress.length).toBeGreaterThan(0);
      expect(await readdir(directory)).toEqual([]);
      const controller = new AbortController();
      const playback = playAudio(wavFromPcm(Buffer.alloc(320_000)), controller.signal, () => controller.abort(), {
        runtimeDirectory: directory,
        prefixArgs: ["--ao=null"],
      });
      await expect(playback).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
