import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { VoiceController, type VoicePorts } from "../apps/host/src/voice.js";
import { wavFromPcm } from "../packages/adapters/src/pcm.js";
import { loadReviewedSpeech } from "../packages/adapters/src/reviewed-speech.js";
import { synthesize } from "../packages/adapters/src/speech-http.js";
import { openVoiceReview } from "../packages/adapters/src/voice-review-store.js";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";
import type { ReviewFields } from "../packages/contracts/src/voice-review.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const fields: ReviewFields = {
  text_ja: "核对过的日文。",
  text_zh: "已核对。",
  emotion: "平静",
  delivery: "自然平缓",
  speech_act: "陈述",
  needs_review: false,
  review_reason: "",
  reviewed: true,
  excluded: false,
  review_note: "",
};
async function fixture(extraSpecs: [string, number][] = []) {
  const root = await mkdtemp(join(tmpdir(), "voidmaker-reviewed-speech-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const specs: [string, number][] = [
    ["one", 4],
    ["best", 5],
    ["warm", 6],
    ["short", 2.5],
    ["long", 10.1],
    ["excluded", 4],
    ["unconfirmed", 5],
    ["unknown", 5],
    ...extraSpecs,
  ];
  const rows = await Promise.all(
    specs.map(async ([id, duration]) => {
      const wav = wavFromPcm(Buffer.alloc(Math.round(duration * 32000)));
      const audio = join(root, `${id}.wav`);
      await writeFile(audio, wav);
      return {
        ...fields,
        id,
        file: `${id}.wav`,
        audio,
        duration_seconds: duration,
        source_sha256: createHash("sha256").update(wav).digest("hex"),
        text_ja: "自动台词。",
        confidence: "中",
        reason: "自动估计",
        reviewed: true,
      };
    }),
  );
  const path = join(root, "dataset.jsonl");
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n"));
  const store = await openVoiceReview(path);
  cleanup.push(() => store.close());
  for (const row of rows.filter((r) => r.id !== "unconfirmed"))
    await store.save(row.id, {
      revision: 0,
      fields: {
        ...fields,
        emotion: row.id === "warm" ? "温柔关切" : row.id === "unknown" ? "难以判断" : "平静",
        excluded: row.id === "excluded",
      },
    });
  return { root, path, store };
}
it("reads human corrections alongside the editor, filters unsuitable audio and refreshes the next snapshot", async () => {
  const f = await fixture();
  const before = await readFile(join(f.root, "review-state.json"));
  const first = await loadReviewedSpeech(f.path, new AbortController().signal);
  expect(first).toMatchObject({ confirmed: 6, usable: 3, diagnostic: { status: "ready" } });
  expect(first.references).toHaveLength(2);
  expect(
    first.references.find((r) => r.description.includes("自然平缓") && r.description.includes("平静")),
  ).toMatchObject({
    refAudioPath: join(f.root, "best.wav"),
    promptText: fields.text_ja,
    promptLanguage: "ja",
  });
  expect(await readFile(join(f.root, "review-state.json"))).toEqual(before);
  await expect(readFile(join(f.root, "review-state.lock"))).resolves.toBeDefined();
  await f.store.save("best", { revision: 1, fields: { ...fields, excluded: true } });
  const next = await loadReviewedSpeech(f.path, new AbortController().signal);
  expect(next).toMatchObject({ confirmed: 5, usable: 2 });
  expect(next.references.some((r) => r.refAudioPath.endsWith("one.wav"))).toBe(true);
  expect(first.references.some((r) => r.refAudioPath.endsWith("best.wav"))).toBe(true);
  await writeFile(join(f.root, "warm.wav"), Buffer.from("changed audio"));
  const damaged = await loadReviewedSpeech(f.path, new AbortController().signal);
  expect(damaged.usable).toBe(1);
  await f.store.save("one", { revision: 1, fields: { ...fields, reviewed: false, needs_review: true } });
  expect((await loadReviewedSpeech(f.path, new AbortController().signal)).references).toHaveLength(0);
});

it("uses confirmed short clips only as auxiliary references, retaining hashes and duration limits", async () => {
  const f = await fixture([
    ["tiny", 0.19],
    ["minimum", 0.2],
    ["maximum", 10],
  ]);
  await f.store.save("short", { revision: 1, fields: { ...fields, emotion: "惊讶" } });
  await f.store.save("minimum", { revision: 1, fields: { ...fields, emotion: "坚定" } });
  await f.store.save("maximum", { revision: 1, fields: { ...fields, emotion: "担忧" } });
  const bank = await loadReviewedSpeech(f.path, new AbortController().signal, "auxiliary");
  expect(bank).toMatchObject({ confirmed: 9, usable: 6, diagnostic: { status: "ready" } });
  expect(bank.references).toHaveLength(5);
  expect(bank.diagnostic.detail).toContain("辅参考（0.2–10 秒）");
  for (const ref of bank.references) {
    expect(ref.kind).toBe("auxiliary");
    expect(ref.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ref).not.toHaveProperty("promptText");
    expect(ref).not.toHaveProperty("promptLanguage");
  }
  for (const id of ["short", "minimum", "maximum"])
    expect(bank.references.some((r) => r.refAudioPath.endsWith(`/${id}.wav`))).toBe(true);
  const primary = await loadReviewedSpeech(f.path, new AbortController().signal);
  expect(primary.usable).toBe(4);
  expect(primary.diagnostic.detail).toContain("主参考（3–10 秒）");
  expect(primary.references.some((r) => r.refAudioPath.endsWith("/short.wav"))).toBe(false);
  expect(primary.references.some((r) => r.refAudioPath.endsWith("/minimum.wav"))).toBe(false);
  await writeFile(join(f.root, "short.wav"), Buffer.from("modified"));
  expect((await loadReviewedSpeech(f.path, new AbortController().signal, "auxiliary")).usable).toBe(5);
});

it.each(["primary", "auxiliary"] as const)(
  "falls back on a broken %s review snapshot and rejects a cancelled load",
  async (mode) => {
    const f = await fixture();
    const controller = new AbortController();
    const pending = loadReviewedSpeech(f.path, controller.signal, mode);
    controller.abort();
    await expect(pending).rejects.toThrow();
    const state = JSON.parse(await readFile(join(f.root, "review-state.json"), "utf8"));
    await writeFile(join(f.root, "review-state.json"), JSON.stringify({ ...state, dataset_sha256: "wrong" }));
    expect(await loadReviewedSpeech(f.path, new AbortController().signal, mode)).toMatchObject({
      references: [],
      diagnostic: { status: "error" },
    });
    expect(await loadReviewedSpeech(undefined, new AbortController().signal, mode)).toMatchObject({
      references: [],
      diagnostic: { status: "unconfigured" },
    });
  },
);

it.each(["primary", "auxiliary"] as const)(
  "sends a reviewed %s reference to TTS and rejects audio modified after selection",
  async (mode) => {
    const f = await fixture();
    const bank = await loadReviewedSpeech(f.path, new AbortController().signal, mode);
    const reference = bank.references[0];
    if (!reference) throw new Error("Missing reference");
    const output = wavFromPcm(Buffer.alloc(3200));
    const fetch = vi.fn(async () => new Response(new Uint8Array(output)));
    vi.stubGlobal("fetch", fetch);
    const config = voiceConfigSchema.parse({
      tts: { url: "http://127.0.0.1:9880/tts", refAudioPath: "/old.wav", promptText: "old", textLanguage: "ja" },
    }).tts;
    if (!config) throw new Error("Missing TTS config");
    expect(await synthesize("一緒に進めよう。", config, new AbortController().signal, reference)).toEqual(output);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      ref_audio_path: mode === "auxiliary" ? config.refAudioPath : reference.refAudioPath,
      prompt_text: mode === "auxiliary" ? config.promptText : fields.text_ja,
      prompt_lang: mode === "auxiliary" ? config.promptLanguage : "ja",
      text_lang: "ja",
      aux_ref_audio_paths: mode === "auxiliary" ? [reference.refAudioPath] : [],
    });
    await writeFile(reference.refAudioPath, Buffer.from("modified"));
    await expect(synthesize("次。", config, new AbortController().signal, reference)).rejects.toThrow("已变更");
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each(["primary", "auxiliary"] as const)(
  "pins %s reference metadata to the speech turn and cancels an in-flight reviewed synthesis",
  async (mode) => {
    const f = await fixture();
    const first = await loadReviewedSpeech(f.path, new AbortController().signal, mode);
    const ref = first.references[0];
    if (!ref) throw new Error("Missing reference");
    let resolve!: (wav: Buffer) => void;
    const ports: VoicePorts = {
      capture: vi.fn(),
      transcribe: vi.fn(),
      submit: vi.fn(),
      publish: vi.fn(),
      play: vi.fn(async () => {}),
      synthesize: vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    };
    const voice = new VoiceController(ports, false, true);
    const turn = voice.speak(
      [{ subtitle: "一起。", text: "一緒に。", referenceId: ref.id }],
      voice.beginReply(),
      first.references,
    );
    await vi.waitFor(() => expect(ports.synthesize).toHaveBeenCalledOnce());
    expect(vi.mocked(ports.synthesize).mock.calls[0]?.[3]).toEqual(ref);
    const stopped = voice.cancel();
    expect(vi.mocked(ports.synthesize).mock.calls[0]?.[1].aborted).toBe(true);
    resolve(wavFromPcm(Buffer.alloc(3200)));
    await Promise.all([turn, stopped]);
    expect(ports.play).not.toHaveBeenCalled();
    expect(voice.snapshot.phase).toBe("idle");
  },
);
