import type { CharacterPresentation } from "../../contracts/src/character.js";
import type { VoiceSnapshot } from "../../contracts/src/voice.js";

export type Portraits = Readonly<Partial<Record<"idle" | "listening" | "thinking" | "speaking" | "mouthOpen", string>>>;
export function characterPresentation(
  portraits: Portraits,
  voice: VoiceSnapshot,
  thinking: boolean,
  layered = false,
): CharacterPresentation {
  const state = voice.error
    ? "error"
    : voice.phase === "speaking"
      ? "speaking"
      : voice.phase === "listening"
        ? "listening"
        : thinking || ["thinking", "transcribing", "synthesizing"].includes(voice.phase)
          ? "thinking"
          : "idle";
  const mouth =
    state === "speaking" && voice.duration > 0 && voice.position < voice.duration && Number.isFinite(voice.level)
      ? Math.min(1, Math.max(0, (voice.level - 0.008) * 12))
      : 0;
  const imageUrl =
    mouth > 0.2 && portraits.mouthOpen
      ? portraits.mouthOpen
      : (portraits[state === "error" ? "idle" : state] ?? portraits.idle ?? "");
  return {
    state,
    mouth,
    imageUrl: layered && imageUrl === portraits.idle ? "" : imageUrl,
    baseUrl: layered ? (portraits.idle ?? "") : "",
    subtitle: state === "speaking" ? voice.subtitle : "",
  };
}

export function characterInstructions(name: string, persona: string): string {
  if (!persona) return "";
  return `角色名称：${name}\n角色设定：\n${persona}\n保持角色表达风格，但不虚构已经执行的操作；权限、任务确认和桌面上下文规则仍然有效。`;
}
