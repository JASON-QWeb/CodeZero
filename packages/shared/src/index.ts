import { access } from "node:fs/promises";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function uniqueValues<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function isUniqueValue<T>(value: T, index: number, array: T[]): boolean {
  return array.indexOf(value) === index;
}

export function uniqueNonEmptyStrings(values: string[]): string[] {
  return uniqueValues(values.map((value) => value.trim()).filter(Boolean));
}

export type CircuitBreakerState = "closed" | "open" | "half_open";

export type CircuitBreakerOptions = {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  shouldTrip?: (error: unknown) => boolean;
};

export class CircuitBreakerOpenError extends Error {
  readonly serviceId: string;
  readonly retryAfterMs: number;

  constructor(serviceId: string, retryAfterMs: number) {
    super(
      `Circuit breaker for ${serviceId} is open; retry after ${retryAfterMs}ms`,
    );
    this.name = "CircuitBreakerOpenError";
    this.serviceId = serviceId;
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  private failureCount = 0;
  private openedUntilMs = 0;
  private state: CircuitBreakerState = "closed";

  constructor(
    readonly serviceId: string,
    private readonly options: Required<CircuitBreakerOptions>,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const now = Date.now();

    if (this.state === "open") {
      if (now < this.openedUntilMs) {
        throw new CircuitBreakerOpenError(
          this.serviceId,
          this.openedUntilMs - now,
        );
      }

      this.state = "half_open";
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  snapshot(): {
    serviceId: string;
    state: CircuitBreakerState;
    failureCount: number;
    openedUntilMs: number;
  } {
    return {
      serviceId: this.serviceId,
      state: this.state,
      failureCount: this.failureCount,
      openedUntilMs: this.openedUntilMs,
    };
  }

  reset(): void {
    this.failureCount = 0;
    this.openedUntilMs = 0;
    this.state = "closed";
  }

  private recordSuccess(): void {
    this.failureCount = 0;
    this.openedUntilMs = 0;
    this.state = "closed";
  }

  private recordFailure(error: unknown): void {
    if (!this.options.shouldTrip(error)) {
      return;
    }

    this.failureCount += 1;

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = "open";
      this.openedUntilMs = Date.now() + this.options.resetTimeoutMs;
    }
  }
}

const circuitBreakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(
  serviceId: string,
  options: CircuitBreakerOptions = {},
): CircuitBreaker {
  const breaker = circuitBreakers.get(serviceId);

  if (breaker) {
    return breaker;
  }

  const next = new CircuitBreaker(serviceId, {
    failureThreshold: options.failureThreshold ?? 3,
    resetTimeoutMs: options.resetTimeoutMs ?? 60_000,
    shouldTrip: options.shouldTrip ?? (() => true),
  });
  circuitBreakers.set(serviceId, next);
  return next;
}

export function resetCircuitBreakersForTests(): void {
  for (const breaker of circuitBreakers.values()) {
    breaker.reset();
  }
  circuitBreakers.clear();
}

export const taskStatuses = [
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
  "WAITING_MERGE",
  "DONE",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export const agentRoles = [
  "prd",
  "search-planner",
  "explorer",
  "context-curator",
  "main-implementation",
  "frontend-qa",
  "backend-test",
  "review",
  "pr-writer",
] as const;

export type AgentRole = (typeof agentRoles)[number];

export type TaskType =
  | "frontend"
  | "backend"
  | "fullstack"
  | "docs"
  | "unknown";
export type RiskLevel = "low" | "medium" | "high";
export type QualityGateKind =
  | "setup"
  | "build"
  | "lint"
  | "typecheck"
  | "unit_test"
  | "frontend_screenshot";

export type IssueContext = {
  provider: "github";
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
  comments: IssueComment[];
  baseBranch: string;
};

export type IssueComment = {
  author: string;
  body: string;
  createdAt: string;
};

export type ComplexityAssessment = {
  score: number;
  requiresHumanReview: boolean;
  reasons: string[];
};

export type PrdDocument = {
  title: string;
  background: string;
  goals: string[];
  nonGoals: string[];
  userStories: string[];
  acceptanceCriteria: string[];
  risks: string[];
  unknowns: string[];
  taskType: TaskType;
  complexity: ComplexityAssessment;
};

export type Task = {
  id: string;
  issue: IssueContext;
  status: TaskStatus;
  branchName?: string;
  planningDocument?: PlanningDocument;
  contextPack?: ContextPack;
  qualityGateResults?: QualityGateResult[];
  reviewResult?: ReviewResult;
  prUrl?: string;
  sandbox?: {
    repoDir: string;
    artifactDir: string;
    logDir: string;
    mode: "docker" | "worktree";
  };
  createdAt: string;
  updatedAt: string;
};

export type TaskEventType =
  | "TASK_CREATED"
  | "TASK_QUEUED"
  | "ISSUE_COMMENT_RECEIVED"
  | "ISSUE_CONTEXT_COLLECTED"
  | "PRD_DRAFTED"
  | "PRD_APPROVED"
  | "HUMAN_REVIEW_REQUIRED"
  | "SANDBOX_CREATED"
  | "REPO_CLONED"
  | "ISSUE_BRANCH_CREATED"
  | "CODEBASE_INDEXED"
  | "AGENTIC_SEARCH_FINISHED"
  | "REPO_NAVIGATION_GRAPH_CREATED"
  | "NAVIGATION_ROUTE_CREATED"
  | "MEMORY_RETRIEVED"
  | "CONTEXT_PACK_CREATED"
  | "AGENT_RUN_STARTED"
  | "AGENT_RUN_PROGRESS"
  | "AGENT_RUN_FINISHED"
  | "COMMAND_STARTED"
  | "COMMAND_FINISHED"
  | "FILE_CHANGED"
  | "QUALITY_GATE_STARTED"
  | "QUALITY_GATE_FINISHED"
  | "SELF_CHECK_REPAIR_STARTED"
  | "SCREENSHOT_CAPTURED"
  | "SUBAGENT_REVIEW_FINISHED"
  | "PR_VERIFICATION_CREATED"
  | "PR_REVIEW_COMMENT_RECEIVED"
  | "PR_UPDATED"
  | "MEMORY_PROPOSAL_CREATED"
  | "PR_CREATED"
  | "TASK_COMPLETED"
  | "TASK_BLOCKED"
  | "TASK_FAILED";

export type TaskEvent = {
  id: string;
  taskId: string;
  type: TaskEventType;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: JsonObject;
  createdAt: string;
};

export type FileEvidence = {
  kind:
    | "keyword"
    | "path"
    | "symbol"
    | "semantic"
    | "history"
    | "business-skill"
    | "graph";
  score: number;
  summary: string;
};

export type RelevantFile = {
  path: string;
  reason: string;
  evidence: FileEvidence[];
  readMode: "full" | "excerpt" | "summary";
};

export type ContextMemory = {
  id: string;
  kind: "semantic" | "episodic" | "procedural" | "policy";
  title: string;
  content: string;
  score: number;
  confidence: number;
  reasons: string[];
  sourceTaskId?: string;
};

export type ContextPack = {
  id: string;
  taskId: string;
  taskSummary: string;
  businessRules: string[];
  memories: ContextMemory[];
  codeGraphContext?: JsonObject;
  relevantFiles: RelevantFile[];
  symbols: string[];
  tests: string[];
  similarChanges: string[];
  nonRelevantAreas: string[];
  openQuestions: string[];
  tokenBudget: number;
  createdAt: string;
};

export type MinimalChangePlan = {
  goal: string;
  acceptanceCriteria: string[];
  filesToRead: string[];
  filesExpectedToChange: string[];
  testsToAddOrUpdate: string[];
  commandsToRun: string[];
  explicitNonGoals: string[];
  riskNotes: string[];
};

export type PlanningDocument = PrdDocument & {
  implementationPlan: MinimalChangePlan;
};

export type Artifact = {
  id: string;
  taskId: string;
  type:
    | "prd"
    | "brainstorm"
    | "context-pack"
    | "repo-graph"
    | "navigation-route"
    | "screenshot"
    | "test-report"
    | "diff"
    | "review"
    | "pr-verification"
    | "tool-call"
    | "memory-context"
    | "memory-proposal"
    | "project-map-update";
  path?: string;
  url?: string;
  metadata?: JsonObject;
  createdAt: string;
};

export type QualityGateResult = {
  kind: QualityGateKind;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
};

export type ReviewFinding = {
  title: string;
  body: string;
  blocking: boolean;
  file?: string;
};

export type ReviewResult = {
  approved: boolean;
  blockingFindings: ReviewFinding[];
  nonBlockingFindings: ReviewFinding[];
  missingTests: string[];
  scopeViolations: string[];
  riskLevel: RiskLevel;
  prDescriptionNotes: string[];
};

export type TraceSpanKind =
  | "workflow"
  | "model"
  | "artifact"
  | "quality_gate"
  | "navigation"
  | "memory"
  | "github"
  | "human"
  | "error";

export type TraceSpanStatus =
  | "success"
  | "running"
  | "blocked"
  | "failed"
  | "info";

export type TraceSpan = {
  id: string;
  taskId: string;
  parentId?: string;
  name: string;
  kind: TraceSpanKind;
  status: TraceSpanStatus;
  level: TaskEvent["level"];
  message: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  metadata?: JsonObject;
};

export type TaskTrace = {
  taskId: string;
  status: TaskStatus;
  issueUrl: string;
  prUrl?: string;
  spans: TraceSpan[];
  artifacts: Artifact[];
  summary: {
    totalSpans: number;
    failedOrBlocked: number;
  };
};

export type TraceReplayStep = {
  cursor: string;
  spanId: string;
  parentId?: string;
  index: number;
  name: string;
  kind: TraceSpanKind;
  status: TraceSpanStatus;
  message: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  metadata?: JsonObject;
  canResumeFromHere: boolean;
};

export type TaskTraceReplay = {
  taskId: string;
  status: TaskStatus;
  cursor?: string;
  nextCursor?: string;
  previousCursor?: string;
  steps: TraceReplayStep[];
  failedStep?: TraceReplayStep;
  resumeActions: Array<{
    type: "approve_prd" | "retry_workflow" | "inspect_failure" | "open_pr";
    label: string;
    available: boolean;
  }>;
  summary: TaskTrace["summary"] & {
    replayedSpans: number;
    remainingSpans: number;
  };
};
