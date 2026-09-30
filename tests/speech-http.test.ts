import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { wavFromPcm } from "../packages/adapters/src/pcm.js";
import { prepareSynthesis, synthesize, transcribe } from "../packages/adapters/src/speech-http.js";
import { voiceConfigSchema } from "../packages/contracts/src/voice.js";

function required<T>(value: T | undefined): T {
  if (!value) throw new Error("Missing test configuration");
  return value;
}

const servers: Server[] = [];
const wav = wavFromPcm(Buffer.alloc(3200));
async function server(handler: Parameters<typeof createServer>[0]) {
  const instance = createServer(handler);
  servers.push(instance);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (instance) =>
        new Promise<void>((resolve) => {
          instance.closeAllConnections();
          instance.close(() => resolve());
        }),
    ),
  );
});

it("preloads a complete model pair and includes it in every synthesis, even after a service restart", async () => {
  const requested: { path?: string; data: Record<string, unknown> }[] = [];
  const url = await server(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const payload = JSON.parse(data);
    requested.push({ path: req.url, data: payload });
    res.end(req.url === "/model" ? JSON.stringify({ ready: true, model: payload.model }) : wav);
  });
  const model = { gptWeightsPath: "/chiaki/gpt.ckpt", sovitsWeightsPath: "/chiaki/sovits.pth" };
  const tts = required(
    voiceConfigSchema.parse({
      tts: { url: `${url}/tts`, model, refAudioPath: "/ref.wav", promptText: "こんにちは" },
    }).tts,
  );
  await prepareSynthesis(tts, new AbortController().signal);
  await synthesize("一。", tts, new AbortController().signal);
  await synthesize("二。", tts, new AbortController().signal);
  expect(requested.map(({ path }) => path)).toEqual(["/model", "/tts", "/tts"]);
  expect(requested.every(({ data }) => JSON.stringify(data.model) === JSON.stringify(model))).toBe(true);
});

it("rejects failed or mismatched model loads and aborts pending selection without accepting its late response", async () => {
  let mode = "failure";
  let complete: (() => void) | undefined;
  let started!: () => void;
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  const url = await server(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const payload = JSON.parse(data);
    if (mode === "failure") {
      res.writeHead(503);
      res.end("failed");
    } else if (mode === "mismatch")
      res.end(JSON.stringify({ ready: true, model: { ...payload.model, gptWeightsPath: "/wrong.ckpt" } }));
    else {
      complete = () => res.end(JSON.stringify({ ready: true, model: payload.model }));
      started();
    }
  });
  const tts = required(
    voiceConfigSchema.parse({
      tts: {
        url,
        refAudioPath: "/ref.wav",
        promptText: "test",
        model: { gptWeightsPath: "/a.ckpt", sovitsWeightsPath: "/a.pth" },
      },
    }).tts,
  );
  await expect(prepareSynthesis(tts, new AbortController().signal)).rejects.toThrow("503");
  mode = "mismatch";
  await expect(prepareSynthesis(tts, new AbortController().signal)).rejects.toThrow("不一致");
  mode = "pending";
  const controller = new AbortController();
  const pending = prepareSynthesis(tts, controller.signal);
  const rejected = expect(pending).rejects.toThrow();
  await received;
  controller.abort();
  await rejected;
  complete?.();
});

it("sends a multipart audio request and strips SenseVoice metadata", async () => {
  let request = "";
  const url = await server(async (req, res) => {
    for await (const chunk of req) request += chunk;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: "<|zh|><|NEUTRAL|>你好" }));
  });
  const config = voiceConfigSchema.parse({ asr: { url, model: "sensevoice" } });
  expect(await transcribe(wav, required(config.asr), new AbortController().signal)).toBe("你好");
  expect(request).toContain('filename="speech.wav"');
  expect(request).toContain("sensevoice");
});

it("validates GPT-SoVITS request and WAV response", async () => {
  let payload: Record<string, unknown> = {};
  const url = await server(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    payload = JSON.parse(data);
    res.end(wav);
  });
  const config = voiceConfigSchema.parse({ tts: { url, refAudioPath: "/model/ref.wav", promptText: "参考文本" } });
  expect(await synthesize("你好", required(config.tts), new AbortController().signal)).toEqual(wav);
  expect(payload).toMatchObject({
    streaming_mode: false,
    media_type: "wav",
    text: "你好",
    ref_audio_path: "/model/ref.wav",
    text_split_method: "cut1",
    batch_size: 1,
    top_k: 15,
    top_p: 1,
    temperature: 1,
    repetition_penalty: 1.2,
  });
});

it("uses automatic language detection for Japanese dialogue containing English names and rejects invalid audio", async () => {
  let payload: Record<string, unknown> = {};
  let valid = true;
  const url = await server(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    payload = JSON.parse(data);
    res.end(valid ? wav : Buffer.from("not audio"));
  });
  const config = voiceConfigSchema.parse({
    tts: { url, refAudioPath: "/ref.wav", promptText: "参考", textLanguage: "ja" },
  });
  await synthesize("今日は遊ぼう。", required(config.tts), new AbortController().signal);
  expect(payload.text_lang).toBe("ja");
  await synthesize("API を確認しよう。", required(config.tts), new AbortController().signal);
  expect(payload.text_lang).toBe("auto");
  valid = false;
  await expect(synthesize("こんにちは。", required(config.tts), new AbortController().signal)).rejects.toThrow("WAV");
});

it("uses the selected tone reference without changing character weights", async () => {
  let payload: Record<string, unknown> = {};
  const url = await server(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    payload = JSON.parse(data);
    res.end(wav);
  });
  const reference = {
    id: "gentle",
    description: "温柔",
    refAudioPath: "/gentle.wav",
    promptText: "大丈夫",
    promptLanguage: "ja",
  };
  const config = required(
    voiceConfigSchema.parse({
      tts: {
        provider: "gpt-sovits",
        url,
        refAudioPath: "/speaker.wav",
        promptText: "参考",
        textLanguage: "ja",
        model: { gptWeightsPath: "/character.ckpt", sovitsWeightsPath: "/character.pth" },
      },
    }).tts,
  );
  expect(await synthesize("大丈夫。", config, new AbortController().signal, reference)).toEqual(wav);
  expect(payload).toMatchObject({
    ref_audio_path: "/gentle.wav",
    prompt_text: "大丈夫",
    prompt_lang: "ja",
    model: config.model,
  });
  await synthesize("こんにちは。", config, new AbortController().signal);
  expect(payload).toMatchObject({ ref_audio_path: "/speaker.wav", prompt_text: "参考", model: config.model });
});

it("rejects incomplete weight pairs, cancels stalled synthesis and rejects broken audio", async () => {
  const tts = {
    provider: "gpt-sovits",
    url: "http://127.0.0.1:9880/tts",
    refAudioPath: "/speaker.wav",
    promptText: "参考",
    textLanguage: "ja",
  };
  expect(voiceConfigSchema.safeParse({ tts }).success).toBe(true);
  for (const model of [
    { gptWeightsPath: "/model.ckpt" },
    { gptWeightsPath: "relative.ckpt", sovitsWeightsPath: "/model.pth" },
  ])
    expect(voiceConfigSchema.safeParse({ tts: { ...tts, model } }).success).toBe(false);
  expect(voiceConfigSchema.safeParse({ tts: { ...tts, promptText: " " } }).success).toBe(false);
  const stalled = await server(() => undefined);
  const config = required(voiceConfigSchema.parse({ tts: { ...tts, url: stalled, timeoutMs: 100 } }).tts);
  await expect(synthesize("テスト。", config, new AbortController().signal)).rejects.toThrow();
  const abort = new AbortController();
  const request = synthesize("テスト。", config, abort.signal);
  abort.abort();
  await expect(request).rejects.toThrow();
  const invalid = await server((_req, res) => res.end("not audio"));
  await expect(synthesize("テスト。", { ...config, url: invalid }, new AbortController().signal)).rejects.toThrow(
    "WAV",
  );
});

it("times out and cancels pending inference requests", async () => {
  const url = await server(() => undefined);
  const config = voiceConfigSchema.parse({ asr: { url, model: "qwen3-asr", timeoutMs: 100 } });
  await expect(transcribe(wav, required(config.asr), new AbortController().signal)).rejects.toThrow();
  const controller = new AbortController();
  const request = transcribe(wav, required(config.asr), controller.signal);
  controller.abort();
  await expect(request).rejects.toThrow();
});

it("rejects malformed ASR output and HTTP failures", async () => {
  let fail = false;
  const url = await server((_req, res) => {
    res.statusCode = fail ? 503 : 200;
    res.end('{"text":7}');
  });
  const config = voiceConfigSchema.parse({ asr: { url, model: "qwen3-asr" } });
  await expect(transcribe(wav, required(config.asr), new AbortController().signal)).rejects.toThrow();
  fail = true;
  await expect(transcribe(wav, required(config.asr), new AbortController().signal)).rejects.toThrow("503");
});
