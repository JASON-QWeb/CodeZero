import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Artifact, Task, TaskEvent } from "@agent/shared";
import type { TaskPatch, TaskRepository } from "./types.js";

type StoreFile = {
  tasks: Task[];
  events: TaskEvent[];
  artifacts: Artifact[];
};

function emptyStore(): StoreFile {
  return { tasks: [], events: [], artifacts: [] };
}

export class FileTaskRepository implements TaskRepository {
  constructor(private readonly filePath: string) {}

  async createTask(task: Task): Promise<Task> {
    const store = await this.read();
    const existing = store.tasks.find((entry) => entry.id === task.id);

    if (existing) {
      return existing;
    }

    store.tasks.push(task);
    await this.write(store);
    return task;
  }

  async updateTask(id: string, patch: TaskPatch): Promise<Task> {
    const store = await this.read();
    const index = store.tasks.findIndex((task) => task.id === id);

    if (index < 0) {
      throw new Error(`Task not found: ${id}`);
    }

    const current = store.tasks[index];
    if (!current) {
      throw new Error(`Task not found: ${id}`);
    }
    const next: Task = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      issue: patch.issue ?? current.issue,
      updatedAt: new Date().toISOString()
    };

    store.tasks[index] = next;
    await this.write(store);
    return next;
  }

  async getTask(id: string): Promise<Task | undefined> {
    const store = await this.read();
    return store.tasks.find((task) => task.id === id);
  }

  async listTasks(): Promise<Task[]> {
    const store = await this.read();
    return store.tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    const store = await this.read();
    store.events.push(event);
    await this.write(store);
  }

  async listEvents(taskId: string): Promise<TaskEvent[]> {
    const store = await this.read();
    return store.events.filter((event) => event.taskId === taskId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async addArtifact(artifact: Artifact): Promise<void> {
    const store = await this.read();
    store.artifacts.push(artifact);
    await this.write(store);
  }

  async listArtifacts(taskId: string): Promise<Artifact[]> {
    const store = await this.read();
    return store.artifacts.filter((artifact) => artifact.taskId === taskId);
  }

  private async read(): Promise<StoreFile> {
    const content = await readFile(this.filePath, "utf8").catch(() => "");

    if (!content) {
      return emptyStore();
    }

    return JSON.parse(content) as StoreFile;
  }

  private async write(store: StoreFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2));
    await rename(tempPath, this.filePath);
  }
}
