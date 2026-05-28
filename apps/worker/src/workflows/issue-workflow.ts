import { findRepository, loadAppConfig, type AppConfig } from "@agent/config";
import { isComputeActiveStatus, shouldDeferForRepositoryConcurrency } from "@agent/orchestrator";
import { createRepository, createTaskEvent, type TaskRepository } from "@agent/persistence";
import { createIssueWorkflowGraphRunner, type IssueWorkflowGraphRunner } from "@agent/workflow-graph";

export type IssueWorkflowJob = {
  taskId: string;
};

export type IssueWorkflowResult = {
  taskId: string;
  status: string;
  prUrl?: string;
  deferred?: boolean;
  skipped?: boolean;
  retryDelayMs?: number;
};

export type IssueWorkflowDependencies = {
  loadConfig?: () => Promise<AppConfig>;
  createTaskRepository?: (storage: AppConfig["storage"]) => Promise<TaskRepository>;
  createRunner?: (config: AppConfig, tasks: TaskRepository) => IssueWorkflowGraphRunner;
  repositoryQueueRetryMs?: string;
};

export async function runIssueWorkflow(job: IssueWorkflowJob, dependencies: IssueWorkflowDependencies = {}): Promise<IssueWorkflowResult> {
  const config = await (dependencies.loadConfig ?? loadAppConfig)();
  const tasks = await (dependencies.createTaskRepository ?? createRepository)(config.storage);
  const task = await tasks.getTask(job.taskId);

  if (!task) {
    throw new Error(`Task not found: ${job.taskId}`);
  }

  const repository = findRepository(config, task.issue.owner, task.issue.repo);

  if (!repository) {
    const runner = createRunner(config, tasks, dependencies);
    return runner.run(job.taskId);
  }

  if (isComputeActiveStatus(task.status)) {
    await tasks.appendEvent(
      createTaskEvent({
        taskId: task.id,
        type: "TASK_QUEUED",
        message: `Duplicate workflow job skipped because task is already running with status ${task.status}`,
        metadata: { status: task.status }
      })
    );

    return {
      taskId: task.id,
      status: task.status,
      skipped: true
    };
  }

  const decision = shouldDeferForRepositoryConcurrency(await tasks.listTasks(), task, repository);

  if (decision.shouldDefer) {
    await tasks.appendEvent(
      createTaskEvent({
        taskId: task.id,
        type: "TASK_QUEUED",
        message: decision.reason,
        metadata: {
          runningCount: decision.runningCount,
          queuedCount: decision.queuedCount,
          maxConcurrentIssues: decision.maxConcurrentIssues
        }
      })
    );

    return {
      taskId: task.id,
      status: task.status,
      deferred: true,
      retryDelayMs: Number(dependencies.repositoryQueueRetryMs ?? process.env.REPOSITORY_QUEUE_RETRY_MS ?? 15_000)
    };
  }

  const runner = createRunner(config, tasks, dependencies);
  return runner.run(job.taskId);
}

function createRunner(config: AppConfig, tasks: TaskRepository, dependencies: IssueWorkflowDependencies): IssueWorkflowGraphRunner {
  return dependencies.createRunner?.(config, tasks) ?? createIssueWorkflowGraphRunner(config, tasks);
}
