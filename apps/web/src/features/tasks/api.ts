import type {
  MemoryRecord,
  MemoriesResponse,
  MemoryStatus,
  GitHubSyncResponse,
  GitHubSyncState,
  ProjectKnowledgeGraph,
  ProjectKnowledgeGraphResponse,
  RepositoryOnboarding,
  RepositoryOnboardingResponse,
  RepositoryQueueSummary,
  RepositoryQueuesResponse,
  TasksResponse,
  TraceResponse
} from "./types";
import type { Task, TaskTrace } from "@agent/shared";

export const apiBaseUrl = () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function fetchTasks(): Promise<Task[]> {
  const response = await fetch(`${apiBaseUrl()}/tasks`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load tasks");
  }

  const data = (await response.json()) as TasksResponse;
  return data.tasks;
}

export async function fetchRepositoryQueues(): Promise<RepositoryQueueSummary[]> {
  const response = await fetch(`${apiBaseUrl()}/tasks/repositories`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load repository queues");
  }

  const data = (await response.json()) as RepositoryQueuesResponse;
  return data.repositories;
}

export async function fetchGitHubSync(repositoryId: string): Promise<GitHubSyncState> {
  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/github-sync`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load GitHub sync state");
  }

  return ((await response.json()) as GitHubSyncResponse).sync;
}

export async function triggerGitHubSync(repositoryId: string): Promise<GitHubSyncResponse> {
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
  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/knowledge-graph`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load project knowledge graph");
  }

  return ((await response.json()) as ProjectKnowledgeGraphResponse).knowledgeGraph;
}

export async function fetchRepositoryOnboarding(repositoryId: string): Promise<RepositoryOnboarding> {
  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/onboarding`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load repository onboarding");
  }

  return ((await response.json()) as RepositoryOnboardingResponse).onboarding;
}

export async function generateProjectKnowledgeGraph(input: { repositoryId: string; full?: boolean }): Promise<ProjectKnowledgeGraph> {
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
  const response = await fetch(`${apiBaseUrl()}/tasks/${taskId}/trace`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load task trace");
  }

  const data = (await response.json()) as TraceResponse;
  return data.trace;
}

export async function approveTaskPrd(taskId: string): Promise<Task> {
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
  const response = await fetch(`${apiBaseUrl()}/memories?status=${status}`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load memories");
  }

  const data = (await response.json()) as MemoriesResponse;
  return data.memories;
}

export async function updateMemoryStatus(input: { id: string; status: Extract<MemoryStatus, "approved" | "rejected"> }): Promise<MemoryRecord> {
  const response = await fetch(`${apiBaseUrl()}/memories/${input.id}/${input.status === "approved" ? "approve" : "reject"}`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error("Failed to update memory");
  }

  return ((await response.json()) as { memory: MemoryRecord }).memory;
}
