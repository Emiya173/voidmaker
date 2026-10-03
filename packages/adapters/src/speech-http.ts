import { z } from "zod";
import type { SpeechReference } from "../../contracts/src/speech.js";
import { speechModelSchema, type VoiceConfig } from "../../contracts/src/voice.js";
import { readWav } from "./pcm.js";
import { readReviewedAudio } from "./reviewed-speech.js";

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

/** The shared runtime atomically loads both weights; each synthesis also carries its target model. */
export async function prepareSynthesis(config: VoiceConfig["tts"], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!config?.model) return;
  const response = await fetch(new URL("/model", config.url), {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    body: JSON.stringify({ model: config.model }),
  });
  const result = z
    .object({ ready: z.literal(true), model: speechModelSchema })
    .parse(JSON.parse((await body(response, 16 * 1024)).toString()));
  signal.throwIfAborted();
  if (
    result.model.gptWeightsPath !== config.model.gptWeightsPath ||
    result.model.sovitsWeightsPath !== config.model.sovitsWeightsPath
  )
    throw new Error("TTS 返回的模型与所选角色不一致");
}

export async function synthesize(
  text: string,
  config: NonNullable<VoiceConfig["tts"]>,
  signal: AbortSignal,
  reference?: SpeechReference,
): Promise<Buffer> {
  signal.throwIfAborted();
  const prompt = reference ?? config;
  if (reference?.sourceSha256) {
    const { duration } = readWav(await readReviewedAudio(reference.refAudioPath, reference.sourceSha256, signal));
    if (duration < 3 || duration > 10) throw new Error("复核参考音频须为 3–10 秒");
  }
  const payload = {
    ...(config.model ? { model: config.model } : {}),
    text,
    text_lang: ["ja", "zh"].includes(config.textLanguage) && /[A-Za-z]/.test(text) ? "auto" : config.textLanguage,
    ref_audio_path: prompt.refAudioPath,
    prompt_text: prompt.promptText,
    prompt_lang: prompt.promptLanguage,
    text_split_method: "cut1",
    batch_size: 1,
    media_type: "wav",
    streaming_mode: false,
    top_k: 15,
    top_p: 1,
    temperature: 1,
    repetition_penalty: 1.2,
  };
  const response = await fetch(config.url, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    body: JSON.stringify(payload),
  });
  const wav = await body(response, 32 * 1024 * 1024);
  signal.throwIfAborted();
  readWav(wav);
  return wav;
}
