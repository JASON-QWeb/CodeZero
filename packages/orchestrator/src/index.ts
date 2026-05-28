import type {
  ComplexityAssessment,
  IssueContext,
  QualityGateResult,
  ReviewResult,
  Task,
  TaskStatus
} from "@agent/shared";

const terminalStatuses = new Set<TaskStatus>(["DONE", "CANCELLED"]);
const queueWaitingStatuses = new Set<TaskStatus>(["QUEUED", "ISSUE_RECEIVED", "PRD_APPROVED"]);
const humanWaitingStatuses = new Set<TaskStatus>(["PRD_REVIEW_REQUIRED", "HUMAN_REVIEW"]);
const computeActiveStatuses = new Set<TaskStatus>([
  "CONTEXT_COLLECTING",
  "BRAINSTORMING",
  "PRD_DRAFTED",
  "SANDBOX_PREPARING",
  "ISSUE_BRANCH_CREATED",
  "CODEBASE_INDEXING",
  "AGENTIC_SEARCHING",
  "CONTEXT_PACK_CREATED",
  "IMPLEMENTING",
  "QUALITY_GATES_RUNNING",
  "SUBAGENT_REVIEWING",
  "PR_CREATING"
]);

const transitions: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ["CONTEXT_COLLECTING", "SANDBOX_PREPARING", "CANCELLED", "BLOCKED"],
  ISSUE_RECEIVED: ["QUEUED", "CONTEXT_COLLECTING", "SANDBOX_PREPARING", "CANCELLED", "BLOCKED"],
  CONTEXT_COLLECTING: ["SANDBOX_PREPARING", "BRAINSTORMING", "FAILED", "CANCELLED"],
  BRAINSTORMING: ["PRD_DRAFTED", "FAILED", "CANCELLED"],
  PRD_DRAFTED: ["PRD_REVIEW_REQUIRED", "PRD_APPROVED", "SANDBOX_PREPARING", "FAILED", "CANCELLED"],
  PRD_REVIEW_REQUIRED: ["PRD_APPROVED", "SANDBOX_PREPARING", "BLOCKED", "CANCELLED"],
  PRD_APPROVED: ["SANDBOX_PREPARING", "BRAINSTORMING", "IMPLEMENTING", "CANCELLED"],
  SANDBOX_PREPARING: ["ISSUE_BRANCH_CREATED", "FAILED", "CANCELLED"],
  ISSUE_BRANCH_CREATED: ["CODEBASE_INDEXING", "FAILED", "CANCELLED"],
  CODEBASE_INDEXING: ["AGENTIC_SEARCHING", "FAILED", "CANCELLED"],
  AGENTIC_SEARCHING: ["CONTEXT_PACK_CREATED", "PRD_REVIEW_REQUIRED", "FAILED", "CANCELLED"],
  CONTEXT_PACK_CREATED: ["BRAINSTORMING", "PRD_APPROVED", "IMPLEMENTING", "PRD_REVIEW_REQUIRED", "FAILED", "CANCELLED"],
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
    status: "QUEUED",
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

export type RepositoryConcurrencyConfig = {
  id: string;
  github_owner: string;
  github_repo: string;
  queue?: {
    max_concurrent_issues?: number;
  };
};

export type RepositoryQueueState = {
  maxConcurrentIssues: number;
  runningCount: number;
  queuedCount: number;
  reviewCount: number;
  blockedCount: number;
  completedCount: number;
  totalCount: number;
  availableSlots: number;
};

export type RepositoryConcurrencyDecision = RepositoryQueueState & {
  shouldDefer: boolean;
  reason: string;
};

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return terminalStatuses.has(status);
}

export function isQueueWaitingStatus(status: TaskStatus): boolean {
  return queueWaitingStatuses.has(status);
}

export function isHumanWaitingStatus(status: TaskStatus): boolean {
  return humanWaitingStatuses.has(status);
}

export function isComputeActiveStatus(status: TaskStatus): boolean {
  return computeActiveStatuses.has(status);
}

export function computeRepositoryQueueState(tasks: Task[], repository: RepositoryConcurrencyConfig): RepositoryQueueState {
  const repositoryTasks = tasks.filter((task) => isTaskForRepository(task, repository));
  const maxConcurrentIssues = normalizeMaxConcurrentIssues(repository.queue?.max_concurrent_issues);
  const runningCount = repositoryTasks.filter((task) => isComputeActiveStatus(task.status)).length;
  const queuedCount = repositoryTasks.filter((task) => isQueueWaitingStatus(task.status)).length;
  const reviewCount = repositoryTasks.filter((task) => isHumanWaitingStatus(task.status)).length;
  const blockedCount = repositoryTasks.filter((task) => task.status === "BLOCKED" || task.status === "FAILED").length;
  const completedCount = repositoryTasks.filter((task) => task.status === "DONE" || task.status === "CANCELLED").length;

  return {
    maxConcurrentIssues,
    runningCount,
    queuedCount,
    reviewCount,
    blockedCount,
    completedCount,
    totalCount: repositoryTasks.length,
    availableSlots: Math.max(0, maxConcurrentIssues - runningCount)
  };
}

export function shouldDeferForRepositoryConcurrency(
  tasks: Task[],
  task: Task,
  repository: RepositoryConcurrencyConfig
): RepositoryConcurrencyDecision {
  const state = computeRepositoryQueueState(tasks, repository);

  if (isComputeActiveStatus(task.status)) {
    return {
      ...state,
      shouldDefer: false,
      reason: "Task is already running"
    };
  }

  if (state.runningCount >= state.maxConcurrentIssues) {
    return {
      ...state,
      shouldDefer: true,
      reason: `Repository ${repository.github_owner}/${repository.github_repo} is at capacity ${state.runningCount}/${state.maxConcurrentIssues}`
    };
  }

  return {
    ...state,
    shouldDefer: false,
    reason: `Repository ${repository.github_owner}/${repository.github_repo} has ${state.availableSlots} available slot(s)`
  };
}

function isTaskForRepository(task: Task, repository: RepositoryConcurrencyConfig): boolean {
  return task.issue.owner === repository.github_owner && task.issue.repo === repository.github_repo;
}

function normalizeMaxConcurrentIssues(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 1;
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
    "prepare-sandbox",
    "create-issue-branch",
    "index-codebase",
    "agentic-search",
    "brainstorm",
    "draft-prd",
    "implement",
    "quality-gates",
    "subagent-review",
    "create-draft-pr"
  ];
}
