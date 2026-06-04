import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { AppConfig, RepositoryConfig } from "@agent/config";
import { shouldRequirePrdReview } from "@agent/orchestrator";
import { createTaskEvent, type TaskRepository } from "@agent/persistence";
import type { JsonValue, PlanningDocument, Task } from "@agent/shared";
import type { Sandbox } from "@agent/sandbox";
import {
  createExecutionAgents,
  createWorkflowAgent,
  createWorkflowAgentRunner,
  autoApprovePlanningPhase,
  draftPlanningPhase,
  implementAndVerifyPhase,
  IssueWorkflowRunner,
  prepareContextPhase,
  publishPrdIssueComment,
  publishPrPhase,
  type IssueWorkflowResult,
} from "@agent/workflows";
import { createDurableCheckpointer } from "./checkpointer.js";

export {
  FileLangGraphCheckpointSaver,
  PostgresLangGraphCheckpointSaver,
  createDurableCheckpointer,
} from "./checkpointer.js";

type PreparedSandbox = Sandbox;
type GraphRoute =
  | "prepare_context"
  | "pr_feedback_iteration"
  | "approve_plan"
  | "implement_and_verify"
  | "publish_pr"
  | "end";

export type IssueWorkflowGraphState = {
  taskId: string;
  task?: Task;
  repositoryConfig?: RepositoryConfig;
  sandbox?: PreparedSandbox;
  planningDocument?: PlanningDocument;
  planningWasCreated?: boolean;
  approvalAlreadySatisfied?: boolean;
  route?: GraphRoute;
  status?: Task["status"];
  prUrl?: string;
  error?: string;
};

export type IssueWorkflowGraphRunner = {
  run(taskId: string): Promise<IssueWorkflowResult>;
};

const GraphState = Annotation.Root({
  taskId: Annotation<string>(),
  task: Annotation<Task | undefined>(),
  repositoryConfig: Annotation<RepositoryConfig | undefined>(),
  sandbox: Annotation<PreparedSandbox | undefined>(),
  planningDocument: Annotation<PlanningDocument | undefined>(),
  planningWasCreated: Annotation<boolean | undefined>(),
  approvalAlreadySatisfied: Annotation<boolean | undefined>(),
  route: Annotation<GraphRoute | undefined>(),
  status: Annotation<Task["status"] | undefined>(),
  prUrl: Annotation<string | undefined>(),
  error: Annotation<string | undefined>(),
});

export function createIssueWorkflowGraphRunner(
  config: AppConfig,
  tasks: TaskRepository,
): IssueWorkflowGraphRunner {
  const checkpointer = createDurableCheckpointer(config);
  const workflow = new IssueWorkflowRunner(config, tasks);
  const graph = new StateGraph(GraphState)
    .addNode("load_task", async (state) => {
      const task = await workflow.requiredTask(state.taskId);
      const repositoryConfig = workflow.requiredRepository(task);

      return {
        task,
        repositoryConfig,
        route: workflow.shouldRunPrFeedbackIteration(task)
          ? "pr_feedback_iteration"
          : "prepare_context",
      };
    })
    .addNode("pr_feedback_iteration", async (state) => {
      const task = requireState(state.task, "task");
      const repositoryConfig = requireState(
        state.repositoryConfig,
        "repositoryConfig",
      );
      const result = await workflow.runPrFeedbackIteration(
        task,
        repositoryConfig,
      );

      return {
        status: result.status,
        prUrl: result.prUrl,
        route: "end",
      };
    })
    .addNode("prepare_context", async (state) => {
      const repositoryConfig = requireState(
        state.repositoryConfig,
        "repositoryConfig",
      );
      const prepared = await prepareContextPhase({
        workflow,
        task: requireState(state.task, "task"),
        repositoryConfig,
      });

      return {
        task: prepared.task,
        sandbox: prepared.sandbox,
        planningWasCreated: prepared.planningWasCreated,
        approvalAlreadySatisfied: prepared.approvalAlreadySatisfied,
      };
    })
    .addNode("draft_plan", async (state) => {
      const repositoryConfig = requireState(
        state.repositoryConfig,
        "repositoryConfig",
      );
      const task = requireState(state.task, "task");
      if (task.planningDocument) {
        return {
          task,
          planningDocument: task.planningDocument,
        };
      }
      const planning = await draftPlanningPhase({
        workflow,
        task,
        repositoryConfig,
        runner: await createWorkflowAgentRunner(config),
        planningAgent: await createWorkflowAgent(config, "prd", "prd"),
      });

      return {
        task: planning.task,
        planningDocument: planning.planningDocument,
      };
    })
    .addNode("approval_gate", async (state) => {
      const repositoryConfig = requireState(
        state.repositoryConfig,
        "repositoryConfig",
      );
      const planningDocument = requireState(
        state.planningDocument,
        "planningDocument",
      );
      let task = requireState(state.task, "task");
      const approvalAlreadySatisfied =
        state.approvalAlreadySatisfied ?? task.status === "PRD_APPROVED";
      const requirePrdReview =
        repositoryConfig.workflow?.require_prd_review ?? true;
      const requiresHumanPrdReview =
        requirePrdReview && shouldRequirePrdReview(planningDocument.complexity);

      if (
        !approvalAlreadySatisfied &&
        task.status !== "PRD_APPROVED" &&
        requiresHumanPrdReview
      ) {
        if (task.status !== "PRD_REVIEW_REQUIRED") {
          task = await workflow.updateStatus(task.id, "PRD_REVIEW_REQUIRED");
          await workflow.event(
            task.id,
            "HUMAN_REVIEW_REQUIRED",
            "PRD requires human approval before implementation",
          );
        }
        if (state.planningWasCreated) {
          await publishPrdIssueComment(
            workflow,
            task,
            repositoryConfig,
            planningDocument,
            true,
          );
        }
        const resume = interrupt<
          {
            type: "prd_approval_required";
            taskId: string;
            planningDocument: PlanningDocument;
          },
          { approved?: boolean; by?: string } | "approved" | "rejected"
        >({
          type: "prd_approval_required",
          taskId: task.id,
          planningDocument,
        });

        if (isApprovedResume(resume)) {
          task = await workflow.requiredTask(task.id);
          if (task.status !== "PRD_APPROVED") {
            task = await workflow.updateStatus(task.id, "PRD_APPROVED");
            await workflow.event(
              task.id,
              "PRD_APPROVED",
              `PRD approved by ${typeof resume === "object" ? (resume.by ?? "human") : "human"}`,
            );
          }

          return {
            task,
            status: task.status,
            route: "implement_and_verify",
          };
        }

        return {
          task,
          status: task.status,
          route: "end",
        };
      }

      return {
        task,
        route:
          task.status !== "PRD_APPROVED"
            ? "approve_plan"
            : "implement_and_verify",
      };
    })
    .addNode("approve_plan", async (state) => {
      const repositoryConfig = requireState(
        state.repositoryConfig,
        "repositoryConfig",
      );
      const planningDocument = requireState(
        state.planningDocument,
        "planningDocument",
      );
      const currentTask = requireState(state.task, "task");
      const task = await autoApprovePlanningPhase({
        workflow,
        task: currentTask,
        repositoryConfig,
        planningDocument,
        planningWasCreated: Boolean(state.planningWasCreated),
        approvalAlreadySatisfied:
          state.approvalAlreadySatisfied ??
          currentTask.status === "PRD_APPROVED",
        message: "PRD auto-approved by repository workflow policy",
      });

      return {
        task,
        status: task.status,
        route: "implement_and_verify",
      };
    })
    .addNode("implement_and_verify", async (state) => {
      const repositoryConfig = requireState(
        state.repositoryConfig,
        "repositoryConfig",
      );
      const sandbox = requireState(state.sandbox, "sandbox");
      const planningDocument = requireState(
        state.planningDocument,
        "planningDocument",
      );
      const runner = await createWorkflowAgentRunner(config);
      const agents = await createExecutionAgents(
        config,
        planningDocument.complexity.score,
      );
      const selfCheckResult = await implementAndVerifyPhase({
        workflow,
        task: requireState(state.task, "task"),
        sandbox,
        repositoryConfig,
        runner,
        implementationAgent: agents.implementation,
        reviewAgent: agents.review,
      });
      const task = selfCheckResult.task;

      if (!selfCheckResult.passed) {
        return {
          task,
          status: task.status,
          route: "end",
        };
      }

      return {
        task,
        route: "publish_pr",
      };
    })
    .addNode("publish_pr", async (state) => {
      const repositoryConfig = requireState(
        state.repositoryConfig,
        "repositoryConfig",
      );
      const sandbox = requireState(state.sandbox, "sandbox");
      const published = await publishPrPhase({
        workflow,
        task: requireState(state.task, "task"),
        sandbox,
        repositoryConfig,
      });

      return {
        task: published.task,
        status: published.task.status,
        prUrl: published.prUrl,
        route: "end",
      };
    })
    .addEdge(START, "load_task")
    .addConditionalEdges("load_task", (state) =>
      state.route === "pr_feedback_iteration"
        ? "pr_feedback_iteration"
        : "prepare_context",
    )
    .addEdge("pr_feedback_iteration", END)
    .addEdge("prepare_context", "draft_plan")
    .addEdge("draft_plan", "approval_gate")
    .addConditionalEdges("approval_gate", (state) => {
      if (state.route === "approve_plan") {
        return "approve_plan";
      }
      if (state.route === "implement_and_verify") {
        return "implement_and_verify";
      }
      return END;
    })
    .addEdge("approve_plan", "implement_and_verify")
    .addConditionalEdges("implement_and_verify", (state) =>
      state.route === "publish_pr" ? "publish_pr" : END,
    )
    .addEdge("publish_pr", END)
    .compile({ checkpointer });

  return {
    async run(taskId: string): Promise<IssueWorkflowResult> {
      await tasks.appendEvent(
        createTaskEvent({
          taskId,
          type: "AGENT_RUN_STARTED",
          message: "LangGraph issue workflow started",
          metadata: { graphThreadId: taskId },
        }),
      );

      try {
        const task = await tasks.getTask(taskId);
        const checkpoint = await checkpointer.getTuple({
          configurable: { thread_id: taskId },
        });
        const input =
          task?.status === "PRD_APPROVED" && checkpoint
            ? new Command({ resume: { approved: true, by: "human" } })
            : { taskId };
        const timeoutMs = config.sandbox.limits.max_runtime_minutes * 60_000;
        const result = await withWorkflowTimeout(
          graph.invoke(input as Parameters<typeof graph.invoke>[0], {
            configurable: { thread_id: taskId },
          }),
          timeoutMs,
          taskId,
        );
        if (hasInterrupts(result)) {
          const interruptedTask = await tasks.getTask(taskId);
          const status = interruptedTask?.status ?? "PRD_REVIEW_REQUIRED";
          await tasks.appendEvent(
            createTaskEvent({
              taskId,
              type: "AGENT_RUN_FINISHED",
              message: `LangGraph issue workflow paused with ${status}`,
              metadata: {
                graphThreadId: taskId,
                interrupts: toJsonValue(result.__interrupt__),
              },
            }),
          );

          return {
            taskId,
            status,
            prUrl: interruptedTask?.prUrl,
          };
        }
        const status = result.status ?? result.task?.status ?? "FAILED";
        const prUrl = result.prUrl ?? result.task?.prUrl;
        await tasks.appendEvent(
          createTaskEvent({
            taskId,
            type: "AGENT_RUN_FINISHED",
            message: `LangGraph issue workflow finished with ${status}`,
            metadata: {
              graphThreadId: taskId,
              prUrl: prUrl ?? null,
            },
          }),
        );

        return { taskId, status, prUrl };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await tasks.appendEvent(
          createTaskEvent({
            taskId,
            type: "TASK_FAILED",
            level: "error",
            message,
            metadata: { graphThreadId: taskId },
          }),
        );
        const failed = await tasks.updateTask(taskId, { status: "FAILED" });
        return { taskId, status: failed.status };
      }
    },
  };
}

async function withWorkflowTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  taskId: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `LangGraph issue workflow ${taskId} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function requireState<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null) {
    throw new Error(`LangGraph state is missing ${name}`);
  }

  return value;
}

function isApprovedResume(
  value: { approved?: boolean } | "approved" | "rejected",
): boolean {
  return (
    value === "approved" ||
    (typeof value === "object" && value.approved === true)
  );
}

function hasInterrupts(
  value: unknown,
): value is { __interrupt__: Array<{ value: unknown }> } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "__interrupt__" in value &&
    Array.isArray((value as { __interrupt__?: unknown }).__interrupt__),
  );
}

function toJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}
