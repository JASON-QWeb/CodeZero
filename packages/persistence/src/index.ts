import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { Artifact, JsonObject, Task, TaskEvent, TaskEventType, TaskStatus } from "@agent/shared";

export type TaskPatch = Partial<Omit<Task, "id" | "createdAt">> & {
  status?: TaskStatus;
};

export type TaskRepository = {
  createTask(task: Task): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  getTask(id: string): Promise<Task | undefined>;
  listTasks(): Promise<Task[]>;
  appendEvent(event: TaskEvent): Promise<void>;
  listEvents(taskId: string): Promise<TaskEvent[]>;
  addArtifact(artifact: Artifact): Promise<void>;
  listArtifacts(taskId: string): Promise<Artifact[]>;
};

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

export class PostgresTaskRepository implements TaskRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      create table if not exists tasks (
        id text primary key,
        status text not null,
        payload jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );

      create table if not exists task_events (
        id text primary key,
        task_id text not null references tasks(id) on delete cascade,
        type text not null,
        level text not null,
        message text not null,
        metadata jsonb,
        created_at timestamptz not null
      );

      create table if not exists artifacts (
        id text primary key,
        task_id text not null references tasks(id) on delete cascade,
        type text not null,
        path text,
        url text,
        metadata jsonb,
        created_at timestamptz not null
      );
    `);
  }

  async createTask(task: Task): Promise<Task> {
    await this.migrate();
    await this.pool.query(
      `insert into tasks (id, status, payload, created_at, updated_at)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do nothing`,
      [task.id, task.status, task, task.createdAt, task.updatedAt]
    );
    return (await this.getTask(task.id)) ?? task;
  }

  async updateTask(id: string, patch: TaskPatch): Promise<Task> {
    const current = await this.getTask(id);

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

    await this.pool.query(`update tasks set status = $2, payload = $3, updated_at = $4 where id = $1`, [
      id,
      next.status,
      next,
      next.updatedAt
    ]);
    return next;
  }

  async getTask(id: string): Promise<Task | undefined> {
    await this.migrate();
    const result = await this.pool.query<{ payload: Task }>(`select payload from tasks where id = $1`, [id]);
    return result.rows[0]?.payload;
  }

  async listTasks(): Promise<Task[]> {
    await this.migrate();
    const result = await this.pool.query<{ payload: Task }>(`select payload from tasks order by created_at desc`);
    return result.rows.map((row) => row.payload);
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    await this.migrate();
    await this.pool.query(
      `insert into task_events (id, task_id, type, level, message, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [event.id, event.taskId, event.type, event.level, event.message, event.metadata ?? null, event.createdAt]
    );
  }

  async listEvents(taskId: string): Promise<TaskEvent[]> {
    await this.migrate();
    const result = await this.pool.query<TaskEvent>(
      `select id, task_id as "taskId", type, level, message, metadata, created_at as "createdAt"
       from task_events where task_id = $1 order by created_at asc`,
      [taskId]
    );
    return result.rows;
  }

  async addArtifact(artifact: Artifact): Promise<void> {
    await this.migrate();
    await this.pool.query(
      `insert into artifacts (id, task_id, type, path, url, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [artifact.id, artifact.taskId, artifact.type, artifact.path ?? null, artifact.url ?? null, artifact.metadata ?? null, artifact.createdAt]
    );
  }

  async listArtifacts(taskId: string): Promise<Artifact[]> {
    await this.migrate();
    const result = await this.pool.query<Artifact>(
      `select id, task_id as "taskId", type, path, url, metadata, created_at as "createdAt"
       from artifacts where task_id = $1 order by created_at asc`,
      [taskId]
    );
    return result.rows;
  }
}

export function createTaskEvent(input: {
  taskId: string;
  type: TaskEventType;
  message: string;
  level?: TaskEvent["level"];
  metadata?: JsonObject;
}): TaskEvent {
  return {
    id: `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    taskId: input.taskId,
    type: input.type,
    level: input.level ?? "info",
    message: input.message,
    metadata: input.metadata,
    createdAt: new Date().toISOString()
  };
}

export async function createRepository(input: { driver: "file" | "postgres"; filePath: string; databaseUrl?: string }): Promise<TaskRepository> {
  if (input.driver === "postgres") {
    if (!input.databaseUrl) {
      throw new Error("DATABASE_URL is required for postgres storage");
    }
    const repository = new PostgresTaskRepository(input.databaseUrl);
    await repository.migrate();
    return repository;
  }

  return new FileTaskRepository(input.filePath);
}
