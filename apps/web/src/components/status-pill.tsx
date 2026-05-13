import type { TaskStatus } from "@agent/shared";

const toneByStatus: Partial<Record<TaskStatus, string>> = {
  QUEUED: "statusQueued",
  DONE: "statusDone",
  BLOCKED: "statusBlocked",
  FAILED: "statusBlocked",
  CANCELLED: "statusMuted",
  HUMAN_REVIEW: "statusReview",
  PRD_REVIEW_REQUIRED: "statusReview",
  QUALITY_GATES_RUNNING: "statusActive",
  IMPLEMENTING: "statusActive",
  AGENTIC_SEARCHING: "statusActive"
};

export function StatusPill({ status }: { status: TaskStatus }) {
  return <span className={`statusPill ${toneByStatus[status] ?? "statusDefault"}`}>{status.replaceAll("_", " ")}</span>;
}
