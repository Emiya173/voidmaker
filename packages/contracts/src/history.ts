import { z } from "zod";
import type { Message } from "./protocol.js";

const id = z.uuid();
const request = { requestId: z.string().min(1).max(80) };
const page = { ...request, before: id.optional(), query: z.string().trim().max(200).default("") };
export const historyCommands = [
  z.object({ type: z.literal("session_list"), ...page, archived: z.boolean().default(false) }),
  z.object({ type: z.literal("session_create"), title: z.string().trim().min(1).max(120) }),
  z.object({ type: z.literal("session_select"), id }),
  z.object({
    type: z.literal("session_rename"),
    id,
    revision: z.int().nonnegative(),
    title: z.string().trim().min(1).max(120),
  }),
  z.object({ type: z.literal("session_archive"), id, revision: z.int().nonnegative(), archived: z.boolean() }),
  z.object({ type: z.literal("session_delete"), id, revision: z.int().nonnegative() }),
  z.object({ type: z.literal("history_list"), ...page, sessionId: id }),
  z.object({ type: z.literal("memory_list"), ...request, sessionId: id }),
  z.object({
    type: z.literal("memory_save"),
    sessionId: id,
    id: id.optional(),
    revision: z.int().nonnegative().optional(),
    scope: z.enum(["character", "session"]),
    text: z.string().trim().min(1).max(2000),
    enabled: z.boolean(),
  }),
  z.object({ type: z.literal("memory_delete"), sessionId: id, id, revision: z.int().nonnegative() }),
] as const;
export type HistoryCommand = z.infer<(typeof historyCommands)[number]>;
export type SessionSummary = Readonly<{
  id: string;
  title: string;
  archived: boolean;
  revision: number;
  createdAt: string;
}>;
export type Memory = Readonly<{
  id: string;
  sessionId: string | null;
  text: string;
  enabled: boolean;
  revision: number;
  updatedAt: string;
  source: "manual";
}>;
export type Page<T> = Readonly<{ items: readonly T[]; next: string | null }>;
export type HistoryEvent =
  | { type: "session_list"; requestId: string; characterId: string; page: Page<SessionSummary> }
  | { type: "history_list"; requestId: string; sessionId: string; page: Page<Message> }
  | { type: "memory_list"; requestId: string; sessionId: string; items: readonly Memory[] }
  | { type: "library_changed" };
