import { findRepository, loadAppConfig } from "@agent/config";
import { shouldDeferForRepositoryConcurrency } from "@agent/orchestrator";
import { createRepository, createTaskEvent } from "@agent/persistence";
import { IssueWorkflowRunner } from "@agent/workflows";

export type IssueWorkflowJob = {
  taskId: string;
};

export type IssueWorkflowResult = {
  taskId: string;
  status: string;
  prUrl?: string;
  deferred?: boolean;
  retryDelayMs?: number;
};

export async function runIssueWorkflow(job: IssueWorkflowJob): Promise<IssueWorkflowResult> {
  const config = await loadAppConfig();
  const tasks = await createRepository(config.storage);
  const task = await tasks.getTask(job.taskId);

  if (!task) {
    throw new Error(`Task not found: ${job.taskId}`);
  }

  const repository = findRepository(config, task.issue.owner, task.issue.repo);

  if (!repository) {
    const runner = new IssueWorkflowRunner(config, tasks);
    return runner.run(job.taskId);
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
      retryDelayMs: Number(process.env.REPOSITORY_QUEUE_RETRY_MS ?? 15_000)
    };
  }

  const runner = new IssueWorkflowRunner(config, tasks);
  return runner.run(job.taskId);
}
