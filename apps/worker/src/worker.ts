import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { runIssueWorkflow, type IssueWorkflowJob } from "./workflows/issue-workflow.js";

const queueName = "issue-workflows";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const workerConcurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 4));

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null
});

export const issueWorkflowQueue = new Queue<IssueWorkflowJob>(queueName, { connection });

export function startWorker(): Worker<IssueWorkflowJob> {
  return new Worker<IssueWorkflowJob>(
    queueName,
    async (job) => {
      const result = await runIssueWorkflow(job.data);
      if (result.deferred) {
        await issueWorkflowQueue.add(
          "run-issue-workflow",
          { taskId: job.data.taskId },
          {
            delay: result.retryDelayMs ?? 15_000,
            jobId: `${job.data.taskId}-queued-${Date.now()}`
          }
        );
        console.log(`Workflow deferred for ${result.taskId}; repository concurrency limit reached`);
        return result;
      }
      console.log(`Workflow completed for ${result.taskId}: ${result.status}${result.prUrl ? ` ${result.prUrl}` : ""}`);
      return result;
    },
    { connection, concurrency: workerConcurrency }
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker();
  console.log(`Worker listening on queue ${queueName}`);
}
