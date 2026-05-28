import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTask } from "@agent/orchestrator";
import { FileTaskRepository } from "@agent/persistence";
import type { IssueContext, PlanningDocument, Task } from "@agent/shared";
import {
  GitHubSyncRunError,
  resetGitHubSyncStateForTests,
  runGitHubRepositorySync,
  type GitHubSyncClient,
} from "../apps/api/src/services/github-sync.js";
import {
  getServices,
  resetServicesForTests,
} from "../apps/api/src/services/task-services.js";

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
          comments: [
            {
              author: "alice",
              body: "@agent-prd please handle this",
              createdAt: "2026-05-27T01:01:00Z",
            },
          ],
        },
        {
          ...issue(22, "No trigger"),
          author: "bob",
          updatedAt: "2026-05-27T01:02:00Z",
          isPullRequest: false,
          comments: [
            {
              author: "bob",
              body: "just a note",
              createdAt: "2026-05-27T01:03:00Z",
            },
          ],
        },
      ],
    });

    const first = await runGitHubRepositorySync("example-web", {
      github,
      enqueue: async () => undefined,
    });
    const second = await runGitHubRepositorySync("example-web", {
      github,
      enqueue: async () => undefined,
    });
    const services = await getServices();
    const tasks = await services.tasks.listTasks();

    expect(first).toMatchObject({
      scannedIssues: 2,
      importedIssues: 1,
      skippedIssues: 1,
    });
    expect(second).toMatchObject({
      scannedIssues: 2,
      importedIssues: 0,
      skippedIssues: 2,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.issue.number).toBe(21);
  });

  it("imports new human PR comments and requeues the tracked task", async () => {
    const dir = await createConfigFixture("agent-github-pr-sync-");
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    const task = {
      ...createTask(
        issue(31, "Review feedback"),
        new Date("2026-05-27T02:00:00Z"),
      ),
      status: "WAITING_MERGE",
      prUrl: "https://github.com/your-org/your-repo/pull/9",
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
          url: "https://github.com/your-org/your-repo/pull/9#issuecomment-1001",
        },
      ],
    });

    const result = await runGitHubRepositorySync("example-web", {
      github,
      enqueue,
    });
    const updated = await repository.getTask(task.id);

    expect(result).toMatchObject({
      scannedFeedbackPullRequests: 1,
      importedFeedbackComments: 1,
      queuedFeedbackTasks: 1,
    });
    expect(enqueue).toHaveBeenCalledWith(
      task.id,
      `${task.id}-pr-sync-review_comment-1001`,
    );
    expect(updated?.issue.comments[0]?.body).toContain("继续调整");
  });

  it("imports PRD approval issue comments and resumes the same task", async () => {
    const dir = await createConfigFixture("agent-github-prd-approval-");
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    const task = {
      ...createTask(issue(29, "Approve PRD"), new Date("2026-05-27T02:00:00Z")),
      status: "PRD_REVIEW_REQUIRED",
    } satisfies Task;
    await repository.createTask(task);
    process.env.PROJECT_ROOT = dir;
    process.env.TASK_STORE_FILE = storePath;
    const enqueue = vi.fn(async () => undefined);
    const github = fakeGitHub({
      issueThreads: [
        {
          ...issue(29, "Approve PRD"),
          author: "alice",
          updatedAt: "2026-05-27T02:10:00Z",
          isPullRequest: false,
          comments: [
            {
              author: "alice",
              body: "@agent-prd approve prd",
              createdAt: "2026-05-27T02:10:00Z",
            },
          ],
        },
      ],
    });

    const result = await runGitHubRepositorySync("example-web", {
      github,
      enqueue,
    });
    const updated = await repository.getTask(task.id);

    expect(result).toMatchObject({
      importedIssueComments: 1,
      queuedPrdApprovals: 1,
    });
    expect(updated?.status).toBe("PRD_APPROVED");
    expect(enqueue).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining(`${task.id}-prd-approved-`),
    );
  });

  it("requeues a failed tracked issue when a new trigger comment arrives", async () => {
    const dir = await createConfigFixture("agent-github-issue-retrigger-");
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    const task = {
      ...createTask(
        issue(30, "Retry failed issue"),
        new Date("2026-05-27T02:00:00Z"),
      ),
      status: "FAILED",
    } satisfies Task;
    await repository.createTask(task);
    process.env.PROJECT_ROOT = dir;
    process.env.TASK_STORE_FILE = storePath;
    const enqueue = vi.fn(async () => undefined);
    const github = fakeGitHub({
      issueThreads: [
        {
          ...issue(30, "Retry failed issue"),
          author: "alice",
          updatedAt: "2026-05-27T02:15:00Z",
          isPullRequest: false,
          comments: [
            {
              author: "alice",
              body: "@agent-prd 请重新处理",
              createdAt: "2026-05-27T02:15:00Z",
            },
          ],
        },
      ],
    });

    const result = await runGitHubRepositorySync("example-web", {
      github,
      enqueue,
    });
    const updated = await repository.getTask(task.id);

    expect(result).toMatchObject({
      importedIssueComments: 1,
      queuedIssueRetriggers: 1,
    });
    expect(updated?.status).toBe("QUEUED");
    expect(enqueue).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining(`${task.id}-issue-retrigger-`),
    );
  });

  it("resumes a failed approved issue from PRD_APPROVED when a new trigger comment arrives", async () => {
    const dir = await createConfigFixture(
      "agent-github-approved-issue-retrigger-",
    );
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    const task = {
      ...createTask(
        issue(34, "Retry approved failed issue"),
        new Date("2026-05-27T02:00:00Z"),
      ),
      status: "FAILED",
      planningDocument: highComplexityPlanningDocument,
    } satisfies Task;
    await repository.createTask(task);
    process.env.PROJECT_ROOT = dir;
    process.env.TASK_STORE_FILE = storePath;
    const enqueue = vi.fn(async () => undefined);
    const github = fakeGitHub({
      issueThreads: [
        {
          ...issue(34, "Retry approved failed issue"),
          author: "alice",
          updatedAt: "2026-05-27T02:25:00Z",
          isPullRequest: false,
          comments: [
            {
              author: "alice",
              body: "@agent-prd retry",
              createdAt: "2026-05-27T02:25:00Z",
            },
          ],
        },
      ],
    });

    const result = await runGitHubRepositorySync("example-web", {
      github,
      enqueue,
    });
    const updated = await repository.getTask(task.id);

    expect(result).toMatchObject({
      importedIssueComments: 1,
      queuedIssueRetriggers: 1,
    });
    expect(updated?.status).toBe("PRD_APPROVED");
    expect(enqueue).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining(`${task.id}-issue-retrigger-`),
    );
  });

  it("requeues an interrupted active issue only when the trigger comment asks for a retry", async () => {
    const dir = await createConfigFixture("agent-github-active-retrigger-");
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    const task = {
      ...createTask(
        issue(33, "Retry active issue"),
        new Date("2026-05-27T02:00:00Z"),
      ),
      status: "IMPLEMENTING",
      planningDocument: highComplexityPlanningDocument,
    } satisfies Task;
    await repository.createTask(task);
    process.env.PROJECT_ROOT = dir;
    process.env.TASK_STORE_FILE = storePath;
    const enqueue = vi.fn(async () => undefined);
    const github = fakeGitHub({
      issueThreads: [
        {
          ...issue(33, "Retry active issue"),
          author: "alice",
          updatedAt: "2026-05-27T02:20:00Z",
          isPullRequest: false,
          comments: [
            {
              author: "alice",
              body: "@agent-prd 请重新处理",
              createdAt: "2026-05-27T02:20:00Z",
            },
          ],
        },
      ],
    });

    const result = await runGitHubRepositorySync("example-web", {
      github,
      enqueue,
    });
    const updated = await repository.getTask(task.id);

    expect(result).toMatchObject({
      importedIssueComments: 1,
      queuedIssueRetriggers: 1,
    });
    expect(updated?.status).toBe("PRD_APPROVED");
    expect(enqueue).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining(`${task.id}-issue-retrigger-`),
    );
  });

  it("marks sync failed when imported PR feedback cannot be queued", async () => {
    const dir = await createConfigFixture("agent-github-pr-sync-fail-");
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    const task = {
      ...createTask(
        issue(32, "Review feedback"),
        new Date("2026-05-27T02:00:00Z"),
      ),
      status: "HUMAN_REVIEW",
      prUrl: "https://github.com/your-org/your-repo/pull/10",
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
          url: "https://github.com/your-org/your-repo/pull/10#pullrequestreview-2001",
        },
      ],
    });

    await expect(
      runGitHubRepositorySync("example-web", {
        github,
        enqueue: async () => Promise.reject(new Error("redis down")),
      }),
    ).rejects.toThrow(GitHubSyncRunError);
    const updated = await repository.getTask(task.id);

    expect(updated?.status).toBe("BLOCKED");
    expect(updated?.issue.comments[0]?.body).toContain("继续改");
  });
});

async function createConfigFixture(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const configDir = path.join(dir, "config");
  await mkdir(configDir, { recursive: true });
  await copyUnifiedConfigFixture(configDir);
  return dir;
}

async function copyUnifiedConfigFixture(configDir: string): Promise<void> {
  await Promise.all([
    copyFile(
      path.join(process.cwd(), "config", "codezero.example.yaml"),
      path.join(configDir, "codezero.yaml"),
    ),
    copyFile(
      path.join(process.cwd(), "config", "codezero.example.yaml"),
      path.join(configDir, "codezero.example.yaml"),
    ),
  ]);
}

function fakeGitHub(input: {
  issueThreads: Awaited<ReturnType<GitHubSyncClient["listOpenIssueThreads"]>>;
  comments?: Awaited<ReturnType<GitHubSyncClient["listPullRequestFeedback"]>>;
}): GitHubSyncClient {
  return {
    listOpenIssueThreads: vi.fn(async () => input.issueThreads),
    listPullRequestFeedback: vi.fn(async () => input.comments ?? []),
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
    baseBranch: "main",
  };
}

const highComplexityPrd = {
  title: "Retry active issue",
  background:
    "A previously approved issue was interrupted while implementation was running.",
  goals: ["Resume implementation from the approved PRD."],
  nonGoals: ["Change the PRD content."],
  userStories: ["As an operator, I can re-trigger an interrupted active run."],
  acceptanceCriteria: ["The same task is requeued from an approved PRD state."],
  risks: [
    "A duplicate active worker could run if retry comments are not explicit.",
  ],
  unknowns: [],
  taskType: "fullstack",
  complexity: {
    score: 6,
    requiresHumanReview: true,
    reasons: ["Cross-module change"],
  },
} satisfies Omit<PlanningDocument, "implementationPlan">;

const highComplexityPlanningDocument = {
  ...highComplexityPrd,
  implementationPlan: {
    goal: "Resume implementation from the approved PRD/Plan.",
    acceptanceCriteria: [
      "The same task is requeued from an approved planning state.",
    ],
    filesToRead: ["apps/api/src/services/github-sync.ts"],
    filesExpectedToChange: ["apps/api/src/services/github-sync.ts"],
    testsToAddOrUpdate: ["tests/github-sync.test.ts"],
    commandsToRun: ["pnpm test tests/github-sync.test.ts"],
    explicitNonGoals: [],
    riskNotes: ["Avoid creating duplicate active workers."],
  },
} satisfies PlanningDocument;
