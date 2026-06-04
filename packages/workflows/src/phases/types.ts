import type { AppConfig, RepositoryConfig } from "@agent/config";
import type { AgentDefinition, AgentRunner } from "@agent/model-runtime";
import type { createTaskEvent, TaskRepository } from "@agent/persistence";
import type {
  Artifact,
  JsonObject,
  QualityGateResult,
  ReviewResult,
  Task,
} from "@agent/shared";
import type { Sandbox } from "@agent/sandbox";

export type WorkflowServices = {
  readonly config: AppConfig;
  readonly tasks: TaskRepository;
  requiredTask(taskId: string): Promise<Task>;
  updateStatus(
    taskId: string,
    status: Task["status"],
    patch?: Partial<Task>,
  ): Promise<Task>;
  event(
    taskId: string,
    type: Parameters<typeof createTaskEvent>[0]["type"],
    message: string,
    level?: Parameters<typeof createTaskEvent>[0]["level"],
    metadata?: JsonObject,
  ): Promise<void>;
  writeArtifact(
    taskId: string,
    type: Artifact["type"],
    fileName: string,
    content: string,
  ): Promise<void>;
};

export type ContextPreparationHost = WorkflowServices & {
  authenticatedRemoteUrl(repositoryConfig: RepositoryConfig): Promise<string>;
};

export type ImplementationHost = WorkflowServices & {
  syncCodeGraphAfterImplementation(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
  ): Promise<void>;
};

export type PublishingHost = WorkflowServices;

export type IssueWorkflowPhaseHost = ImplementationHost;

export type ImplementationReviewInput = {
  task: Task;
  sandbox: Sandbox;
  runner: AgentRunner;
  agent: AgentDefinition;
  reviewerFeedback?: string;
};

export type ImplementationSelfCheckInput = {
  task: Task;
  sandbox: Sandbox;
  repositoryConfig: RepositoryConfig;
  runner: AgentRunner;
  implementationAgent: AgentDefinition;
  reviewAgent: AgentDefinition;
  initialFeedback?: string;
};

export type ImplementationSelfCheckResult = {
  task: Task;
  passed: boolean;
  reason: string;
};

export type QualityGateRunnerInput = {
  task: Task;
  sandbox: Sandbox;
  repositoryConfig: RepositoryConfig;
};

export type QualityGateRunnerResult = QualityGateResult[];
export type ReviewRunnerResult = ReviewResult;
