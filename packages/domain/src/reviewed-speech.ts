import type { SpeechReference } from "../../contracts/src/speech.js";
import { type ReviewFields, reviewOptions } from "../../contracts/src/voice-review.js";

export type ReviewedSpeechCandidate = SpeechReference &
  Readonly<Pick<ReviewFields, "emotion" | "delivery"> & { sampleId: string; duration: number }>;

/** Represent each reviewed style once; a stable, roughly five-second reference avoids prompt bloat. */
export function reviewedSpeechStyles(candidates: readonly ReviewedSpeechCandidate[]): readonly SpeechReference[] {
  const groups = new Map<string, ReviewedSpeechCandidate>();
  for (const candidate of candidates) {
    const id = `reviewed_e${reviewOptions.emotion.indexOf(candidate.emotion)}_d${reviewOptions.delivery.indexOf(candidate.delivery)}`;
    const previous = groups.get(id);
    const distance = Math.abs(candidate.duration - 5);
    if (
      !previous ||
      distance < Math.abs(previous.duration - 5) ||
      (distance === Math.abs(previous.duration - 5) && candidate.sampleId < previous.sampleId)
    )
      groups.set(id, candidate);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, candidate]) => ({
      id,
      description: `人工复核：${candidate.emotion}；${candidate.delivery}`,
      refAudioPath: candidate.refAudioPath,
      promptText: candidate.promptText,
      promptLanguage: candidate.promptLanguage,
      ...(candidate.sourceSha256 ? { sourceSha256: candidate.sourceSha256 } : {}),
    }));
}
