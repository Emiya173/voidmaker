import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { wavFromPcm } from "../packages/adapters/src/pcm.js";
import { synthesize, transcribe } from "../packages/adapters/src/speech-http.js";
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
  });
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
