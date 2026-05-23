import { Pool } from "pg";
import type { Artifact, Task, TaskEvent } from "@agent/shared";
import type { TaskPatch, TaskRepository } from "./types.js";

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

    await this.pool.query(`update tasks set status = $2, payload = $3, updated_at = $4 where id = $1`, [id, next.status, next, next.updatedAt]);
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
