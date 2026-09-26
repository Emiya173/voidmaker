import { z } from "zod";

export const workStatus = z.enum([
  "draft",
  "queued",
  "running",
  "awaiting_permission",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type WorkStatus = z.infer<typeof workStatus>;
export type Project = Readonly<{ id: string; name: string; path: string }>;
export type WorkItem = Readonly<{
  id: string;
  projectId: string;
  prompt: string;
  status: WorkStatus;
  attemptId: string | null;
  revision: number;
  createdAt: string;
}>;
export type Attempt = Readonly<{
  id: string;
  status: WorkStatus;
  threadId: string | null;
  turnId: string | null;
  result: string;
  error: string;
  startedAt: string;
  finishedAt: string | null;
}>;
export type WorkEvent = Readonly<{
  id: string;
  attemptId: string | null;
  kind: string;
  text: string;
  createdAt: string;
}>;
export type WorkApproval = Readonly<{
  id: string;
  attemptId: string;
  description: string;
  decision: "accept" | "decline" | "expired" | null;
  expiresAt: string;
}>;
export type Artifact = Readonly<{
  id: string;
  attemptId: string;
  path: string;
  sha256: string;
  size: number;
  kind: string;
}>;
export type WorkDetail = Readonly<{
  work: WorkItem;
  attempts: Attempt[];
  events: WorkEvent[];
  approvals: WorkApproval[];
  artifacts: Artifact[];
}>;

const id = z.uuid();
export const workCommands = [
  z.object({
    type: z.literal("project_add"),
    name: z.string().trim().min(1).max(80),
    path: z.string().min(1).max(4096),
  }),
  z.object({ type: z.literal("work_list") }),
  z.object({ type: z.literal("work_get"), id }),
  z.object({ type: z.literal("work_draft"), id, projectId: id, prompt: z.string().trim().min(1).max(10_000) }),
  z.object({
    type: z.literal("work_edit"),
    id,
    revision: z.int().nonnegative(),
    prompt: z.string().trim().min(1).max(10_000),
  }),
  z.object({ type: z.literal("work_submit"), id, revision: z.int().nonnegative() }),
  z.object({ type: z.literal("work_retry"), id, revision: z.int().nonnegative() }),
  z.object({ type: z.literal("work_cancel"), id }),
  z.object({ type: z.literal("work_approval"), id, decision: z.enum(["accept", "decline"]) }),
  z.object({ type: z.literal("artifact_open"), id }),
] as const;
export type WorkCommand = z.infer<ReturnType<typeof workCommandSchema>>;
function workCommandSchema() {
  return z.discriminatedUnion("type", workCommands);
}
