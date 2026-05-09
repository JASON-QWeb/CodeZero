import { loadAppConfig } from "@agent/config";
import { createRepository } from "@agent/persistence";
import { IssueWorkflowRunner } from "@agent/workflows";

export type IssueWorkflowJob = {
  taskId: string;
};

export type IssueWorkflowResult = {
  taskId: string;
  status: string;
  prUrl?: string;
};

export async function runIssueWorkflow(job: IssueWorkflowJob): Promise<IssueWorkflowResult> {
  const config = await loadAppConfig(process.cwd());
  const tasks = await createRepository(config.storage);
  const runner = new IssueWorkflowRunner(config, tasks);
  return runner.run(job.taskId);
}
