import { FileTaskRepository } from "./file-task-repository.js";
import { PostgresTaskRepository } from "./postgres-task-repository.js";
import type { TaskRepository } from "./types.js";

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
