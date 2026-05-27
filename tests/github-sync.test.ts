import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTask } from "@agent/orchestrator";
import { FileTaskRepository } from "@agent/persistence";
import type { IssueContext, Task } from "@agent/shared";
import {
  GitHubSyncRunError,
  resetGitHubSyncStateForTests,
  runGitHubRepositorySync,
  type GitHubSyncClient
} from "../apps/api/src/services/github-sync.js";
import { getServices, resetServicesForTests } from "../apps/api/src/services/task-services.js";

describe("GitHub async sync", () => {
  afterEach(() => {
    delete process.env.PROJECT_ROOT;
    delete process.env.TASK_STORE_FILE;
    resetServicesForTests();
    resetGitHubSyncStateForTests();
  });

  it("imports open issues when a configured trigger comment is present and skips duplicates", async () => {
    const dir = await createConfigFixture("agent-github-sync-");
    process.env.PROJECT_ROOT = dir;
    process.env.TASK_STORE_FILE = path.join(dir, "tasks.json");
    const github = fakeGitHub({
      issueThreads: [
        {
          ...issue(21, "Async sync"),
          author: "alice",
          updatedAt: "2026-05-27T01:00:00Z",
          isPullRequest: false,
          comments: [{ author: "alice", body: "@agent-prd please handle this", createdAt: "2026-05-27T01:01:00Z" }]
        },
        {
          ...issue(22, "No trigger"),
          author: "bob",
          updatedAt: "2026-05-27T01:02:00Z",
          isPullRequest: false,
          comments: [{ author: "bob", body: "just a note", createdAt: "2026-05-27T01:03:00Z" }]
        }
      ]
    });

    const first = await runGitHubRepositorySync("example-web", { github, enqueue: async () => undefined });
    const second = await runGitHubRepositorySync("example-web", { github, enqueue: async () => undefined });
    const services = await getServices();
    const tasks = await services.tasks.listTasks();

    expect(first).toMatchObject({ scannedIssues: 2, importedIssues: 1, skippedIssues: 1 });
    expect(second).toMatchObject({ scannedIssues: 2, importedIssues: 0, skippedIssues: 2 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.issue.number).toBe(21);
  });

  it("imports new human PR comments and requeues the tracked task", async () => {
    const dir = await createConfigFixture("agent-github-pr-sync-");
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    const task = {
      ...createTask(issue(31, "Review feedback"), new Date("2026-05-27T02:00:00Z")),
      status: "HUMAN_REVIEW",
      prUrl: "https://github.com/your-org/your-repo/pull/9"
    } satisfies Task;
    await repository.createTask(task);
    process.env.PROJECT_ROOT = dir;
    process.env.TASK_STORE_FILE = storePath;
    const enqueue = vi.fn(async () => undefined);
    const github = fakeGitHub({
      issueThreads: [],
      comments: [
        {
          id: "review_comment-1001",
          source: "review_comment",
          author: "alice",
          body: "Inline review on frontend/src/App.tsx:42\n\n这里需要继续调整一下",
          createdAt: "2026-05-27T02:05:00Z",
          url: "https://github.com/your-org/your-repo/pull/9#issuecomment-1001"
        }
      ]
    });

    const result = await runGitHubRepositorySync("example-web", { github, enqueue });
    const updated = await repository.getTask(task.id);

    expect(result).toMatchObject({
      scannedFeedbackPullRequests: 1,
      importedFeedbackComments: 1,
      queuedFeedbackTasks: 1
    });
    expect(enqueue).toHaveBeenCalledWith(task.id, `${task.id}-pr-sync-review_comment-1001`);
    expect(updated?.issue.comments[0]?.body).toContain("继续调整");
  });

  it("marks sync failed when imported PR feedback cannot be queued", async () => {
    const dir = await createConfigFixture("agent-github-pr-sync-fail-");
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    const task = {
      ...createTask(issue(32, "Review feedback"), new Date("2026-05-27T02:00:00Z")),
      status: "HUMAN_REVIEW",
      prUrl: "https://github.com/your-org/your-repo/pull/10"
    } satisfies Task;
    await repository.createTask(task);
    process.env.PROJECT_ROOT = dir;
    process.env.TASK_STORE_FILE = storePath;
    const github = fakeGitHub({
      issueThreads: [],
      comments: [
        {
          id: "review-2001",
          source: "review",
          author: "alice",
          body: "Pull request review (CHANGES_REQUESTED)\n\n继续改",
          createdAt: "2026-05-27T02:05:00Z",
          url: "https://github.com/your-org/your-repo/pull/10#pullrequestreview-2001"
        }
      ]
    });

    await expect(runGitHubRepositorySync("example-web", { github, enqueue: async () => Promise.reject(new Error("redis down")) })).rejects.toThrow(
      GitHubSyncRunError
    );
    const updated = await repository.getTask(task.id);

    expect(updated?.status).toBe("BLOCKED");
    expect(updated?.issue.comments[0]?.body).toContain("继续改");
  });
});

async function createConfigFixture(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const configDir = path.join(dir, "config");
  await mkdir(configDir, { recursive: true });
  await Promise.all(
    ["agents", "repositories", "sandbox", "policies", "tools"].map((section) =>
      copyFile(path.join(process.cwd(), "config", `${section}.example.yaml`), path.join(configDir, `${section}.example.yaml`))
    )
  );
  return dir;
}

function fakeGitHub(input: {
  issueThreads: Awaited<ReturnType<GitHubSyncClient["listOpenIssueThreads"]>>;
  comments?: Awaited<ReturnType<GitHubSyncClient["listPullRequestFeedback"]>>;
}): GitHubSyncClient {
  return {
    listOpenIssueThreads: vi.fn(async () => input.issueThreads),
    listPullRequestFeedback: vi.fn(async () => input.comments ?? [])
  };
}

function issue(number: number, title: string): IssueContext {
  return {
    provider: "github",
    owner: "your-org",
    repo: "your-repo",
    number,
    url: `https://github.com/your-org/your-repo/issues/${number}`,
    title,
    body: "",
    labels: [],
    comments: [],
    baseBranch: "main"
  };
}
