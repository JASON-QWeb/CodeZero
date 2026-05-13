import { Queue } from "bullmq";
import IORedis from "ioredis";
import { loadAppConfig, type AppConfig } from "@agent/config";
import { createTask, makeIssueBranchName, transitionTask } from "@agent/orchestrator";
import { createRepository, createTaskEvent, type TaskRepository } from "@agent/persistence";
import type { IssueContext, Task } from "@agent/shared";

export type IssueWorkflowJob = {
  taskId: string;
};

export type ApiServices = {
  config: AppConfig;
  tasks: TaskRepository;
};

let servicesPromise: Promise<ApiServices> | undefined;

export async function getServices(): Promise<ApiServices> {
  servicesPromise ??= createServices();
  return servicesPromise;
}

export function resetServicesForTests(): void {
  servicesPromise = undefined;
}

export async function createAndEnqueueTask(issue: IssueContext): Promise<Task> {
  const services = await getServices();
  const task = {
    ...createTask(issue),
    branchName: makeIssueBranchName(issue)
  };
  const created = await services.tasks.createTask(task);

  await services.tasks.appendEvent(
    createTaskEvent({
      taskId: created.id,
      type: "TASK_CREATED",
      message: `Task created for ${issue.owner}/${issue.repo}#${issue.number}`
    })
  );

  try {
    await enqueueIssueWorkflow(created.id);
    await services.tasks.appendEvent(
      createTaskEvent({
        taskId: created.id,
        type: "TASK_QUEUED",
        message: "Workflow queued"
      })
    );
  } catch (error) {
    const blocked = transitionTask(created, "BLOCKED");
    await services.tasks.updateTask(created.id, { status: blocked.status, updatedAt: blocked.updatedAt });
    await services.tasks.appendEvent(
      createTaskEvent({
        taskId: created.id,
        type: "TASK_BLOCKED",
        level: "warn",
        message: `Task created but workflow queue is unavailable: ${error instanceof Error ? error.message : String(error)}`
      })
    );
  }

  return created;
}

async function createServices(): Promise<ApiServices> {
  const config = await loadAppConfig();
  const tasks = await createRepository(config.storage);

  return { config, tasks };
}

export async function enqueueIssueWorkflow(taskId: string, jobId = taskId): Promise<void> {
  const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableOfflineQueue: false
  });
  connection.on("error", () => undefined);
  const queue = new Queue<IssueWorkflowJob>("issue-workflows", { connection });

  try {
    await queue.add("run-issue-workflow", { taskId }, { jobId });
  } finally {
    await queue.close().catch(() => undefined);
    connection.disconnect();
  }
}
