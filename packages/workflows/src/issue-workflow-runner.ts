import {
  findRepository,
  type AppConfig,
  type RepositoryConfig,
} from "@agent/config";
import type { AgentDefinition, AgentRunner } from "@agent/model-runtime";
import { shouldRequirePrdReview, transitionTask } from "@agent/orchestrator";
import { createTaskEvent, type TaskRepository } from "@agent/persistence";
import type { Artifact, JsonObject, ReviewResult, Task } from "@agent/shared";
import type { Sandbox } from "@agent/sandbox";
import {
  createExecutionAgents,
  createWorkflowAgent,
  createWorkflowAgentRunner,
} from "./agent-factory.js";
import { writeTaskArtifact } from "./artifacts.js";
import { latestReviewerFeedback } from "./phases/github-utils.js";
import {
  prepareExistingPrSandbox as prepareExistingPrSandboxPhase,
  syncCodeGraphAfterImplementation as syncCodeGraphAfterImplementationPhase,
} from "./phases/context-preparation.js";
import { review as reviewPhase } from "./phases/implementation.js";
import { publishPrdIssueComment as publishPrdIssueCommentPhase } from "./phases/planning.js";
import { updateExistingPullRequest as updateExistingPullRequestPhase } from "./phases/publishing.js";
import {
  autoApprovePlanningPhase,
  draftPlanningPhase,
  implementAndVerifyPhase,
  prepareContextPhase,
  publishPrPhase,
} from "./phases/issue-workflow-phases.js";

export type IssueWorkflowResult = {
  taskId: string;
  status: Task["status"];
  prUrl?: string;
};

export class IssueWorkflowRunner {
  constructor(
    readonly config: AppConfig,
    readonly tasks: TaskRepository,
  ) {}

  async run(taskId: string): Promise<IssueWorkflowResult> {
    const task = await this.requiredTask(taskId);

    try {
      const repositoryConfig = this.requiredRepository(task);
      if (this.shouldRunPrFeedbackIteration(task)) {
        return await this.runPrFeedbackIteration(task, repositoryConfig);
      }

      const runner = await createWorkflowAgentRunner(this.config);
      const planningAgent = await createWorkflowAgent(
        this.config,
        "prd",
        "prd",
      );

      const prepared = await prepareContextPhase({
        workflow: this,
        task,
        repositoryConfig,
      });
      let updated = prepared.task;
      const { sandbox, planningWasCreated, approvalAlreadySatisfied } =
        prepared;

      const planning = await draftPlanningPhase({
        workflow: this,
        task: updated,
        repositoryConfig,
        runner,
        planningAgent,
      });
      updated = planning.task;
      const planningDocument = planning.planningDocument;
      const agents = await createExecutionAgents(
        this.config,
        planningDocument.complexity.score,
      );

      const requirePrdReview =
        repositoryConfig.workflow?.require_prd_review ?? true;
      const requiresHumanPrdReview =
        requirePrdReview && shouldRequirePrdReview(planningDocument.complexity);
      if (
        !approvalAlreadySatisfied &&
        updated.status !== "PRD_APPROVED" &&
        requiresHumanPrdReview
      ) {
        if (updated.status !== "PRD_REVIEW_REQUIRED") {
          updated = await this.updateStatus(updated.id, "PRD_REVIEW_REQUIRED");
          await this.event(
            updated.id,
            "HUMAN_REVIEW_REQUIRED",
            "PRD requires human approval before implementation",
          );
        }
        if (planningWasCreated) {
          await publishPrdIssueCommentPhase(
            this,
            updated,
            repositoryConfig,
            planningDocument,
            true,
          );
        }
        return { taskId: updated.id, status: updated.status };
      }

      updated = await autoApprovePlanningPhase({
        workflow: this,
        task: updated,
        repositoryConfig,
        planningDocument,
        planningWasCreated,
        approvalAlreadySatisfied,
        message: requiresHumanPrdReview
          ? "PRD approved"
          : "PRD auto-approved by repository workflow policy",
      });

      const selfCheckResult = await implementAndVerifyPhase({
        workflow: this,
        task: updated,
        sandbox,
        repositoryConfig,
        runner,
        implementationAgent: agents.implementation,
        reviewAgent: agents.review,
      });
      updated = selfCheckResult.task;

      if (!selfCheckResult.passed) {
        return { taskId: updated.id, status: updated.status };
      }

      const published = await publishPrPhase({
        workflow: this,
        task: updated,
        sandbox,
        repositoryConfig,
      });
      return {
        taskId: published.task.id,
        status: published.task.status,
        prUrl: published.prUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.tasks.appendEvent(
        createTaskEvent({
          taskId,
          type: "TASK_FAILED",
          level: "error",
          message,
        }),
      );
      const failed = await this.tasks.updateTask(taskId, { status: "FAILED" });
      return { taskId, status: failed.status };
    }
  }

  shouldRunPrFeedbackIteration(task: Task): boolean {
    return Boolean(
      task.prUrl &&
      task.branchName &&
      task.issue.comments.length > 0 &&
      (task.status === "WAITING_MERGE" ||
        task.status === "HUMAN_REVIEW" ||
        task.status === "BLOCKED"),
    );
  }

  async runPrFeedbackIteration(
    task: Task,
    repositoryConfig: RepositoryConfig,
  ): Promise<IssueWorkflowResult> {
    const runner = await createWorkflowAgentRunner(this.config);
    const agents = await createExecutionAgents(
      this.config,
      task.planningDocument?.complexity.score ?? 30,
    );
    const sandbox = await this.prepareExistingPrSandbox(task, repositoryConfig);
    let updated = await this.updateStatus(task.id, "IMPLEMENTING", { sandbox });
    const feedback = latestReviewerFeedback(updated);

    const selfCheckResult = await implementAndVerifyPhase({
      workflow: this,
      task: updated,
      sandbox,
      repositoryConfig,
      runner,
      implementationAgent: agents.implementation,
      reviewAgent: agents.review,
      initialFeedback: feedback,
    });
    updated = selfCheckResult.task;

    if (!selfCheckResult.passed) {
      return {
        taskId: updated.id,
        status: updated.status,
        prUrl: updated.prUrl,
      };
    }

    await updateExistingPullRequestPhase(
      this,
      updated,
      sandbox,
      repositoryConfig,
      feedback,
    );
    updated = await this.requiredTask(updated.id);
    updated = await this.updateStatus(updated.id, "WAITING_MERGE");
    return { taskId: updated.id, status: updated.status, prUrl: updated.prUrl };
  }

  async prepareExistingPrSandbox(
    task: Task,
    repositoryConfig: RepositoryConfig,
  ): Promise<Sandbox> {
    return prepareExistingPrSandboxPhase(this, task, repositoryConfig);
  }

  async syncCodeGraphAfterImplementation(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
  ): Promise<void> {
    return syncCodeGraphAfterImplementationPhase(
      this,
      task,
      sandbox,
      repositoryConfig,
    );
  }

  async review(
    task: Task,
    sandbox: Sandbox,
    runner: AgentRunner,
    agent: AgentDefinition,
    reviewerFeedback = "",
  ): Promise<ReviewResult> {
    return reviewPhase(this, {
      task,
      sandbox,
      runner,
      agent,
      reviewerFeedback,
    });
  }

  requiredRepository(task: Task): RepositoryConfig {
    const repository = findRepository(
      this.config,
      task.issue.owner,
      task.issue.repo,
    );

    if (!repository) {
      throw new Error(
        `Repository ${task.issue.owner}/${task.issue.repo} is not configured`,
      );
    }

    return repository;
  }

  async requiredTask(taskId: string): Promise<Task> {
    const task = await this.tasks.getTask(taskId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return task;
  }

  async updateStatus(
    taskId: string,
    status: Task["status"],
    patch: Partial<Task> = {},
  ): Promise<Task> {
    const current = await this.requiredTask(taskId);
    const next = transitionTask(current, status);
    return this.tasks.updateTask(taskId, {
      ...patch,
      status: next.status,
      updatedAt: next.updatedAt,
    });
  }

  async event(
    taskId: string,
    type: Parameters<typeof createTaskEvent>[0]["type"],
    message: string,
    level: Parameters<typeof createTaskEvent>[0]["level"] = "info",
    metadata?: JsonObject,
  ): Promise<void> {
    await this.tasks.appendEvent(
      createTaskEvent({ taskId, type, message, level, metadata }),
    );
  }

  async writeArtifact(
    taskId: string,
    type: Artifact["type"],
    fileName: string,
    content: string,
  ): Promise<void> {
    await writeTaskArtifact({
      rootDir: this.config.rootDir,
      tasks: this.tasks,
      taskId,
      type,
      fileName,
      content,
    });
  }
}

export {
  cleanupImplementationCheckpoint,
  compactContextPackForImplementation,
  createImplementationCheckpoint,
  extractImplementationFeedbackPaths,
  formatQualityGateRepairFeedback,
  formatReviewRepairFeedback,
  getSelfCheckHardMaxAttempts,
  qualityGateFailuresChanged,
  qualityGateFailureLooksEnvironmental,
  resetImplementationAttempt,
  restoreImplementationCheckpoint,
  selectImplementationSnippetPaths,
  shouldExtendQualityGateSelfCheck,
  shouldExtendReviewSelfCheck,
  shouldExtendSelfCheckAfterFailureKindChange,
  type ImplementationCheckpoint,
} from "./phases/implementation.js";
