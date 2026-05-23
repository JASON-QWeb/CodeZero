import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { resetServicesForTests } from "../apps/api/src/services/task-services.js";
import { createTask, shouldDeferForRepositoryConcurrency } from "@agent/orchestrator";
import { FileTaskRepository } from "@agent/persistence";
import type { IssueContext, Task } from "@agent/shared";

describe("repository issue queue", () => {
  afterEach(() => {
    delete process.env.PROJECT_ROOT;
    delete process.env.TASK_STORE_FILE;
    resetServicesForTests();
  });

  it("defers queued work when a repository is already at its concurrency limit", () => {
    const repository = {
      id: "shop",
      github_owner: "acme",
      github_repo: "shop",
      queue: {
        max_concurrent_issues: 1
      }
    };
    const running = task(1, "IMPLEMENTING", "acme", "shop");
    const queued = task(2, "QUEUED", "acme", "shop");

    const decision = shouldDeferForRepositoryConcurrency([running, queued], queued, repository);

    expect(decision.shouldDefer).toBe(true);
    expect(decision.runningCount).toBe(1);
    expect(decision.queuedCount).toBe(1);
    expect(decision.maxConcurrentIssues).toBe(1);
  });

  it("groups tasks by repository with queue and capacity counters", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-repo-queue-"));
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    await writeConfigFixture(dir);
    process.env.PROJECT_ROOT = dir;
    process.env.TASK_STORE_FILE = storePath;

    await repository.createTask(task(1, "IMPLEMENTING", "your-org", "your-repo"));
    await repository.createTask(task(2, "QUEUED", "your-org", "your-repo"));
    await repository.createTask(task(3, "PRD_REVIEW_REQUIRED", "your-org", "your-repo"));
    await repository.createTask(task(4, "FAILED", "your-org", "your-repo"));

    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/tasks/repositories" });
    const summary = response.json<{ repositories: Array<{ fullName: string; maxConcurrentIssues: number; runningCount: number; queuedCount: number; reviewCount: number; blockedCount: number }> }>().repositories.find((entry) => entry.fullName === "your-org/your-repo");

    expect(response.statusCode).toBe(200);
    expect(summary).toMatchObject({
      maxConcurrentIssues: 2,
      runningCount: 1,
      queuedCount: 1,
      reviewCount: 1,
      blockedCount: 1
    });

    await app.close();
  });
});

function task(number: number, status: Task["status"], owner: string, repo: string): Task {
  return {
    ...createTask(issue(number, owner, repo), new Date(`2026-05-12T00:0${number}:00.000Z`)),
    status
  };
}

async function writeConfigFixture(rootDir: string): Promise<void> {
  const configDir = path.join(rootDir, "config");
  await mkdir(configDir, { recursive: true });
  await Promise.all(
    ["agents", "repositories", "sandbox", "policies", "tools"].map((section) =>
      copyFile(path.join(process.cwd(), "config", `${section}.example.yaml`), path.join(configDir, `${section}.example.yaml`))
    )
  );
}

function issue(number: number, owner: string, repo: string): IssueContext {
  return {
    provider: "github",
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/issues/${number}`,
    title: `Issue ${number}`,
    body: "",
    labels: [],
    comments: [],
    baseBranch: "main"
  };
}
