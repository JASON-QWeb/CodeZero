export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

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
  "DONE",
  "BLOCKED",
  "FAILED",
  "CANCELLED"
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
  "pr-writer"
] as const;

export type AgentRole = (typeof agentRoles)[number];

export type TaskType = "frontend" | "backend" | "fullstack" | "docs" | "unknown";
export type RiskLevel = "low" | "medium" | "high";
export type QualityGateKind = "setup" | "build" | "lint" | "typecheck" | "unit_test" | "frontend_screenshot";

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
  prd?: PrdDocument;
  contextPack?: ContextPack;
  minimalChangePlan?: MinimalChangePlan;
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
  | "PLAN_CREATED"
  | "COMMAND_STARTED"
  | "COMMAND_FINISHED"
  | "TOOL_CALL_STARTED"
  | "TOOL_CALL_FINISHED"
  | "POLICY_DECISION"
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
  kind: "keyword" | "path" | "symbol" | "semantic" | "history" | "business-skill" | "graph";
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
  knowledgeGraphContext?: JsonObject;
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
  | "tool"
  | "policy"
  | "artifact"
  | "quality_gate"
  | "navigation"
  | "memory"
  | "github"
  | "human"
  | "error";

export type TraceSpanStatus = "success" | "running" | "blocked" | "failed" | "info";

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
    toolCalls: number;
    policyDecisions: number;
    failedOrBlocked: number;
  };
};
