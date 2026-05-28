import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask } from "@agent/orchestrator";
import { createRepository, createTaskEvent, FileTaskRepository } from "@agent/persistence";
import type { IssueContext, Task } from "@agent/shared";

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

  it("keeps duplicate creates idempotent and persists artifacts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-store-"));
    const repository = new FileTaskRepository(path.join(dir, "tasks.json"));
    const task = createTask(issue);
    const first = await repository.createTask(task);
    const second = await repository.createTask({ ...task, status: "FAILED" });

    await repository.addArtifact({
      id: "artifact-1",
      taskId: first.id,
      type: "context-pack",
      path: "/tmp/context-pack.json",
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    expect(second.status).toBe(first.status);
    expect(await repository.listArtifacts(first.id)).toEqual([
      expect.objectContaining({ id: "artifact-1", type: "context-pack" })
    ]);
  });

  it("returns tasks and events in stable chronological order", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-store-"));
    const repository = new FileTaskRepository(path.join(dir, "tasks.json"));
    const older = taskWithCreatedAt("task-older", "2026-01-01T00:00:00.000Z");
    const newer = taskWithCreatedAt("task-newer", "2026-01-02T00:00:00.000Z");

    await repository.createTask(older);
    await repository.createTask(newer);
    await repository.appendEvent({
      id: "event-2",
      taskId: older.id,
      type: "TASK_CREATED",
      level: "info",
      message: "second",
      createdAt: "2026-01-01T00:00:02.000Z"
    });
    await repository.appendEvent({
      id: "event-1",
      taskId: older.id,
      type: "TASK_CREATED",
      level: "info",
      message: "first",
      createdAt: "2026-01-01T00:00:01.000Z"
    });

    expect((await repository.listTasks()).map((task) => task.id)).toEqual(["task-newer", "task-older"]);
    expect((await repository.listEvents(older.id)).map((event) => event.id)).toEqual(["event-1", "event-2"]);
  });

  it("serializes concurrent mutations without corrupting the store file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-store-concurrent-"));
    const storePath = path.join(dir, "tasks.json");
    const repository = new FileTaskRepository(storePath);
    const task = await repository.createTask(createTask(issue));

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        repository.appendEvent(
          createTaskEvent({
            taskId: task.id,
            type: "AGENT_RUN_PROGRESS",
            message: `progress ${index}`
          })
        )
      )
    );

    const parsed = JSON.parse(await readFile(storePath, "utf8")) as {
      events: unknown[];
    };
    expect(parsed.events).toHaveLength(40);
  });

  it("creates task events with default level and metadata", () => {
    const event = createTaskEvent({
      taskId: "task-1",
      type: "TASK_CREATED",
      message: "created",
      metadata: { source: "test" }
    });

    expect(event.id).toMatch(/^event-/);
    expect(event.level).toBe("info");
    expect(event.metadata).toEqual({ source: "test" });
  });

  it("throws clear errors for missing task updates and creates file repositories from config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-store-"));
    const repository = await createRepository({ driver: "file", filePath: path.join(dir, "tasks.json") });

    await expect(repository.updateTask("missing", { status: "FAILED" })).rejects.toThrow("Task not found: missing");
    await expect(createRepository({ driver: "postgres", filePath: "unused" })).rejects.toThrow("DATABASE_URL is required for postgres storage");
  });
});

function taskWithCreatedAt(id: string, createdAt: string): Task {
  return {
    ...createTask(issue),
    id,
    createdAt,
    updatedAt: createdAt
  };
}
