import type { RepositoryConfig } from "@agent/config";
import type { AgentDefinition, AgentRunner } from "@agent/model-runtime";
import type { PlanningDocument, Task } from "@agent/shared";
import type { Sandbox } from "@agent/sandbox";
import type { IssueWorkflowPhaseHost } from "./types.js";
import { createContextPack, prepareSandbox } from "./context-preparation.js";
import { runImplementationSelfCheckLoop } from "./implementation.js";
import { draftPlanningDocument, publishPrdIssueComment } from "./planning.js";
import { createDraftPr } from "./publishing.js";

export type { IssueWorkflowPhaseHost } from "./types.js";

export async function prepareContextPhase(input: {
  workflow: IssueWorkflowPhaseHost;
  task: Task;
  repositoryConfig: RepositoryConfig;
}): Promise<{
  task: Task;
  sandbox: Sandbox;
  planningWasCreated: boolean;
  approvalAlreadySatisfied: boolean;
}> {
  const planningWasCreated = !input.task.planningDocument;
  const approvalAlreadySatisfied = input.task.status === "PRD_APPROVED";
  let task = input.task;

  if (
    planningWasCreated &&
    (task.status === "QUEUED" || task.status === "ISSUE_RECEIVED")
  ) {
    task = await input.workflow.updateStatus(task.id, "CONTEXT_COLLECTING");
  }

  const prepared = await prepareSandbox(
    input.workflow,
    task,
    input.repositoryConfig,
  );
  task = prepared.task;

  if (!task.contextPack) {
    const contextPack = await createContextPack(
      input.workflow,
      task,
      prepared.sandbox,
      input.repositoryConfig,
    );
    task = await input.workflow.updateStatus(task.id, "CONTEXT_PACK_CREATED", {
      contextPack,
    });
  }

  return {
    task,
    sandbox: prepared.sandbox,
    planningWasCreated,
    approvalAlreadySatisfied,
  };
}

export async function draftPlanningPhase(input: {
  workflow: IssueWorkflowPhaseHost;
  task: Task;
  repositoryConfig: RepositoryConfig;
  runner: AgentRunner;
  planningAgent: AgentDefinition;
}): Promise<{ task: Task; planningDocument: PlanningDocument }> {
  let task = input.task;
  let planningDocument = task.planningDocument;

  if (!planningDocument) {
    planningDocument = await draftPlanningDocument(
      input.workflow,
      task,
      input.repositoryConfig,
      input.runner,
      input.planningAgent,
    );
    task = await input.workflow.updateStatus(task.id, "PRD_DRAFTED", {
      planningDocument,
    });
  }

  return { task, planningDocument };
}

export async function autoApprovePlanningPhase(input: {
  workflow: IssueWorkflowPhaseHost;
  task: Task;
  repositoryConfig: RepositoryConfig;
  planningDocument: PlanningDocument;
  planningWasCreated: boolean;
  approvalAlreadySatisfied: boolean;
  message: string;
}): Promise<Task> {
  let task = input.task;

  if (task.status !== "PRD_APPROVED") {
    task = await input.workflow.updateStatus(task.id, "PRD_APPROVED");
    if (!input.approvalAlreadySatisfied) {
      await input.workflow.event(task.id, "PRD_APPROVED", input.message);
    }
    if (input.planningWasCreated) {
      await publishPrdIssueComment(
        input.workflow,
        task,
        input.repositoryConfig,
        input.planningDocument,
        false,
      );
    }
  }

  return task;
}

export async function implementAndVerifyPhase(input: {
  workflow: IssueWorkflowPhaseHost;
  task: Task;
  sandbox: Sandbox;
  repositoryConfig: RepositoryConfig;
  runner: AgentRunner;
  implementationAgent: AgentDefinition;
  reviewAgent: AgentDefinition;
  initialFeedback?: string;
}): Promise<{ task: Task; passed: boolean; reason: string }> {
  let task =
    input.task.status === "IMPLEMENTING"
      ? input.task
      : await input.workflow.updateStatus(input.task.id, "IMPLEMENTING");
  const selfCheckResult = await runImplementationSelfCheckLoop(input.workflow, {
    task,
    sandbox: input.sandbox,
    repositoryConfig: input.repositoryConfig,
    runner: input.runner,
    implementationAgent: input.implementationAgent,
    reviewAgent: input.reviewAgent,
    initialFeedback: input.initialFeedback,
  });
  task = selfCheckResult.task;

  if (!selfCheckResult.passed) {
    task = await input.workflow.updateStatus(task.id, "BLOCKED");
    await input.workflow.event(
      task.id,
      "TASK_BLOCKED",
      selfCheckResult.reason,
      "warn",
    );
  }

  return { ...selfCheckResult, task };
}

export async function publishPrPhase(input: {
  workflow: IssueWorkflowPhaseHost;
  task: Task;
  sandbox: Sandbox;
  repositoryConfig: RepositoryConfig;
}): Promise<{ task: Task; prUrl: string }> {
  const prUrl = await createDraftPr(
    input.workflow,
    input.task,
    input.sandbox,
    input.repositoryConfig,
  );
  const task = await input.workflow.updateStatus(
    input.task.id,
    "WAITING_MERGE",
    {
      prUrl,
    },
  );
  return { task, prUrl };
}
