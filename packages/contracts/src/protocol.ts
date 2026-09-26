import { z } from "zod";
import type { VoiceSnapshot } from "./voice.js";

export const PROTOCOL_VERSION = 2;

export const clientCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.literal(PROTOCOL_VERSION) }),
  z.object({ type: z.literal("send"), text: z.string().trim().min(1).max(10_000) }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("voice_start"), continuous: z.boolean().default(false) }),
  z.object({ type: z.literal("voice_finish") }),
  z.object({
    type: z.literal("approval"),
    requestId: z.string().min(1),
    decision: z.enum(["accept", "acceptForSession", "decline"]),
  }),
]);

export type ClientCommand = z.infer<typeof clientCommand>;

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export type ServerEvent =
  | {
      type: "snapshot";
      version: number;
      sessionId: string;
      messages: Message[];
      status: "idle" | "thinking" | "stopping";
      draft: string;
      voice: VoiceSnapshot;
    }
  | { type: "message"; message: Message }
  | { type: "voice"; voice: VoiceSnapshot }
  | { type: "delta"; turnId: string; text: string }
  | { type: "status"; status: "idle" | "thinking" | "stopping" }
  | { type: "approval"; requestId: string; description: string }
  | { type: "approval_closed"; requestId: string }
  | { type: "error"; message: string };
