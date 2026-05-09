import { Queue } from "bullmq";
import IORedis from "ioredis";
import { loadAppConfig, type AppConfig } from "@agent/config";
import { createTask, makeIssueBranchName } from "@agent/orchestrator";
import { createRepository, createTaskEvent, type TaskRepository } from "@agent/persistence";
import type { IssueContext, Task } from "@agent/shared";

export type IssueWorkflowJob = {
  taskId: string;
};

export type ApiServices = {
  config: AppConfig;
  tasks: TaskRepository;
  queue: Queue<IssueWorkflowJob>;
};

let servicesPromise: Promise<ApiServices> | undefined;

export async function getServices(): Promise<ApiServices> {
  servicesPromise ??= createServices();
  return servicesPromise;
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
    await services.queue.add("run-issue-workflow", { taskId: created.id }, { jobId: created.id });
    await services.tasks.appendEvent(
      createTaskEvent({
        taskId: created.id,
        type: "ISSUE_CONTEXT_COLLECTED",
        message: "Workflow queued"
      })
    );
  } catch (error) {
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
  const rootDir = process.cwd();
  const config = await loadAppConfig(rootDir);
  const tasks = await createRepository(config.storage);
  const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableOfflineQueue: false
  });
  const queue = new Queue<IssueWorkflowJob>("issue-workflows", { connection });

  return { config, tasks, queue };
}
