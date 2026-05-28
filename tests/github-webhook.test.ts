import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTask } from "@agent/orchestrator";
import { FileTaskRepository } from "@agent/persistence";
import { buildServer } from "../apps/api/src/server.js";
import { resetServicesForTests } from "../apps/api/src/services/task-services.js";

describe("GitHub webhook routes", () => {
  afterEach(() => {
    delete process.env.PROJECT_ROOT;
    delete process.env.TASK_STORE_FILE;
    resetServicesForTests();
  });

  it("marks a tracked task done when its PR is merged", async () => {
    const dir = await createConfigFixture("agent-github-webhook-");
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    const task = {
      ...createTask({
        provider: "github",
        owner: "your-org",
        repo: "your-repo",
        number: 42,
        url: "https://github.com/your-org/your-repo/issues/42",
        title: "Ship webhook completion",
        body: "",
        labels: [],
        comments: [],
        baseBranch: "main"
      }),
      status: "WAITING_MERGE" as const,
      branchName: "agent/issue-42-ship-webhook-completion",
      prUrl: "https://github.com/your-org/your-repo/pull/9"
    };
    await repository.createTask(task);
    process.env.PROJECT_ROOT = dir;
    process.env.TASK_STORE_FILE = storePath;
    const app = await buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "pull_request" },
      payload: {
        action: "closed",
        number: 9,
        pull_request: {
          number: 9,
          html_url: "https://github.com/your-org/your-repo/pull/9",
          merged: true,
          merged_at: "2026-05-28T10:00:00Z",
          merge_commit_sha: "abc123",
          head: { ref: "agent/issue-42-ship-webhook-completion" }
        },
        repository: {
          name: "your-repo",
          owner: { login: "your-org" },
          default_branch: "main"
        }
      }
    });
    const updated = await repository.getTask(task.id);
    const events = await repository.listEvents(task.id);

    expect(response.statusCode).toBe(202);
    expect(updated?.status).toBe("DONE");
    expect(events).toContainEqual(expect.objectContaining({ type: "TASK_COMPLETED" }));

    await app.close();
  });
});

async function createConfigFixture(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const configDir = path.join(dir, "config");
  await mkdir(configDir, { recursive: true });
  await Promise.all([
    copyFile(path.join(process.cwd(), "config", "codezero.example.yaml"), path.join(configDir, "codezero.yaml")),
    copyFile(path.join(process.cwd(), "config", "codezero.example.yaml"), path.join(configDir, "codezero.example.yaml"))
  ]);
  return dir;
}
