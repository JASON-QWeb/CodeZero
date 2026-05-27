import type { Task, TaskTrace } from "@agent/shared";

export type TasksResponse = {
  tasks: Task[];
};

export type RepositoryQueueSummary = {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  configured: boolean;
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

export type KnowledgeGraphStatus = "missing" | "generating" | "ready" | "failed";

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

export type TraceResponse = {
  trace: TaskTrace;
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
