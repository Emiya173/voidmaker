import { z } from "zod";
import { type CharacterSnapshot, characterId } from "./character.js";
import { type DesktopSnapshot, desktopCommands } from "./desktop.js";
import type { VoiceSnapshot } from "./voice.js";
import { type Project, type WorkDetail, type WorkItem, workCommands } from "./work.js";

export const PROTOCOL_VERSION = 5;

export const clientCommand = z.discriminatedUnion("type", [
  ...workCommands,
  ...desktopCommands,
  z.object({ type: z.literal("character_select"), id: characterId }),
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
      character: CharacterSnapshot;
    }
  | { type: "desktop"; desktop: DesktopSnapshot }
  | { type: "character"; character: CharacterSnapshot }
  | { type: "message"; message: Message }
  | { type: "voice"; voice: VoiceSnapshot }
  | { type: "delta"; turnId: string; text: string }
  | { type: "status"; status: "idle" | "thinking" | "stopping" }
  | { type: "approval"; requestId: string; description: string }
  | { type: "approval_closed"; requestId: string }
  | { type: "work_list"; projects: Project[]; works: WorkItem[] }
  | { type: "work_detail"; detail: WorkDetail }
  | { type: "work_changed"; id: string }
  | { type: "work_saved"; id: string }
  | { type: "artifact_preview"; path: string; text: string; sha256: string }
  | { type: "error"; message: string };
