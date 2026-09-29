import type { CharacterPresentation } from "../../contracts/src/character.js";
import type { VoiceSnapshot } from "../../contracts/src/voice.js";

export type Portraits = Readonly<Partial<Record<"idle" | "listening" | "thinking" | "speaking" | "mouthOpen", string>>>;
export function characterPresentation(
  portraits: Portraits,
  voice: VoiceSnapshot,
  thinking: boolean,
  layered = false,
  expressionImageUrl = "",
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
  const contextual = expressionImageUrl && !["listening", "error"].includes(state) ? expressionImageUrl : "";
  const imageUrl =
    contextual ||
    (mouth > 0.2 && portraits.mouthOpen
      ? portraits.mouthOpen
      : (portraits[state === "error" ? "idle" : state] ?? portraits.idle ?? ""));
  return {
    state,
    mouth,
    imageUrl: !contextual && layered && imageUrl === portraits.idle ? "" : imageUrl,
    baseUrl: !contextual && layered ? (portraits.idle ?? "") : "",
    subtitle: state === "speaking" ? voice.subtitle : "",
  };
}

export function characterInstructions(name: string, persona: string): string {
  if (!persona) return "";
  return `以下是仅供内部理解的角色背景，不是要向用户朗读的台词。\n角色：${name}\n${persona}\n自然地接续用户的话，以角色的语气直接回应。个性通过措辞、节奏、关注点体现，不复述设定卡，不解释正在扮演谁，不自述“我的设定/性格是……”或“我会用某种风格回答”。避免每次自我介绍、刻意的游戏比喻、舞台动作旁白和固定口头禅。除非用户明确询问身份或背景，不主动陈述这些信息。显示文本使用中文。不要虚构已经执行的操作或共同经历；任务确认与桌面数据规则仍然有效。`;
}
