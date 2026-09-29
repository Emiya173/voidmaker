import { z } from "zod";

export type ComposerSnapshot = Readonly<{
  text: string;
  revision: number;
  desktopId: string | null;
  transcript: Readonly<{ text: string; generation: number; revision: number }> | null;
}>;

const sessionId = z.string().min(1).max(128);
const source = z.enum(["text", "transcript"]);
const generation = z.number().int().nonnegative();
export const composerCommands = [
  z.object({
    type: z.literal("composer_edit"),
    sessionId,
    source,
    generation,
    text: z.string().max(10_000),
    requestId: z.string().min(1).max(128),
  }),
  z.object({ type: z.literal("composer_send"), sessionId, source, generation }),
  z.object({ type: z.literal("composer_attach"), sessionId, id: z.string().min(1).nullable() }),
  z.object({
    type: z.literal("composer_resolve"),
    sessionId,
    generation,
    action: z.enum(["replace", "append", "discard"]),
  }),
] as const;
