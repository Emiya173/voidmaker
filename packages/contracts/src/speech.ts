import { z } from "zod";

export const replySegment = z
  .object({
    subtitle: z.string().trim().min(1).max(1000),
    text: z.string().trim().min(1).max(1000),
    referenceId: z.string().min(1).max(40),
    portraitId: z.string().min(1).max(40),
  })
  .strict();
export const characterReply = z
  .object({ openingClipId: z.string().min(1).max(40), segments: z.array(replySegment).max(40) })
  .strict();
export type SpeechSegment = Readonly<{
  subtitle: string;
  text: string;
  referenceId: string;
  portraitId?: string;
  clipId?: string;
}>;
export type WaitingClip = Readonly<{ wav: Buffer; subtitle: string }>;
export type ReplyClip = WaitingClip & Readonly<{ id: string; description: string; text: string }>;
export type SpeechReference = Readonly<{
  id: string;
  description: string;
  refAudioPath: string;
  promptText: string;
  promptLanguage: string;
}>;
