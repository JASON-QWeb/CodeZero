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
