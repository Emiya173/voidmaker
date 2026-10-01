import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticsController } from "../apps/host/src/diagnostics.js";
import { SettingsController } from "../apps/host/src/settings.js";
import { audioDevices, inspectModel } from "../packages/adapters/src/diagnostics.js";
import { VoiceSettingsStore } from "../packages/adapters/src/voice-settings.js";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function store() {
  const path = await mkdtemp(join(tmpdir(), "voidmaker-settings-"));
  dirs.push(path);
  return new VoiceSettingsStore(join(path, "voice.json"));
}
it("rejects unsafe service URLs, unknown keys and divergent playback/AEC outputs", () => {
  for (const url of ["http://remote:8000/tts", "http://user:password@localhost/tts", "file:///tmp/test"])
    expect(voiceConfigSchema.safeParse({ asr: { url } }).success).toBe(false);
  expect(voiceConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
  expect(
    voiceConfigSchema.safeParse({
      inputTarget: "mic",
      outputTarget: "other",
      aec: { outputTarget: "speaker", pluginDirectory: "/plugin" },
    }).success,
  ).toBe(false);
});
it("atomically saves private files, restores previous configuration and rejects stale/external edits", async () => {
  const files = await store();
  const initial = await files.load();
  expect(initial.config.asr).toBeUndefined();
  const first = await files.save(
    initial.revision,
    voiceConfigSchema.parse({ asr: { url: "http://127.0.0.1:8000/v1/audio/transcriptions" } }),
  );
  expect((await stat(files.path)).mode & 0o777).toBe(0o600);
  const second = await files.save(first.revision, voiceConfigSchema.parse({}));
  expect(second.canRestore).toBe(true);
  await expect(files.save(first.revision, first.config)).rejects.toThrow("修改");
  const restored = await files.restore(second.revision);
  expect(restored.config).toEqual(first.config);
  await writeFile(files.path, "{}");
  await expect(files.save(restored.revision, first.config)).rejects.toThrow("修改");
});
it("keeps the active file on backup failure and refuses to replace declarative symlinks", async () => {
  const files = await store();
  await writeFile(files.path, "{}");
  const initial = await files.load();
  await mkdir(`${files.path}.previous`);
  await expect(files.save(initial.revision, voiceConfigSchema.parse({ inputTarget: "new" }))).rejects.toThrow();
  expect(await readFile(files.path, "utf8")).toBe("{}");
  const link = new VoiceSettingsStore(`${files.path}.link`);
  await symlink(files.path, link.path);
  await expect(link.save((await link.load()).revision, initial.config)).rejects.toThrow("符号链接");
});
it("loads malformed configuration without enabling voice and retains a valid recovery point", async () => {
  const files = await store();
  await writeFile(files.path, "invalid JSON");
  await writeFile(`${files.path}.previous`, "{}");
  const initial = await files.load();
  expect(initial.error).not.toBe("");
  expect(initial.canRestore).toBe(true);
  expect(initial.config.asr).toBeUndefined();
  const next = await files.save(initial.revision, voiceConfigSchema.parse({ inputTarget: "new" }));
  expect(next.canRestore).toBe(true);
  expect(await readFile(`${files.path}.invalid-backup`, "utf8")).toBe("invalid JSON");
  expect((await files.restore(next.revision)).config.inputTarget).toBeUndefined();
});
it("holds settings mutations exclusive, keeps prior runtime on failure and suppresses application after close", async () => {
  const files = await store(),
    initial = await files.load();
  let idle = false;
  const apply = vi.fn(),
    publish = vi.fn();
  const controller = new SettingsController(initial, files, {
    idle: () => idle,
    prepare: async () => {},
    apply,
    publish,
  });
  expect(() => controller.change({ type: "reload" })).toThrow("停止");
  idle = true;
  await writeFile(files.path, "{}");
  await expect(
    controller.change({
      type: "save",
      revision: initial.revision,
      config: voiceConfigSchema.parse({ inputTarget: "bad" }),
    }),
  ).rejects.toThrow("修改");
  expect(apply).not.toHaveBeenCalled();
  expect(controller.snapshot.busy).toBe(false);
  let resolve!: () => void;
  const closing = new SettingsController(initial, files, {
    idle: () => true,
    prepare: () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
    apply,
    publish,
  });
  const pending = closing.change({ type: "reload" });
  expect(() => closing.change({ type: "reload" })).toThrow("停止");
  const closed = closing.close();
  resolve();
  await pending;
  await closed;
  expect(apply).not.toHaveBeenCalled();
});
it("distinguishes readiness, warmup, metadata-only reachability and model mismatches without inference", async () => {
  const config = voiceConfigSchema.parse({
    asr: { url: "http://127.0.0.1:8000/v1/audio/transcriptions" },
    tts: { url: "http://127.0.0.1:9880/tts", refAudioPath: "/reference.wav", promptText: "test" },
  });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ready: false, model: config.asr?.model })));
  vi.stubGlobal("fetch", fetch);
  expect((await inspectModel("asr", config, new AbortController().signal)).status).toBe("warming");
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ready: true, model: "wrong" })));
  await expect(inspectModel("asr", config, new AbortController().signal)).rejects.toThrow("模型");
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ paths: { "/tts": {} } })));
  expect((await inspectModel("tts", config, new AbortController().signal)).status).toBe("reachable");
  expect(fetch.mock.calls.every((call) => call.length === 2 && !("method" in (call[1] as object)))).toBe(true);
  expect((await inspectModel("asr", voiceConfigSchema.parse({}), new AbortController().signal)).status).toBe(
    "unconfigured",
  );
});
it("reads shared TTS model metadata with Japanese output without performing synthesis", async () => {
  const model = { gptWeightsPath: "/chiaki/gpt.ckpt", sovitsWeightsPath: "/chiaki/sovits.pth" };
  const config = voiceConfigSchema.parse({
    tts: {
      url: "http://127.0.0.1:9880/tts",
      healthUrl: "http://127.0.0.1:9880/health",
      refAudioPath: "/reference.wav",
      promptText: "こんにちは。",
      promptLanguage: "ja",
      textLanguage: "ja",
      model,
    },
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const [health, status] of [
    [{ ready: true, model }, "ready"],
    [{ ready: false, model }, "warming"],
    [{ ready: false, model: null }, "warming"],
    [{ ready: false }, "warming"],
    [{ ready: true, model: "gpt-sovits" }, "ready"],
    [{ model }, "reachable"],
  ] as const) {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(health)));
    expect((await inspectModel("tts", config, new AbortController().signal)).status).toBe(status);
  }
  expect(fetch.mock.calls.every(([url, options]) => url === config.tts?.healthUrl && !options.method)).toBe(true);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ready: false, model: null }), { status: 503 }));
  await expect(inspectModel("tts", config, new AbortController().signal)).rejects.toThrow("HTTP 503");
  for (const invalid of [{ gptWeightsPath: model.gptWeightsPath }, { ...model, sovitsWeightsPath: "relative.pth" }]) {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ready: true, model: invalid })));
    await expect(inspectModel("tts", config, new AbortController().signal)).rejects.toThrow();
  }
  const asr = voiceConfigSchema.parse({ asr: { url: "http://127.0.0.1:8000/v1/audio/transcriptions" } });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ready: true, model })));
  await expect(inspectModel("asr", asr, new AbortController().signal)).rejects.toThrow();
});
it("filters audio device metadata without creating capture streams", () => {
  expect(
    audioDevices([
      { id: 1, info: { props: { "node.name": "mic", "media.class": "Audio/Source", "node.description": "USB" } } },
      { id: 2, info: { props: { "node.name": "stream", "media.class": "Stream/Input/Audio" } } },
    ]),
  ).toEqual([{ name: "mic", description: "USB", kind: "input" }]);
});
it("cancels diagnostics and ignores old results after a newer check starts", async () => {
  const publish = vi.fn();
  const controller = new DiagnosticsController(publish);
  let resolve!: (value: { id: string; label: string; status: "ready"; detail: string }) => void;
  controller.start(
    [
      {
        id: "old",
        label: "old",
        run: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    ],
    async () => [],
  );
  controller.cancel();
  const cancelled = controller.snapshot;
  resolve({ id: "old", label: "old", status: "ready", detail: "stale" });
  await new Promise((done) => setTimeout(done, 0));
  expect(controller.snapshot).toEqual(cancelled);
  controller.start(
    [
      {
        id: "new",
        label: "new",
        run: async () => {
          throw new Error("offline");
        },
      },
    ],
    async () => [],
  );
  await expect.poll(() => controller.snapshot.phase).toBe("complete");
  expect(controller.snapshot.results.find((r) => r.id === "new")?.status).toBe("error");
  expect(controller.snapshot.results.some((r) => r.id === "old")).toBe(false);
});
