import type { Task, TaskTrace, TraceSpan, TraceSpanKind } from "@agent/shared";

export type TasksResponse = {
  tasks: Task[];
};

export type RepositoryQueueSummary = {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  configured: boolean;
  projectSkillPath: string;
  projectRulePath: string;
  maxConcurrentIssues: number;
  runningCount: number;
  queuedCount: number;
  reviewCount: number;
  blockedCount: number;
  completedCount: number;
  totalCount: number;
  availableSlots: number;
  tasks: Task[];
};

export type RepositoryQueuesResponse = {
  repositories: RepositoryQueueSummary[];
};

export type GitHubSyncStatus = "idle" | "running" | "finished" | "failed";

export type GitHubSyncResult = {
  repositoryId: string;
  fullName: string;
  scannedIssues: number;
  importedIssues: number;
  skippedIssues: number;
  scannedFeedbackPullRequests: number;
  importedFeedbackComments: number;
  queuedFeedbackTasks: number;
  failedFeedbackQueues: number;
  skippedFeedbackComments: number;
};

export type GitHubSyncState = {
  repositoryId: string;
  status: GitHubSyncStatus;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
  lastResult?: GitHubSyncResult;
};

export type GitHubSyncResponse = {
  started?: boolean;
  sync: GitHubSyncState;
};

export type KnowledgeGraphStatus =
  | "missing"
  | "generating"
  | "ready"
  | "failed";

export type ProjectKnowledgeGraph = {
  repositoryId: string;
  fullName: string;
  status: KnowledgeGraphStatus;
  graphAvailable: boolean;
  pluginInstalled: boolean;
  provider: {
    name: "Understand-Anything";
    projectUrl: string;
    testedVersion: string;
    outputFile: ".understand-anything/knowledge-graph.json";
  };
  graph?: {
    projectName?: string;
    analyzedAt?: string;
    nodes?: number;
    edges?: number;
  };
  message?: string;
  dashboardUrl?: string;
};

export type ProjectKnowledgeGraphResponse = {
  knowledgeGraph: ProjectKnowledgeGraph;
};

export type RepositoryOnboardingStatus =
  | "missing"
  | "generating"
  | "ready"
  | "failed";

export type RepositoryOnboarding = {
  repositoryId: string;
  fullName: string;
  status: RepositoryOnboardingStatus;
  codeGraphAvailable: boolean;
  cacheDatabaseFile: string;
  message?: string;
  updatedAt?: string;
  codeGraph?: {
    operation: "initialized" | "synced";
    changeDetection:
      | "initial-index"
      | "restored-cache-hash-scan"
      | "working-tree-sync";
    databaseFile: string;
    indexDir: string;
    durationMs: number;
    displayCommand: string;
  };
  summary?: {
    files: number;
    symbols: number;
    routes: number;
    tests: number;
    packageManager: string;
  };
  documents?: Array<{ path: string; type: string; content?: string }>;
};

export type RepositoryOnboardingResponse = {
  onboarding: RepositoryOnboarding;
};

export type RepositoryContextFileKind = "skill" | "rule";

export type RepositoryContextFile = {
  kind: RepositoryContextFileKind;
  path: string;
  name: string;
  content: string;
  updatedAt?: string;
};

export type RepositoryContextFilesResponse = {
  files: RepositoryContextFile[];
};

export type TraceResponse = {
  trace: TaskTrace;
};

export type TraceReplayStep = {
  cursor: string;
  spanId: string;
  parentId?: string;
  index: number;
  name: string;
  kind: TraceSpanKind;
  status: TraceSpan["status"];
  message: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
  canResumeFromHere: boolean;
};

export type TaskTraceReplay = {
  taskId: string;
  status: Task["status"];
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

export type TraceReplayResponse = {
  replay: TaskTraceReplay;
};

export type MemoryStatus = "proposed" | "approved" | "rejected";

export type MemoryRecord = {
  id: string;
  kind: "semantic" | "episodic" | "procedural" | "policy";
  status: MemoryStatus;
  scope: "repository" | "global";
  owner?: string;
  repo?: string;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  sourceTaskId?: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoriesResponse = {
  memories: MemoryRecord[];
};
