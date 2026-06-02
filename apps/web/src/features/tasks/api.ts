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
  TraceResponse,
} from "./types";
import type { Task, TaskTrace } from "@agent/shared";
import { isDemoMode } from "../demo-mode";
import {
  demoApproveTaskPrd,
  demoFetchGitHubSync,
  demoFetchMemories,
  demoFetchProjectKnowledgeGraph,
  demoFetchRepositoryContextFiles,
  demoFetchRepositoryOnboarding,
  demoFetchRepositoryQueues,
  demoFetchTasks,
  demoFetchTrace,
  demoGenerateProjectKnowledgeGraph,
  demoOpenProjectKnowledgeGraphDashboard,
  demoSaveRepositoryContextFile,
  demoTriggerGitHubSync,
  demoUpdateMemoryStatus,
} from "./mock-data";

export const apiBaseUrl = () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function fetchTasks(): Promise<Task[]> {
  if (isDemoMode()) {
    return demoFetchTasks();
  }

  const response = await fetch(`${apiBaseUrl()}/tasks`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load tasks");
  }

  const data = (await response.json()) as TasksResponse;
  return data.tasks;
}

export async function fetchRepositoryQueues(): Promise<RepositoryQueueSummary[]> {
  if (isDemoMode()) {
    return demoFetchRepositoryQueues();
  }

  const response = await fetch(`${apiBaseUrl()}/tasks/repositories`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load repository queues");
  }

  const data = (await response.json()) as RepositoryQueuesResponse;
  return data.repositories;
}

export async function fetchGitHubSync(repositoryId: string): Promise<GitHubSyncState> {
  if (isDemoMode()) {
    return demoFetchGitHubSync(repositoryId);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/github-sync`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load GitHub sync state");
  }

  return ((await response.json()) as GitHubSyncResponse).sync;
}

export async function triggerGitHubSync(repositoryId: string): Promise<GitHubSyncResponse> {
  if (isDemoMode()) {
    return demoTriggerGitHubSync(repositoryId);
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
  if (isDemoMode()) {
    return demoFetchProjectKnowledgeGraph(repositoryId);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/knowledge-graph`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load project knowledge graph");
  }

  return ((await response.json()) as ProjectKnowledgeGraphResponse).knowledgeGraph;
}

export async function fetchRepositoryOnboarding(repositoryId: string): Promise<RepositoryOnboarding> {
  if (isDemoMode()) {
    return demoFetchRepositoryOnboarding(repositoryId);
  }

  const response = await fetch(`${apiBaseUrl()}/repositories/${encodeURIComponent(repositoryId)}/onboarding`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load repository onboarding");
  }

  return ((await response.json()) as RepositoryOnboardingResponse).onboarding;
}

export async function fetchRepositoryContextFiles(repositoryId: string): Promise<RepositoryContextFile[]> {
  if (isDemoMode()) {
    return demoFetchRepositoryContextFiles(repositoryId);
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
  if (isDemoMode()) {
    return demoSaveRepositoryContextFile(input);
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
  if (isDemoMode()) {
    return demoGenerateProjectKnowledgeGraph(input);
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
  if (isDemoMode()) {
    return demoOpenProjectKnowledgeGraphDashboard(repositoryId);
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
  if (isDemoMode()) {
    return demoFetchTrace(taskId);
  }

  const response = await fetch(`${apiBaseUrl()}/tasks/${taskId}/trace`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load task trace");
  }

  const data = (await response.json()) as TraceResponse;
  return data.trace;
}

export async function approveTaskPrd(taskId: string): Promise<Task> {
  if (isDemoMode()) {
    return demoApproveTaskPrd(taskId);
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
  if (isDemoMode()) {
    return demoFetchMemories(status);
  }

  const response = await fetch(`${apiBaseUrl()}/memories?status=${status}`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load memories");
  }

  const data = (await response.json()) as MemoriesResponse;
  return data.memories;
}

export async function updateMemoryStatus(input: { id: string; status: Extract<MemoryStatus, "approved" | "rejected"> }): Promise<MemoryRecord> {
  if (isDemoMode()) {
    return demoUpdateMemoryStatus(input);
  }

  const response = await fetch(`${apiBaseUrl()}/memories/${input.id}/${input.status === "approved" ? "approve" : "reject"}`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error("Failed to update memory");
  }

  return ((await response.json()) as { memory: MemoryRecord }).memory;
}
