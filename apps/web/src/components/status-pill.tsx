import type { TaskStatus } from "@agent/shared";

export type StatusLocale = "zh" | "en";

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

const statusLabel: Record<StatusLocale, Record<TaskStatus, string>> = {
  zh: {
    QUEUED: "排队中",
    ISSUE_RECEIVED: "已接收 Issue",
    CONTEXT_COLLECTING: "收集上下文",
    BRAINSTORMING: "需求发散",
    PRD_DRAFTED: "PRD 已生成",
    PRD_REVIEW_REQUIRED: "等待 PRD 审批",
    PRD_APPROVED: "PRD 已批准",
    SANDBOX_PREPARING: "准备沙箱",
    ISSUE_BRANCH_CREATED: "分支已创建",
    CODEBASE_INDEXING: "代码建图中",
    AGENTIC_SEARCHING: "智能检索中",
    CONTEXT_PACK_CREATED: "上下文包已生成",
    IMPLEMENTING: "实现中",
    QUALITY_GATES_RUNNING: "自检中",
    SUBAGENT_REVIEWING: "Review 中",
    PR_CREATING: "创建 PR 中",
    HUMAN_REVIEW: "等待人工 Review",
    DONE: "已完成",
    BLOCKED: "已阻塞",
    FAILED: "失败",
    CANCELLED: "已取消"
  },
  en: Object.fromEntries(taskStatuses().map((status) => [status, status.replaceAll("_", " ")])) as Record<TaskStatus, string>
};

export function StatusPill({ locale = "en", status }: { locale?: StatusLocale; status: TaskStatus }) {
  return <span className={`statusPill ${toneByStatus[status] ?? "statusDefault"}`}>{statusLabel[locale][status]}</span>;
}

function taskStatuses(): TaskStatus[] {
  return [
    "QUEUED",
    "ISSUE_RECEIVED",
    "CONTEXT_COLLECTING",
    "BRAINSTORMING",
    "PRD_DRAFTED",
    "PRD_REVIEW_REQUIRED",
    "PRD_APPROVED",
    "SANDBOX_PREPARING",
    "ISSUE_BRANCH_CREATED",
    "CODEBASE_INDEXING",
    "AGENTIC_SEARCHING",
    "CONTEXT_PACK_CREATED",
    "IMPLEMENTING",
    "QUALITY_GATES_RUNNING",
    "SUBAGENT_REVIEWING",
    "PR_CREATING",
    "HUMAN_REVIEW",
    "DONE",
    "BLOCKED",
    "FAILED",
    "CANCELLED"
  ];
}
