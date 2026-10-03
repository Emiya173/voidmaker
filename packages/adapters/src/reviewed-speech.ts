import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { DiagnosticResult } from "../../contracts/src/settings.js";
import type { SpeechReference } from "../../contracts/src/speech.js";
import { type ReviewedSpeechCandidate, reviewedSpeechStyles } from "../../domain/src/reviewed-speech.js";
import { boundedFile } from "./character-assets.js";
import { readWav } from "./pcm.js";
import { readVoiceReview } from "./voice-review-store.js";

export type ReviewedSpeechBank = Readonly<{
  references: readonly SpeechReference[];
  confirmed: number;
  usable: number;
  diagnostic: DiagnosticResult;
}>;

export async function readReviewedAudio(path: string, sha256: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const resolved = await realpath(path);
  const info = await stat(resolved);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("复核音频文件无效或过大");
  const wav = await boundedFile(resolved, info.size);
  signal.throwIfAborted();
  if (createHash("sha256").update(wav).digest("hex") !== sha256) throw new Error("复核后原始音频已变更");
  return wav;
}

export async function loadReviewedSpeech(
  dataset: string | undefined,
  signal: AbortSignal,
  mode: "primary" | "auxiliary" = "primary",
): Promise<ReviewedSpeechBank> {
  const diagnostic = { id: "reviewed-speech", label: "人工复核语音参考" };
  const minimumDuration = mode === "auxiliary" ? 0.2 : 3;
  const usage = mode === "auxiliary" ? "辅参考（0.2–10 秒）" : "主参考（3–10 秒）";
  if (!dataset)
    return {
      references: [],
      confirmed: 0,
      usable: 0,
      diagnostic: { ...diagnostic, status: "unconfigured", detail: "未配置，使用角色原有参考音频" },
    };
  try {
    signal.throwIfAborted();
    const { samples, latest } = await readVoiceReview(dataset);
    signal.throwIfAborted();
    const candidates: ReviewedSpeechCandidate[] = [];
    let confirmed = 0;
    for (const original of samples) {
      signal.throwIfAborted();
      // The automatic dataset alone never counts as human confirmation.
      const edit = latest.get(original.id);
      if (!edit?.fields.reviewed || edit.fields.excluded || edit.fields.needs_review) continue;
      confirmed++;
      const fields = edit.fields;
      if (
        !fields.text_ja.trim() ||
        fields.text_ja.length > 2000 ||
        fields.emotion === "难以判断" ||
        fields.delivery === "难以判断"
      )
        continue;
      try {
        const wav = await readReviewedAudio(original.audio, original.source_sha256, signal);
        const { duration } = readWav(wav);
        if (duration < minimumDuration || duration > 10) continue;
        candidates.push({
          id: original.id,
          sampleId: original.id,
          duration,
          emotion: fields.emotion,
          delivery: fields.delivery,
          description: "",
          refAudioPath: original.audio,
          promptText: fields.text_ja.trim(),
          promptLanguage: "ja",
          sourceSha256: original.source_sha256,
        });
      } catch {
        signal.throwIfAborted();
        // A bad sample must not make the remaining reviewed styles unusable.
      }
    }
    const styles = reviewedSpeechStyles(candidates);
    const references: readonly SpeechReference[] =
      mode === "auxiliary"
        ? styles.map(({ id, description, refAudioPath, sourceSha256 }) => ({
            kind: "auxiliary",
            id,
            description,
            refAudioPath,
            sourceSha256,
          }))
        : styles;
    return {
      references,
      confirmed,
      usable: candidates.length,
      diagnostic: {
        ...diagnostic,
        status: references.length ? "ready" : "reachable",
        detail: `${usage}：已确认 ${confirmed} 条，可用 ${candidates.length} 条，提供 ${references.length} 种语气；${confirmed - candidates.length} 条因时长、台词、标签或音频校验未纳入。下一轮读取最新确认记录。`,
      },
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      references: [],
      confirmed: 0,
      usable: 0,
      diagnostic: {
        ...diagnostic,
        status: "error",
        detail: `复核参考暂不可用，使用角色原有参考：${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}
