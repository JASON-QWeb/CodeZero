import type { Artifact, Task, TaskEvent, TaskStatus } from "@agent/shared";

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
