import { z } from "zod";
import type { VoiceConfig } from "../../contracts/src/voice.js";
import { readWav } from "./pcm.js";

async function body(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`语音服务 HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("语音服务响应为空");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("语音服务响应超过限制");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function transcribe(
  wav: Buffer,
  config: NonNullable<VoiceConfig["asr"]>,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
  form.set("model", config.model);
  form.set("response_format", "json");
  if (config.language) form.set("language", config.language);
  const response = await fetch(config.url, {
    method: "POST",
    body: form,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
  });
  const result = z
    .object({ text: z.string().max(10_000) })
    .parse(JSON.parse((await body(response, 128 * 1024)).toString()));
  // SenseVoice tags are metadata, not words to send to Codex.
  return result.text.replace(/<\|[^|]*\|>/g, "").trim();
}

export async function synthesize(
  text: string,
  config: NonNullable<VoiceConfig["tts"]>,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const response = await fetch(config.url, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    body: JSON.stringify({
      text,
      text_lang: config.textLanguage,
      ref_audio_path: config.refAudioPath,
      prompt_text: config.promptText,
      prompt_lang: config.promptLanguage,
      text_split_method: "cut5",
      batch_size: 1,
      media_type: "wav",
      streaming_mode: false,
    }),
  });
  const wav = await body(response, 32 * 1024 * 1024);
  readWav(wav);
  return wav;
}
