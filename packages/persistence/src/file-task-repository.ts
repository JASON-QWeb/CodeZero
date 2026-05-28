import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  private static readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async createTask(task: Task): Promise<Task> {
    return this.mutate((store) => {
      const existing = store.tasks.find((entry) => entry.id === task.id);

      if (existing) {
        return existing;
      }

      store.tasks.push(task);
      return task;
    });
  }

  async updateTask(id: string, patch: TaskPatch): Promise<Task> {
    return this.mutate((store) => {
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
      return next;
    });
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
    await this.mutate((store) => {
      store.events.push(event);
    });
  }

  async listEvents(taskId: string): Promise<TaskEvent[]> {
    const store = await this.read();
    return store.events.filter((event) => event.taskId === taskId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async addArtifact(artifact: Artifact): Promise<void> {
    await this.mutate((store) => {
      store.artifacts.push(artifact);
    });
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

  private async mutate<T>(operation: (store: StoreFile) => T | Promise<T>): Promise<T> {
    const previous = FileTaskRepository.mutationQueues.get(this.filePath) ?? Promise.resolve();
    const mutation = previous.catch(() => undefined).then(async () => {
      const store = await this.read();
      const result = await operation(store);
      await this.write(store);
      return result;
    });

    FileTaskRepository.mutationQueues.set(
      this.filePath,
      mutation.then(
        () => undefined,
        () => undefined
      )
    );

    return mutation;
  }

  private async write(store: StoreFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;

    try {
      await writeFile(tempPath, JSON.stringify(store, null, 2));
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
