import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { runIssueWorkflow, type IssueWorkflowJob } from "./workflows/issue-workflow.js";

export const queueName = "issue-workflows";

export type IssueWorkflowQueue = Pick<Queue<IssueWorkflowJob>, "add">;
export type IssueWorkflowProcessor = (job: IssueWorkflowJob) => Promise<Awaited<ReturnType<typeof runIssueWorkflow>>>;

export function getWorkerConcurrency(value = process.env.WORKER_CONCURRENCY ?? "4"): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
}

export function createRedisConnection(redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"): IORedis {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null
  });
}

export function createIssueWorkflowQueue(connection: IORedis): Queue<IssueWorkflowJob> {
  return new Queue<IssueWorkflowJob>(queueName, { connection });
}

export async function processIssueWorkflowJob(
  job: IssueWorkflowJob,
  queue: IssueWorkflowQueue,
  processor: IssueWorkflowProcessor = runIssueWorkflow
): Promise<Awaited<ReturnType<IssueWorkflowProcessor>>> {
  const result = await processor(job);
  if (result.deferred) {
    await queue.add(
      "run-issue-workflow",
      { taskId: job.taskId },
      {
        delay: result.retryDelayMs ?? 15_000,
        jobId: `${job.taskId}-queued-${Date.now()}`
      }
    );
    console.log(`Workflow deferred for ${result.taskId}; repository concurrency limit reached`);
    return result;
  }
  if (result.skipped) {
    console.log(`Workflow skipped for ${result.taskId}: ${result.status}`);
    return result;
  }
  console.log(`Workflow completed for ${result.taskId}: ${result.status}${result.prUrl ? ` ${result.prUrl}` : ""}`);
  return result;
}

export function startWorker(input: { connection?: IORedis; queue?: IssueWorkflowQueue; concurrency?: number } = {}): Worker<IssueWorkflowJob> {
  const connection = input.connection ?? createRedisConnection();
  const queue = input.queue ?? createIssueWorkflowQueue(connection);
  return new Worker<IssueWorkflowJob>(
    queueName,
    async (job) => processIssueWorkflowJob(job.data, queue),
    { connection, concurrency: input.concurrency ?? getWorkerConcurrency() }
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker();
  console.log(`Worker listening on queue ${queueName}`);
}
