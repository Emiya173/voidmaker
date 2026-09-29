import type { PortraitExpression } from "../../contracts/src/character.js";
import {
  characterReply,
  type ReplyClip,
  replySegment,
  type SpeechReference,
  type SpeechSegment,
} from "../../contracts/src/speech.js";

export type ReplyFormat = Readonly<{
  references: readonly string[];
  portraits: readonly string[];
  clips: readonly Omit<ReplyClip, "wav">[];
  schema: Record<string, unknown>;
}>;

export function replyFormat(
  references: readonly SpeechReference[],
  portraits: readonly PortraitExpression[],
  clips: readonly ReplyClip[] = [],
): ReplyFormat {
  const referenceIds = ["neutral", ...references.map((entry) => entry.id)];
  const portraitIds = ["neutral", ...portraits.map((entry) => entry.id)];
  return {
    references: referenceIds,
    portraits: portraitIds,
    clips: clips.map(({ id, description, text, subtitle }) => ({ id, description, text, subtitle })),
    schema: {
      type: "object",
      properties: {
        openingClipId: { type: "string", enum: ["none", ...clips.map((clip) => clip.id)] },
        segments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subtitle: { type: "string" },
              text: { type: "string" },
              referenceId: { type: "string", enum: referenceIds },
              portraitId: { type: "string", enum: portraitIds },
            },
            required: ["subtitle", "text", "referenceId", "portraitId"],
            additionalProperties: false,
          },
        },
      },
      required: ["openingClipId", "segments"],
      additionalProperties: false,
    },
  };
}

export function replyInstructions(
  language: "ja" | "zh",
  references: readonly SpeechReference[],
  portraits: readonly PortraitExpression[],
  clips: readonly ReplyClip[] = [],
): string {
  return `\n回复输出约定（仅供内部使用，不向用户解释）：一次生成完整回复及朗读台词，按字段顺序返回 {"openingClipId":"none","segments":[{"subtitle":"中文字幕","text":"${language === "ja" ? "自然口语日语" : "自然口语中文"}","referenceId":"neutral","portraitId":"neutral"}]}。subtitle 是界面与历史记录显示的中文，text 是实际朗读的${language === "ja" ? "日语，不能直接填写中文" : "中文"}。同段两种语言的事实、数字、限定和语气必须一致；不要先答中文再要求额外翻译。每段一至两句短句，普通对话尽量简洁，按叙述顺序分段；保留用户需要的事实、代码或列表。根据完整对话语境与本段回应意图选择参考音频和表情，只使用下方已有 ID。关心或安慰用关切、温柔；解释用引导、认真；明确好消息才用兴奋；避免夸张、无理由频繁变脸。没有合适匹配使用 neutral。不要把语气标签、表情名、设定说明写进台词。\nopeningClipId 默认 none。仅当下方某句原声的完整含义和语气适合作为本次正式回复开头时选择它，最多一句，不要为了使用素材而强行道歉、赞同或拒绝。原声会直接播放，其固定中文字幕会自动放入回复和历史；segments 仅写接续内容，不要再次写出或合成原声已表达的意思。若原声已经完整回答，可以返回空 segments。等待期间的中性短音不由此字段选择。\n${JSON.stringify(
    {
      references: [
        { id: "neutral", description: "自然平静的默认语气" },
        ...references.map(({ id, description }) => ({ id, description })),
      ],
      portraits: [
        { id: "neutral", description: "自然平静的默认立绘" },
        ...portraits.map(({ id, description }) => ({ id, description })),
      ],
      openingClips: clips.map(({ id, description, text, subtitle }) => ({ id, description, text, subtitle })),
    },
  )}`;
}

function openingSegment(id: string, format: ReplyFormat, portraitId = "neutral"): SpeechSegment | undefined {
  if (id === "none") return;
  const clip = format.clips.find((entry) => entry.id === id);
  if (!clip) throw new Error("回复使用了未配置的句首原声");
  return { subtitle: clip.subtitle, text: clip.text, referenceId: "neutral", portraitId, clipId: clip.id };
}

function validateSegment(value: unknown, format: ReplyFormat): SpeechSegment {
  const segment = replySegment.parse(value);
  if (!format.references.includes(segment.referenceId)) throw new Error("回复使用了未配置的参考音频");
  if (!format.portraits.includes(segment.portraitId)) throw new Error("回复使用了未配置的立绘表情");
  return segment;
}

export function parseReply(raw: string, format: ReplyFormat): readonly SpeechSegment[] {
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error("回复过长，请缩小问题范围");
  let segments: readonly SpeechSegment[];
  try {
    const reply = characterReply.parse(JSON.parse(raw));
    const remainder = reply.segments.map((segment) => validateSegment(segment, format));
    const opening = openingSegment(reply.openingClipId, format, remainder[0]?.portraitId);
    segments = opening ? [opening, ...remainder] : remainder;
  } catch {
    throw new Error("回复格式无效，请重试；未播放未校验的语音");
  }
  if (replyText(segments).length > 12000) throw new Error("回复过长，请缩小问题范围");
  return segments;
}

export function replyText(segments: readonly SpeechSegment[]): string {
  return segments.map((segment) => segment.subtitle).join("\n");
}

/** Only complete, validated segments reach the UI; transport JSON and Japanese stay private. */
export class ReplyStream {
  private raw = "";
  private cursor = 0;
  private started = false;
  private ended = false;
  private objectStart = -1;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private count = 0;
  private length = 0;
  constructor(private readonly format: ReplyFormat) {}
  push(delta: string): string {
    this.raw += delta;
    if (Buffer.byteLength(this.raw) > 128 * 1024) throw new Error("回复过长，请缩小问题范围");
    if (this.ended) return "";
    let display = "";
    if (!this.started) {
      // Reordered JSON is still accepted by parseReply; hold its display until final validation.
      const prefix = /^\s*\{\s*"openingClipId"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"segments"\s*:\s*\[/.exec(this.raw);
      if (!prefix) return "";
      const opening = openingSegment(JSON.parse(prefix[1] as string), this.format);
      display = opening?.subtitle ?? "";
      this.length = display.length;
      this.cursor = prefix[0].length;
      this.started = true;
    }
    for (; this.cursor < this.raw.length; this.cursor++) {
      const char = this.raw[this.cursor];
      if (this.objectStart < 0) {
        if (char === "]") {
          this.ended = true;
          break;
        }
        if (char !== "{") continue;
        this.objectStart = this.cursor;
        this.depth = 0;
      }
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (char === "\\") this.escaped = true;
        else if (char === '"') this.quoted = false;
      } else if (char === '"') this.quoted = true;
      else if (char === "{") this.depth++;
      else if (char === "}" && --this.depth === 0) {
        const segment = validateSegment(JSON.parse(this.raw.slice(this.objectStart, this.cursor + 1)), this.format);
        const text = (this.length ? "\n" : "") + segment.subtitle;
        this.length += text.length;
        if (this.count++ >= 40 || this.length > 12000) throw new Error("回复过长，请缩小问题范围");
        display += text;
        this.objectStart = -1;
      }
    }
    return display;
  }
}
