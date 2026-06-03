import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskTrace, TraceSpan, TraceSpanKind } from "@agent/shared";
import {
  fetchMemories,
  fetchProjectKnowledgeGraph,
  fetchRepositoryContextFiles,
  fetchRepositoryOnboarding,
  fetchRepositoryQueues,
  fetchTasks,
  fetchTrace,
  fetchTraceReplay,
  generateProjectKnowledgeGraph,
  openProjectKnowledgeGraphDashboard,
  approveTaskPrd,
  saveRepositoryContextFile,
  triggerGitHubSync,
  updateMemoryStatus
} from "../apps/web/src/features/tasks/api";
import { buildRepositorySummariesFromTasks, isQueuedStatus, isRunningStatus } from "../apps/web/src/features/tasks/repository-summary";
import { formatTime } from "../apps/web/src/features/tasks/time";
import type { MemoryRecord } from "../apps/web/src/features/tasks/types";

describe("web task board utilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NEXT_PUBLIC_MOCK_DATA;
  });

  it("summarizes sample tasks by repository status buckets", () => {
    const summaries = buildRepositorySummariesFromTasks(mockTasks);
    const commerce = summaries.find((summary) => summary.fullName === "sample/commerce");
    const billing = summaries.find((summary) => summary.fullName === "sample/billing");

    expect(commerce).toMatchObject({
      runningCount: 1,
      queuedCount: 1,
      availableSlots: 1
    });
    expect(billing).toMatchObject({
      reviewCount: 1,
      maxConcurrentIssues: 1
    });
    expect(isQueuedStatus("QUEUED")).toBe(true);
    expect(isRunningStatus("IMPLEMENTING")).toBe(true);
    expect(isRunningStatus("DONE")).toBe(false);
  });

  it("formats UTC timestamps for dense task rows", () => {
    expect(formatTime("2026-05-12T10:05:00.000Z")).toBe("May 12, 10:05 UTC");
  });

  it("builds a sample trace with consistent summary counts", () => {
    const trace = mockTrace(mockTasks[0] as Task);

    expect(trace.summary.totalSpans).toBe(trace.spans.length);
    expect(trace.spans.map((span) => span.kind)).toContain("quality_gate");
  });

  it("fetches task board resources from the configured API base URL", async () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    const knowledgeGraph = {
      repositoryId: "commerce",
      fullName: "sample/commerce",
      status: "ready" as const,
      graphAvailable: true,
      pluginInstalled: true,
      provider: {
        name: "Understand-Anything" as const,
        projectUrl: "https://github.com/Lum1104/Understand-Anything",
        testedVersion: "v2.7.3",
        outputFile: ".understand-anything/knowledge-graph.json" as const
      }
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tasks")) {
        return ok({ tasks: mockTasks });
      }
      if (url.endsWith("/tasks/repositories")) {
        return ok({ repositories: buildRepositorySummariesFromTasks(mockTasks) });
      }
      if (url.endsWith(`/tasks/${mockTasks[0]?.id}/trace`)) {
        return ok({ trace: mockTrace(mockTasks[0] as Task) });
      }
      if (url.includes(`/tasks/${mockTasks[0]?.id}/trace/replay`)) {
        const trace = mockTrace(mockTasks[0] as Task);
        return ok({
          replay: {
            taskId: trace.taskId,
            status: trace.status,
            steps: [],
            resumeActions: [],
            summary: { ...trace.summary, replayedSpans: 0, remainingSpans: trace.spans.length }
          }
        });
      }
      if (url.endsWith("/memories?status=proposed")) {
        return ok({ memories: mockMemories });
      }
      if (url.includes("/repositories/commerce/knowledge-graph")) {
        return ok({ knowledgeGraph });
      }
      if (url.includes("/repositories/commerce/onboarding")) {
        return ok({
          onboarding: {
            repositoryId: "commerce",
            fullName: "sample/commerce",
            status: "ready",
            codeGraphAvailable: true,
            cacheDatabaseFile: "/tmp/codegraph.db"
          }
        });
      }
      if (url.includes("/repositories/commerce/context-files")) {
        return ok({
          files: [
            {
              kind: "skill",
              path: ".agent/skills/repository-rules/SKILL.md",
              name: "repository-rules",
              content: "# Repository Rules\n"
            }
          ]
        });
      }
      return ok({ memory: { ...mockMemories[0], status: "approved" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTasks()).resolves.toHaveLength(mockTasks.length);
    await expect(fetchRepositoryQueues()).resolves.toHaveLength(2);
    await expect(fetchTrace(mockTasks[0]?.id ?? "")).resolves.toMatchObject({ taskId: mockTasks[0]?.id });
    await expect(fetchTraceReplay({ taskId: mockTasks[0]?.id ?? "", limit: 5 })).resolves.toMatchObject({ taskId: mockTasks[0]?.id });
    await expect(fetchMemories("proposed")).resolves.toEqual(mockMemories);
    await expect(fetchProjectKnowledgeGraph("commerce")).resolves.toMatchObject({ status: "ready" });
    await expect(fetchRepositoryOnboarding("commerce")).resolves.toMatchObject({ codeGraphAvailable: true });
    await expect(fetchRepositoryContextFiles("commerce")).resolves.toHaveLength(1);
    await expect(generateProjectKnowledgeGraph({ repositoryId: "commerce" })).resolves.toMatchObject({ provider: { name: "Understand-Anything" } });
    await expect(openProjectKnowledgeGraphDashboard("commerce")).resolves.toMatchObject({ graphAvailable: true });
    await expect(saveRepositoryContextFile({
      repositoryId: "commerce",
      kind: "rule",
      path: ".agent/rules/project.md",
      content: "# Project\n"
    })).resolves.toHaveLength(1);
    await expect(updateMemoryStatus({ id: mockMemories[0]?.id ?? "", status: "approved" })).resolves.toMatchObject({ status: "approved" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.test/tasks");
  });

  it("serves deterministic task board mock data without network calls", async () => {
    process.env.NEXT_PUBLIC_MOCK_DATA = "1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tasks = await fetchTasks();
    const repositories = await fetchRepositoryQueues();
    const repositoryId = repositories[0]?.id ?? "";
    const memories = await fetchMemories("proposed");

    expect(tasks.length).toBeGreaterThan(3);
    expect(repositories.map((repository) => repository.fullName)).toContain("JASON-QWeb/CodeZero");
    expect(memories.length).toBeGreaterThan(0);
    await expect(fetchTrace(tasks[0]?.id ?? "")).resolves.toMatchObject({ taskId: tasks[0]?.id });
    await expect(fetchProjectKnowledgeGraph(repositoryId)).resolves.toMatchObject({ status: "ready" });
    await expect(fetchRepositoryOnboarding(repositoryId)).resolves.toMatchObject({ codeGraphAvailable: true });
    await expect(fetchRepositoryContextFiles(repositoryId)).resolves.toHaveLength(2);
    await expect(triggerGitHubSync(repositoryId)).resolves.toMatchObject({ sync: { status: "finished" } });
    await expect(generateProjectKnowledgeGraph({ repositoryId })).resolves.toMatchObject({ graphAvailable: true });
    await expect(openProjectKnowledgeGraphDashboard(repositoryId)).resolves.toMatchObject({ dashboardUrl: expect.stringContaining("/snapshot/") });
    await expect(approveTaskPrd(tasks[1]?.id ?? "")).resolves.toMatchObject({ status: "PRD_APPROVED" });
    await expect(saveRepositoryContextFile({
      repositoryId,
      kind: "rule",
      path: ".agent/rules/screenshot-recording.md",
      content: "# Screenshot Recording\n"
    })).resolves.toContainEqual(expect.objectContaining({ path: ".agent/rules/screenshot-recording.md" }));
    await expect(updateMemoryStatus({ id: memories[0]?.id ?? "", status: "approved" })).resolves.toMatchObject({ status: "approved" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("raises clear errors for failed task board fetches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));

    await expect(fetchTasks()).rejects.toThrow("Failed to load tasks");
    await expect(fetchRepositoryQueues()).rejects.toThrow("Failed to load repository queues");
    await expect(fetchProjectKnowledgeGraph("shop")).rejects.toThrow("Failed to load project knowledge graph");
    await expect(fetchRepositoryOnboarding("shop")).rejects.toThrow("Failed to load repository onboarding");
    await expect(fetchRepositoryContextFiles("shop")).rejects.toThrow("Failed to load repository context files");
    await expect(generateProjectKnowledgeGraph({ repositoryId: "shop" })).rejects.toThrow("Failed to generate project knowledge graph");
    await expect(openProjectKnowledgeGraphDashboard("shop")).rejects.toThrow("Failed to start the Understand-Anything dashboard");
    await expect(saveRepositoryContextFile({
      repositoryId: "shop",
      kind: "skill",
      path: ".agent/skills/new-skill/SKILL.md",
      content: "# Skill\n"
    })).rejects.toThrow("Failed to save repository context file");
    await expect(fetchTrace("task-1")).rejects.toThrow("Failed to load task trace");
    await expect(fetchMemories("proposed")).rejects.toThrow("Failed to load memories");
    await expect(updateMemoryStatus({ id: "memory-1", status: "rejected" })).rejects.toThrow("Failed to update memory");
  });
});

function ok(body: unknown): { ok: true; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: async () => body
  };
}

const timestamp = "2026-05-12T10:00:00.000Z";

const mockTasks: Task[] = [
  {
    id: "task-sample-128",
    issue: {
      provider: "github",
      owner: "sample",
      repo: "commerce",
      number: 128,
      url: "https://github.com/sample/commerce/issues/128",
      title: "Add project rule context to agent prompt",
      body: "",
      labels: ["frontend"],
      comments: [],
      baseBranch: "main"
    },
    status: "SUBAGENT_REVIEWING",
    branchName: "agent/issue-128-project-rule-context",
    prUrl: "https://github.com/sample/commerce/pull/129",
    createdAt: timestamp,
    updatedAt: timestamp
  },
  {
    id: "task-sample-129",
    issue: {
      provider: "github",
      owner: "sample",
      repo: "commerce",
      number: 129,
      url: "https://github.com/sample/commerce/issues/129",
      title: "Refresh repository settings summary after save",
      body: "",
      labels: ["backend"],
      comments: [],
      baseBranch: "main"
    },
    status: "QUEUED",
    branchName: "agent/issue-129-refresh-settings-summary",
    createdAt: timestamp,
    updatedAt: timestamp
  },
  {
    id: "task-sample-42",
    issue: {
      provider: "github",
      owner: "sample",
      repo: "billing",
      number: 42,
      url: "https://github.com/sample/billing/issues/42",
      title: "Tighten invoice export validation",
      body: "",
      labels: ["fullstack"],
      comments: [],
      baseBranch: "main"
    },
    status: "PRD_REVIEW_REQUIRED",
    branchName: "agent/issue-42-tighten-invoice-export-validation",
    createdAt: timestamp,
    updatedAt: timestamp
  }
];

const mockMemories: MemoryRecord[] = [
  {
    id: "memory-sample-procedure",
    kind: "procedural",
    status: "proposed",
    scope: "repository",
    owner: "sample",
    repo: "commerce",
    title: "Verification recipe from #128",
    content: "Use pnpm lint, pnpm typecheck, pnpm test and a focused UI screenshot before opening similar frontend PRs.",
    tags: ["verification", "frontend", "quality-gates"],
    confidence: 0.82,
    sourceTaskId: "task-sample-128",
    createdAt: timestamp,
    updatedAt: timestamp
  }
];

function mockTrace(task: Task): TaskTrace {
  const now = new Date().toISOString();
  const span = (kind: TraceSpanKind, name: string, message: string, status: TraceSpan["status"] = "success"): TraceSpan => ({
    id: `sample-${kind}-${name}`,
    taskId: task.id,
    name,
    kind,
    status,
    level: status === "failed" || status === "blocked" ? "warn" : "info",
    message,
    startedAt: now,
    endedAt: now,
    durationMs: 0
  });

  const spans = [
    span("workflow", "Issue received", "Task created from GitHub issue"),
    span("navigation", "Navigation route", "Repo graph selected entrypoints and related tests"),
    span("memory", "Memory retrieved", "Approved procedural memory injected into ContextPack"),
    span("model", "Implementation updated", "OpenCode executor updated the sandbox worktree"),
    span("quality_gate", "Quality gates", "lint, typecheck and tests passed")
  ];

  return {
    taskId: task.id,
    status: task.status,
    issueUrl: task.issue.url,
    prUrl: task.prUrl,
    spans,
    artifacts: [],
    summary: {
      totalSpans: spans.length,
      failedOrBlocked: 0
    }
  };
}
