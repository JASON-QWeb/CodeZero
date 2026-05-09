import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { runIssueWorkflow, type IssueWorkflowJob } from "./workflows/issue-workflow.js";

const queueName = "issue-workflows";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null
});

export const issueWorkflowQueue = new Queue<IssueWorkflowJob>(queueName, { connection });

export function startWorker(): Worker<IssueWorkflowJob> {
  return new Worker<IssueWorkflowJob>(
    queueName,
    async (job) => {
      const result = await runIssueWorkflow(job.data);
      console.log(`Workflow completed for ${result.taskId}: ${result.status}${result.prUrl ? ` ${result.prUrl}` : ""}`);
      return result;
    },
    { connection }
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker();
  console.log(`Worker listening on queue ${queueName}`);
}
