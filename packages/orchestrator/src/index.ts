import type {
  ComplexityAssessment,
  IssueContext,
  QualityGateResult,
  ReviewResult,
  Task,
  TaskStatus
} from "@agent/shared";

const terminalStatuses = new Set<TaskStatus>(["DONE", "BLOCKED", "FAILED", "CANCELLED"]);

const transitions: Record<TaskStatus, TaskStatus[]> = {
  ISSUE_RECEIVED: ["CONTEXT_COLLECTING", "CANCELLED"],
  CONTEXT_COLLECTING: ["BRAINSTORMING", "FAILED", "CANCELLED"],
  BRAINSTORMING: ["PRD_DRAFTED", "FAILED", "CANCELLED"],
  PRD_DRAFTED: ["PRD_REVIEW_REQUIRED", "SANDBOX_PREPARING", "FAILED", "CANCELLED"],
  PRD_REVIEW_REQUIRED: ["PRD_APPROVED", "BLOCKED", "CANCELLED"],
  PRD_APPROVED: ["SANDBOX_PREPARING", "CANCELLED"],
  SANDBOX_PREPARING: ["ISSUE_BRANCH_CREATED", "FAILED", "CANCELLED"],
  ISSUE_BRANCH_CREATED: ["CODEBASE_INDEXING", "FAILED", "CANCELLED"],
  CODEBASE_INDEXING: ["AGENTIC_SEARCHING", "FAILED", "CANCELLED"],
  AGENTIC_SEARCHING: ["CONTEXT_PACK_CREATED", "PRD_REVIEW_REQUIRED", "FAILED", "CANCELLED"],
  CONTEXT_PACK_CREATED: ["IMPLEMENTING", "PRD_REVIEW_REQUIRED", "FAILED", "CANCELLED"],
  IMPLEMENTING: ["QUALITY_GATES_RUNNING", "BLOCKED", "FAILED", "CANCELLED"],
  QUALITY_GATES_RUNNING: ["IMPLEMENTING", "SUBAGENT_REVIEWING", "BLOCKED", "FAILED", "CANCELLED"],
  SUBAGENT_REVIEWING: ["IMPLEMENTING", "PR_CREATING", "BLOCKED", "FAILED", "CANCELLED"],
  PR_CREATING: ["HUMAN_REVIEW", "FAILED", "CANCELLED"],
  HUMAN_REVIEW: ["DONE", "IMPLEMENTING", "BLOCKED", "CANCELLED"],
  DONE: [],
  BLOCKED: ["IMPLEMENTING", "PRD_REVIEW_REQUIRED", "CANCELLED"],
  FAILED: ["SANDBOX_PREPARING", "CANCELLED"],
  CANCELLED: []
};

export function createTask(issue: IssueContext, now = new Date()): Task {
  const timestamp = now.toISOString();

  return {
    id: `task-${issue.owner}-${issue.repo}-${issue.number}`,
    issue,
    status: "ISSUE_RECEIVED",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function transitionTask(task: Task, nextStatus: TaskStatus, now = new Date()): Task {
  if (terminalStatuses.has(task.status)) {
    throw new Error(`Cannot transition terminal task from ${task.status}`);
  }

  if (!canTransition(task.status, nextStatus)) {
    throw new Error(`Invalid task transition from ${task.status} to ${nextStatus}`);
  }

  return {
    ...task,
    status: nextStatus,
    updatedAt: now.toISOString()
  };
}

export function shouldRequirePrdReview(complexity: ComplexityAssessment, threshold = 40): boolean {
  return complexity.requiresHumanReview || complexity.score >= threshold;
}

export function makeIssueBranchName(issue: IssueContext): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

  return `agent/issue-${issue.number}-${slug || "task"}`;
}

export function allQualityGatesPassed(results: QualityGateResult[]): boolean {
  return results.length > 0 && results.every((result) => result.passed);
}

export function reviewAllowsPr(review: ReviewResult): boolean {
  return review.approved && review.blockingFindings.length === 0 && review.scopeViolations.length === 0;
}

export type WorkflowStep =
  | "collect-context"
  | "brainstorm"
  | "draft-prd"
  | "prepare-sandbox"
  | "create-issue-branch"
  | "index-codebase"
  | "agentic-search"
  | "implement"
  | "quality-gates"
  | "subagent-review"
  | "create-draft-pr";

export function createDefaultWorkflowPlan(): WorkflowStep[] {
  return [
    "collect-context",
    "brainstorm",
    "draft-prd",
    "prepare-sandbox",
    "create-issue-branch",
    "index-codebase",
    "agentic-search",
    "implement",
    "quality-gates",
    "subagent-review",
    "create-draft-pr"
  ];
}

