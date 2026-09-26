import type { WorkStatus } from "../../contracts/src/work.js";

export type WorkAction =
  | "submit"
  | "start"
  | "request_permission"
  | "decide"
  | "cancel"
  | "complete"
  | "fail"
  | "stop"
  | "recover"
  | "retry";
const transitions: Readonly<Partial<Record<WorkStatus, Partial<Record<WorkAction, WorkStatus>>>>> = {
  draft: { submit: "queued", cancel: "cancelled" },
  queued: { start: "running", cancel: "cancelled", recover: "interrupted" },
  running: {
    request_permission: "awaiting_permission",
    cancel: "cancelling",
    complete: "completed",
    fail: "failed",
    recover: "interrupted",
  },
  awaiting_permission: { decide: "running", cancel: "cancelling", fail: "failed", recover: "interrupted" },
  cancelling: { stop: "cancelled", recover: "interrupted" },
  failed: { retry: "queued" },
  cancelled: { retry: "queued" },
  interrupted: { retry: "queued" },
};
export function transitionWork(status: WorkStatus, action: WorkAction): WorkStatus {
  const next = transitions[status]?.[action];
  if (!next) throw new Error(`任务状态 ${status} 不允许 ${action}`);
  return next;
}
export const isActiveWork = (status: WorkStatus): boolean =>
  ["running", "awaiting_permission", "cancelling"].includes(status);
export const canRetryWork = (status: WorkStatus): boolean => ["failed", "cancelled", "interrupted"].includes(status);
