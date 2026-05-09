import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask } from "@agent/orchestrator";
import { createTaskEvent, FileTaskRepository } from "@agent/persistence";
import type { IssueContext } from "@agent/shared";

const issue: IssueContext = {
  provider: "github",
  owner: "acme",
  repo: "shop",
  number: 77,
  url: "https://github.com/acme/shop/issues/77",
  title: "Add order audit note",
  body: "",
  labels: [],
  comments: [],
  baseBranch: "main"
};

describe("file task repository", () => {
  it("persists tasks and events", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-store-"));
    const repository = new FileTaskRepository(path.join(dir, "tasks.json"));
    const task = await repository.createTask(createTask(issue));
    await repository.updateTask(task.id, { status: "CONTEXT_COLLECTING" });
    await repository.appendEvent(createTaskEvent({ taskId: task.id, type: "TASK_CREATED", message: "created" }));

    const reloaded = new FileTaskRepository(path.join(dir, "tasks.json"));
    expect((await reloaded.getTask(task.id))?.status).toBe("CONTEXT_COLLECTING");
    expect(await reloaded.listEvents(task.id)).toHaveLength(1);
  });
});

