import type {
  MemoryRecord,
  MemoriesResponse,
  MemoryStatus,
  GitHubSyncResponse,
  GitHubSyncState,
  ProjectKnowledgeGraph,
  ProjectKnowledgeGraphResponse,
  RepositoryContextFile,
  RepositoryContextFileKind,
  RepositoryContextFilesResponse,
  RepositoryOnboarding,
  RepositoryOnboardingResponse,
  RepositoryQueueSummary,
  RepositoryQueuesResponse,
  TasksResponse,
  TaskTraceReplay,
  TraceResponse,
  TraceReplayResponse,
} from "./types";
import type { Task, TaskTrace } from "@agent/shared";
import { isMockDataMode } from "../mock-data-mode";
import {
  mockApproveTaskPrd,
  mockFetchGitHubSync,
  mockFetchMemories,
  mockFetchProjectKnowledgeGraph,
  mockFetchRepositoryContextFiles,
  mockFetchRepositoryOnboarding,
  mockFetchRepositoryQueues,
  mockFetchTasks,
  mockFetchTrace,
  mockGenerateProjectKnowledgeGraph,
  mockOpenProjectKnowledgeGraphDashboard,
  mockSaveRepositoryContextFile,
  mockTriggerGitHubSync,
  mockUpdateMemoryStatus,
} from "./mock-data";

export const apiBaseUrl = () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function fetchTasks(): Promise<Task[]> {
  if (isMockDataMode()) {
    return mockFetchTasks();
  }

  const response = await fetch(`${apiBaseUrl()}/tasks`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load tasks");
  }

  const data = (await response.json()) as TasksResponse;
  return data.tasks;
}

export async function fetchRepositoryQueues(): Promise<RepositoryQueueSummary[]> {
  if (isMockDataMode()) {
    return mockFetchRepositoryQueues();
  }

  const response = await fetch(`${apiBaseUrl()}/tasks/repositories`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load repository queues");
  }

  const data = (await response.json()) as RepositoryQueuesResponse;
  return data.repositories;
}

export async function fetchGitHubSync(repositoryId: string): Promise<GitHubSyncState> {
  if (isMockDataMode()) {
    return mockFetchGitHubSync(repositoryId);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/github-sync`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load GitHub sync state");
  }

  return ((await response.json()) as GitHubSyncResponse).sync;
}

export async function triggerGitHubSync(repositoryId: string): Promise<GitHubSyncResponse> {
  if (isMockDataMode()) {
    return mockTriggerGitHubSync(repositoryId);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/github-sync`, {
    method: "POST"
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(data.message ?? "Failed to start GitHub sync");
  }

  return (await response.json()) as GitHubSyncResponse;
}

export async function fetchProjectKnowledgeGraph(repositoryId: string): Promise<ProjectKnowledgeGraph> {
  if (isMockDataMode()) {
    return mockFetchProjectKnowledgeGraph(repositoryId);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/knowledge-graph`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load project knowledge graph");
  }

  return ((await response.json()) as ProjectKnowledgeGraphResponse).knowledgeGraph;
}

export async function fetchRepositoryOnboarding(repositoryId: string): Promise<RepositoryOnboarding> {
  if (isMockDataMode()) {
    return mockFetchRepositoryOnboarding(repositoryId);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/onboarding`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load repository onboarding");
  }

  return ((await response.json()) as RepositoryOnboardingResponse).onboarding;
}

export async function fetchRepositoryContextFiles(repositoryId: string): Promise<RepositoryContextFile[]> {
  if (isMockDataMode()) {
    return mockFetchRepositoryContextFiles(repositoryId);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/context-files`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load repository context files");
  }

  return ((await response.json()) as RepositoryContextFilesResponse).files;
}

export async function saveRepositoryContextFile(input: {
  repositoryId: string;
  kind: RepositoryContextFileKind;
  path: string;
  content: string;
}): Promise<RepositoryContextFile[]> {
  if (isMockDataMode()) {
    return mockSaveRepositoryContextFile(input);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(input.repositoryId)}/context-files`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: input.kind,
      path: input.path,
      content: input.content
    })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(data.message ?? "Failed to save repository context file");
  }

  return ((await response.json()) as RepositoryContextFilesResponse).files;
}

export async function generateProjectKnowledgeGraph(input: { repositoryId: string; full?: boolean }): Promise<ProjectKnowledgeGraph> {
  if (isMockDataMode()) {
    return mockGenerateProjectKnowledgeGraph(input);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(input.repositoryId)}/knowledge-graph/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ full: input.full })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(data.message ?? "Failed to generate project knowledge graph");
  }

  return ((await response.json()) as ProjectKnowledgeGraphResponse).knowledgeGraph;
}

export async function openProjectKnowledgeGraphDashboard(repositoryId: string): Promise<ProjectKnowledgeGraph> {
  if (isMockDataMode()) {
    return mockOpenProjectKnowledgeGraphDashboard(repositoryId);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/knowledge-graph/dashboard`, {
    method: "POST"
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(data.message ?? "Failed to start the Understand-Anything dashboard");
  }

  return ((await response.json()) as ProjectKnowledgeGraphResponse).knowledgeGraph;
}

export async function fetchTrace(taskId: string): Promise<TaskTrace> {
  if (isMockDataMode()) {
    return mockFetchTrace(taskId);
  }

  const response = await fetch(`${apiBaseUrl()}/tasks/${taskId}/trace`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load task trace");
  }

  const data = (await response.json()) as TraceResponse;
  return data.trace;
}

export async function fetchTraceReplay(input: {
  taskId: string;
  cursor?: string;
  limit?: number;
}): Promise<TaskTraceReplay> {
  if (isMockDataMode()) {
    const trace = await mockFetchTrace(input.taskId);
    return {
      taskId: trace.taskId,
      status: trace.status,
      cursor: input.cursor,
      steps: trace.spans.slice(0, input.limit ?? 25).map((span, index) => ({
        cursor: span.id,
        spanId: span.id,
        parentId: span.parentId,
        index,
        name: span.name,
        kind: span.kind,
        status: span.status,
        message: span.message,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        durationMs: span.durationMs,
        metadata: span.metadata,
        canResumeFromHere: span.status === "failed" || span.status === "blocked",
      })),
      resumeActions: [],
      summary: { ...trace.summary, replayedSpans: trace.spans.length, remainingSpans: 0 },
    };
  }

  const params = new URLSearchParams();

  if (input.cursor) {
    params.set("cursor", input.cursor);
  }

  if (input.limit) {
    params.set("limit", String(input.limit));
  }

  const query = params.toString();
  const response = await fetch(
    `${apiBaseUrl()}/tasks/${encodeURIComponent(input.taskId)}/trace/replay${query ? `?${query}` : ""}`,
    { cache: "no-store" },
  );

  if (!response.ok) {
    throw new Error("Failed to load task trace replay");
  }

  const data = (await response.json()) as TraceReplayResponse;
  return data.replay;
}

export async function approveTaskPrd(taskId: string): Promise<Task> {
  if (isMockDataMode()) {
    return mockApproveTaskPrd(taskId);
  }

  const response = await fetch(`${apiBaseUrl()}/tasks/${encodeURIComponent(taskId)}/approve-prd`, {
    method: "POST"
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(data.message ?? "Failed to approve PRD");
  }

  return ((await response.json()) as { task: Task }).task;
}

export async function fetchMemories(status: MemoryStatus): Promise<MemoryRecord[]> {
  if (isMockDataMode()) {
    return mockFetchMemories(status);
  }

  const response = await fetch(`${apiBaseUrl()}/memories?status=${status}`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load memories");
  }

  const data = (await response.json()) as MemoriesResponse;
  return data.memories;
}

export async function updateMemoryStatus(input: { id: string; status: Extract<MemoryStatus, "approved" | "rejected"> }): Promise<MemoryRecord> {
  if (isMockDataMode()) {
    return mockUpdateMemoryStatus(input);
  }

  const response = await fetch(`${apiBaseUrl()}/memories/${input.id}/${input.status === "approved" ? "approve" : "reject"}`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error("Failed to update memory");
  }

  return ((await response.json()) as { memory: MemoryRecord }).memory;
}
