import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findRepository, type AppConfig } from "@agent/config";
import {
  GitHubClient,
  gitHubAuthRequiredMessage,
  hasGitHubAuthConfig,
} from "@agent/github";
import {
  createModelRuntimeAgentRunner,
  runJsonAgent,
  type AgentDefinition,
} from "@agent/model-runtime";
import { buildTaskTrace, buildTaskTraceReplay } from "@agent/observability";
import { transitionTask } from "@agent/orchestrator";
import { createTaskEvent } from "@agent/persistence";
import { uniqueNonEmptyStrings, type JsonObject } from "@agent/shared";
import {
  createAndEnqueueTask,
  enqueueIssueWorkflow,
  getServices,
} from "../services/task-services.js";
import { startConfiguredRepositoryOnboarding } from "../services/repository-onboarding.js";
import { buildRepositoryQueueSummaries } from "./task-queue-summary.js";

const importIssueSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string().min(1),
  body: z.string().default(""),
  labels: z.array(z.string()).default([]),
  baseBranch: z.string().default("main"),
});

const createIssueFromRequirementSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  requirement: z.string().min(1),
  labels: z.array(z.string()).default([]),
  baseBranch: z.string().optional(),
  enqueue: z.boolean().default(true),
});

const issueDraftSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  labels: z.array(z.string()).default([]),
});

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks", async () => {
    const services = await getServices();
    return { tasks: await services.tasks.listTasks() };
  });

  app.get("/tasks/repositories", async () => {
    const services = await getServices();
    const tasks = await services.tasks.listTasks();
    void startConfiguredRepositoryOnboarding(services.config);
    return {
      repositories: buildRepositoryQueueSummaries(
        tasks,
        services.config.repositories,
      ),
    };
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const services = await getServices();
    const task = await services.tasks.getTask(request.params.id);

    if (!task) {
      return reply.code(404).send({ message: "Task not found" });
    }

    return { task };
  });

  app.get<{ Params: { id: string } }>("/tasks/:id/events", async (request) => {
    const services = await getServices();
    return { events: await services.tasks.listEvents(request.params.id) };
  });

  app.get<{ Params: { id: string } }>(
    "/tasks/:id/artifacts",
    async (request) => {
      const services = await getServices();
      return {
        artifacts: await services.tasks.listArtifacts(request.params.id),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/tasks/:id/trace",
    async (request, reply) => {
      const services = await getServices();
      const task = await services.tasks.getTask(request.params.id);

      if (!task) {
        return reply.code(404).send({ message: "Task not found" });
      }

      const [events, artifacts] = await Promise.all([
        services.tasks.listEvents(task.id),
        services.tasks.listArtifacts(task.id),
      ]);
      return { trace: buildTaskTrace({ task, events, artifacts }) };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/tasks/:id/trace/replay", async (request, reply) => {
    const services = await getServices();
    const task = await services.tasks.getTask(request.params.id);

    if (!task) {
      return reply.code(404).send({ message: "Task not found" });
    }

    const [events, artifacts] = await Promise.all([
      services.tasks.listEvents(task.id),
      services.tasks.listArtifacts(task.id),
    ]);
    const trace = buildTaskTrace({ task, events, artifacts });
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    return {
      replay: buildTaskTraceReplay(trace, {
        cursor: request.query.cursor,
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    };
  });

  app.post("/tasks/import-issue", async (request, reply) => {
    const parsed = importIssueSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({
          message: "Invalid issue payload",
          issues: parsed.error.issues,
        });
    }

    const task = await createAndEnqueueTask({
      provider: "github",
      owner: parsed.data.owner,
      repo: parsed.data.repo,
      number: parsed.data.number,
      url: parsed.data.url,
      title: parsed.data.title,
      body: parsed.data.body,
      labels: parsed.data.labels,
      comments: [],
      baseBranch: parsed.data.baseBranch,
    });

    return reply.code(201).send({ task });
  });

  app.post("/tasks/create-issue-from-requirement", async (request, reply) => {
    const parsed = createIssueFromRequirementSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({
          message: "Invalid requirement issue payload",
          issues: parsed.error.issues,
        });
    }

    const services = await getServices();
    const repository = findRepository(
      services.config,
      parsed.data.owner,
      parsed.data.repo,
    );

    if (!repository) {
      return reply.code(404).send({ message: "Repository is not configured" });
    }

    if (!hasGitHubAuthConfig(services.config.github)) {
      return reply.code(400).send({ message: gitHubAuthRequiredMessage });
    }

    const baseBranch = parsed.data.baseBranch ?? repository.default_branch;
    const draft = await draftIssueFromRequirement({
      config: services.config,
      owner: parsed.data.owner,
      repo: parsed.data.repo,
      requirement: parsed.data.requirement,
      labels: parsed.data.labels,
      baseBranch,
    });
    const github = new GitHubClient(services.config.github);
    const issue = await github.createIssue({
      owner: parsed.data.owner,
      repo: parsed.data.repo,
      title: draft.title,
      body: draft.body,
      labels: uniqueNonEmptyStrings([...parsed.data.labels, ...draft.labels]),
      baseBranch,
    });
    const task = parsed.data.enqueue
      ? await createAndEnqueueTask(issue)
      : undefined;

    return reply.code(201).send({ issue, task });
  });

  app.post<{ Params: { id: string } }>(
    "/tasks/:id/approve-prd",
    async (request, reply) => {
      const services = await getServices();
      const task = await services.tasks.getTask(request.params.id);

      if (!task) {
        return reply.code(404).send({ message: "Task not found" });
      }

      if (task.status !== "PRD_REVIEW_REQUIRED") {
        return reply
          .code(409)
          .send({
            message: `Task is ${task.status}, not waiting for PRD approval`,
          });
      }

      const approved = transitionTask(task, "PRD_APPROVED");
      const updated = await services.tasks.updateTask(task.id, {
        status: approved.status,
        updatedAt: approved.updatedAt,
      });
      await services.tasks.appendEvent(
        createTaskEvent({
          taskId: task.id,
          type: "PRD_APPROVED",
          message: "PRD approved by human",
        }),
      );
      await enqueueIssueWorkflow(task.id, `${task.id}-approved-${Date.now()}`);
      return { task: updated };
    },
  );
}

async function draftIssueFromRequirement(input: {
  config: AppConfig;
  owner: string;
  repo: string;
  requirement: string;
  labels: string[];
  baseBranch: string;
}): Promise<z.infer<typeof issueDraftSchema>> {
  try {
    const runner = createModelRuntimeAgentRunner(input.config);
    const configuredAgent = input.config.agents.agents.prd;
    const providerId =
      configuredAgent?.provider ??
      Object.keys(input.config.agents.providers)[0];

    if (!providerId) {
      return fallbackIssueDraft(input.requirement, input.labels);
    }

    const agent: AgentDefinition = {
      id: "requirement-issue-drafter",
      role: "prd",
      providerId,
      systemPrompt: [
        "You turn a raw product or engineering requirement into one GitHub issue draft.",
        "Return only strict JSON with title, body, and labels.",
        "The body must include Background, Goals, Acceptance Criteria, and Notes sections.",
      ].join("\n"),
      skillRefs: configuredAgent?.skills ?? [],
    };
    const result = await runJsonAgent({
      runner,
      agent,
      userPrompt:
        "Create one actionable GitHub issue draft from the requirement.",
      context: {
        repository: {
          owner: input.owner,
          repo: input.repo,
          baseBranch: input.baseBranch,
        },
        labels: input.labels,
        requirement: input.requirement,
      } as JsonObject,
    });

    return issueDraftSchema.parse(result);
  } catch {
    return fallbackIssueDraft(input.requirement, input.labels);
  }
}

function fallbackIssueDraft(
  requirement: string,
  labels: string[],
): z.infer<typeof issueDraftSchema> {
  const firstLine = requirement
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const title = truncate(firstLine ?? "New requirement", 90);

  return {
    title,
    body: [
      "## Background",
      requirement.trim(),
      "",
      "## Goals",
      "- Implement the requested behavior described above.",
      "",
      "## Acceptance Criteria",
      "- The requested behavior is implemented and verified.",
      "- Existing relevant behavior continues to work.",
      "",
      "## Notes",
      "- This issue was generated from a raw requirement by CodeZero.",
    ].join("\n"),
    labels,
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}
