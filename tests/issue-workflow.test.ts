import { describe, expect, it, vi } from "vitest";
import { createTask } from "@agent/orchestrator";
import type { AppConfig, RepositoryConfig } from "@agent/config";
import type { TaskRepository } from "@agent/persistence";
import type { IssueContext, Task } from "@agent/shared";
import { runIssueWorkflow } from "../apps/worker/src/workflows/issue-workflow.js";

const issue: IssueContext = {
  provider: "github",
  owner: "acme",
  repo: "shop",
  number: 42,
  url: "https://github.com/acme/shop/issues/42",
  title: "Fix refund copy",
  body: "",
  labels: [],
  comments: [],
  baseBranch: "main"
};

describe("worker issue workflow", () => {
  it("throws when the task cannot be found", async () => {
    await expect(runIssueWorkflow({ taskId: "missing" }, dependencies({ task: null }))).rejects.toThrow("Task not found: missing");
  });

  it("runs immediately for unconfigured repositories", async () => {
    const runner = vi.fn().mockResolvedValue({ taskId: "task-acme-shop-42", status: "HUMAN_REVIEW" });
    const result = await runIssueWorkflow(
      { taskId: "task-acme-shop-42" },
      dependencies({
        repositories: [],
        runner
      })
    );

    expect(result.status).toBe("HUMAN_REVIEW");
    expect(runner).toHaveBeenCalledWith("task-acme-shop-42");
  });

  it("defers queued work when repository concurrency is full", async () => {
    const task = createTask(issue);
    const active = { ...createTask({ ...issue, number: 43 }), status: "IMPLEMENTING" as const };
    const tasks = createTaskRepository(task, [task, active]);
    const result = await runIssueWorkflow(
      { taskId: task.id },
      dependencies({
        task,
        tasks,
        repositoryQueueRetryMs: "2500"
      })
    );

    expect(result).toMatchObject({ taskId: task.id, status: "QUEUED", deferred: true, retryDelayMs: 2500 });
    expect(tasks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "TASK_QUEUED" }));
  });

  it("skips duplicate jobs for a task that is already running", async () => {
    const task = { ...createTask(issue), status: "IMPLEMENTING" as const };
    const runner = vi.fn();
    const tasks = createTaskRepository(task);
    const result = await runIssueWorkflow(
      { taskId: task.id },
      dependencies({
        task,
        tasks,
        runner
      })
    );

    expect(result).toMatchObject({ taskId: task.id, status: "IMPLEMENTING", skipped: true });
    expect(runner).not.toHaveBeenCalled();
    expect(tasks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "TASK_QUEUED" }));
  });

  it("runs configured repository work when capacity is available", async () => {
    const runner = vi.fn().mockResolvedValue({ taskId: "task-acme-shop-42", status: "HUMAN_REVIEW", prUrl: "https://example.test/pr" });
    const result = await runIssueWorkflow(
      { taskId: "task-acme-shop-42" },
      dependencies({
        runner
      })
    );

    expect(result.prUrl).toBe("https://example.test/pr");
  });
});

function dependencies(input: {
  task?: Task | null;
  tasks?: TaskRepository;
  repositories?: RepositoryConfig[];
  runner?: (taskId: string) => Promise<{ taskId: string; status: string; prUrl?: string }>;
  repositoryQueueRetryMs?: string;
} = {}) {
  const task = input.task === null ? undefined : input.task ?? createTask(issue);
  const tasks = input.tasks ?? createTaskRepository(task);
  const repositories = input.repositories ?? [repositoryConfig()];

  return {
    loadConfig: async () => appConfig(repositories),
    createTaskRepository: async () => tasks,
    createRunner: () => ({ run: input.runner ?? vi.fn().mockResolvedValue({ taskId: task?.id ?? "missing", status: "DONE" }) }),
    repositoryQueueRetryMs: input.repositoryQueueRetryMs
  };
}

function createTaskRepository(task?: Task, listedTasks: Task[] = task ? [task] : []): TaskRepository {
  return {
    createTask: vi.fn(),
    updateTask: vi.fn(),
    getTask: vi.fn().mockResolvedValue(task),
    listTasks: vi.fn().mockResolvedValue(listedTasks),
    appendEvent: vi.fn(),
    listEvents: vi.fn(),
    addArtifact: vi.fn(),
    listArtifacts: vi.fn()
  };
}

function repositoryConfig(): RepositoryConfig {
  return {
    id: "shop",
    github_owner: "acme",
    github_repo: "shop",
    default_branch: "main",
    project_skill_path: ".agent",
    trigger: {
      mode: "mention",
      mention: "@agent-prd",
      auto_events: [],
      label_allowlist: [],
      label_blocklist: [],
      actor_allowlist: []
    },
    codebase_intelligence: {
      codegraph: {
        enabled: true,
        package: "@colbymchenry/codegraph@0.9.3",
        init_args: ["--index"],
        timeout_ms: 600_000,
        fail_on_error: true
      },
      navigation_graph: {
        enabled: true,
        include_git_history: true,
        include_codeowners: true,
        max_depth: 4
      }
    },
    queue: { max_concurrent_issues: 1 },
    permissions: {
      allowed_tools: [],
      blocked_tools: [],
      allowed_permissions: [],
      blocked_permissions: []
    },
    quality_gates: {},
    frontend: { screenshot_urls: [] },
    pr: { default_draft: true }
  };
}

function appConfig(repositories: RepositoryConfig[]): AppConfig {
  return {
    rootDir: process.cwd(),
    agents: { providers: {}, agents: {} },
    repositories,
    sandbox: {
      mode: "worktree",
      image: "agent-sandbox-node:test",
      root_dir: "./sandboxes",
      network: { allow: [] },
      limits: {
        max_runtime_minutes: 10,
        max_diff_files: 30,
        max_diff_lines: 1200,
        max_quality_gate_retries: 3
      }
    },
    policies: [],
    tools: [],
    storage: { driver: "file", filePath: "/tmp/tasks.json" },
    memory: { filePath: "/tmp/memory.json" },
    github: {}
  };
}
