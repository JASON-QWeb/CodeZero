import { Queue } from "bullmq";
import IORedis from "ioredis";
import { loadAppConfig, type AppConfig } from "@agent/config";
import { FileMemoryStore } from "@agent/memory";
import {
  createTask,
  makeIssueBranchName,
  transitionTask,
} from "@agent/orchestrator";
import {
  createRepository,
  createTaskEvent,
  type TaskRepository,
} from "@agent/persistence";
import type { IssueContext, Task } from "@agent/shared";

export type IssueWorkflowJob = {
  taskId: string;
};

export type ApiServices = {
  config: AppConfig;
  tasks: TaskRepository;
  memoryStore: FileMemoryStore;
  workflowQueue?: IssueWorkflowQueueResources;
};

export type EnqueueIssueWorkflow = (
  taskId: string,
  jobId?: string,
) => Promise<void>;

type IssueWorkflowQueueResources = {
  connection: IORedis;
  queue: Queue<IssueWorkflowJob>;
};

let servicesPromise: Promise<ApiServices> | undefined;

export async function getServices(): Promise<ApiServices> {
  servicesPromise ??= createServices();
  return servicesPromise;
}

export function resetServicesForTests(): void {
  closeServicesSync();
  servicesPromise = undefined;
}

export async function reloadServices(): Promise<ApiServices> {
  await closeServices();
  servicesPromise = createServices();
  return servicesPromise;
}

export async function closeServices(): Promise<void> {
  const services = await servicesPromise?.catch(() => undefined);
  closeServiceResources(services);
  servicesPromise = undefined;
}

export async function createAndEnqueueTask(
  issue: IssueContext,
  options: { enqueue?: EnqueueIssueWorkflow } = {},
): Promise<Task> {
  const services = await getServices();
  const task = {
    ...createTask(issue),
    branchName: makeIssueBranchName(issue),
  };
  const created = await services.tasks.createTask(task);

  await services.tasks.appendEvent(
    createTaskEvent({
      taskId: created.id,
      type: "TASK_CREATED",
      message: `Task created for ${issue.owner}/${issue.repo}#${issue.number}`,
    }),
  );

  try {
    await (options.enqueue ?? enqueueIssueWorkflow)(created.id);
    await services.tasks.appendEvent(
      createTaskEvent({
        taskId: created.id,
        type: "TASK_QUEUED",
        message: "Workflow queued",
      }),
    );
  } catch (error) {
    const blocked = transitionTask(created, "BLOCKED");
    await services.tasks.updateTask(created.id, {
      status: blocked.status,
      updatedAt: blocked.updatedAt,
    });
    await services.tasks.appendEvent(
      createTaskEvent({
        taskId: created.id,
        type: "TASK_BLOCKED",
        level: "warn",
        message: `Task created but workflow queue is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }

  return created;
}

async function createServices(): Promise<ApiServices> {
  const config = await loadAppConfig();
  const tasks = await createRepository(config.storage);
  const memoryStore = new FileMemoryStore(config.memory.filePath, {
    maxRecords: config.memory.maxRecords,
    maxBytes: config.memory.maxBytes,
    maxRecordBytes: config.memory.maxRecordBytes,
  });

  return { config, tasks, memoryStore };
}

export async function enqueueIssueWorkflow(
  taskId: string,
  jobId = taskId,
): Promise<void> {
  const services = await getServices();
  const { queue } = getWorkflowQueueResources(services);
  await queue.add("run-issue-workflow", { taskId }, { jobId });
}

function getWorkflowQueueResources(
  services: ApiServices,
): IssueWorkflowQueueResources {
  if (!services.workflowQueue) {
    const connection = new IORedis(
      process.env.REDIS_URL ?? "redis://localhost:6379",
      {
        maxRetriesPerRequest: null,
        lazyConnect: true,
        enableOfflineQueue: false,
      },
    );
    connection.on("error", () => undefined);
    services.workflowQueue = {
      connection,
      queue: new Queue<IssueWorkflowJob>("issue-workflows", { connection }),
    };
  }

  return services.workflowQueue;
}

function closeServicesSync(): void {
  void servicesPromise
    ?.then((services) => closeServiceResources(services))
    .catch(() => undefined);
}

function closeServiceResources(services: ApiServices | undefined): void {
  if (!services?.workflowQueue) {
    return;
  }

  void services.workflowQueue.queue.close().catch(() => undefined);
  services.workflowQueue.connection.disconnect();
  services.workflowQueue = undefined;
}
