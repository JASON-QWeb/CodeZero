import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RepositoryConfig } from "@agent/config";
import { buildTaskTrace } from "@agent/observability";
import { computeRepositoryQueueState, transitionTask } from "@agent/orchestrator";
import { createTaskEvent } from "@agent/persistence";
import type { Task } from "@agent/shared";
import { createAndEnqueueTask, enqueueIssueWorkflow, getServices } from "../services/task-services.js";

const importIssueSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string().min(1),
  body: z.string().default(""),
  labels: z.array(z.string()).default([]),
  baseBranch: z.string().default("main")
});

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks", async () => {
    const services = await getServices();
    return { tasks: await services.tasks.listTasks() };
  });

  app.get("/tasks/repositories", async () => {
    const services = await getServices();
    const tasks = await services.tasks.listTasks();
    return { repositories: buildRepositoryQueueSummaries(tasks, services.config.repositories) };
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

  app.get<{ Params: { id: string } }>("/tasks/:id/artifacts", async (request) => {
    const services = await getServices();
    return { artifacts: await services.tasks.listArtifacts(request.params.id) };
  });

  app.get<{ Params: { id: string } }>("/tasks/:id/trace", async (request, reply) => {
    const services = await getServices();
    const task = await services.tasks.getTask(request.params.id);

    if (!task) {
      return reply.code(404).send({ message: "Task not found" });
    }

    const [events, artifacts] = await Promise.all([services.tasks.listEvents(task.id), services.tasks.listArtifacts(task.id)]);
    return { trace: buildTaskTrace({ task, events, artifacts }) };
  });

  app.post("/tasks/import-issue", async (request, reply) => {
    const parsed = importIssueSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid issue payload", issues: parsed.error.issues });
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
      baseBranch: parsed.data.baseBranch
    });

    return reply.code(201).send({ task });
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/approve-prd", async (request, reply) => {
    const services = await getServices();
    const task = await services.tasks.getTask(request.params.id);

    if (!task) {
      return reply.code(404).send({ message: "Task not found" });
    }

    const approved = transitionTask(task, "PRD_APPROVED");
    const updated = await services.tasks.updateTask(task.id, { status: approved.status, updatedAt: approved.updatedAt });
    await services.tasks.appendEvent(createTaskEvent({ taskId: task.id, type: "PRD_APPROVED", message: "PRD approved by human" }));
    await enqueueIssueWorkflow(task.id, `${task.id}-approved-${Date.now()}`);
    return { task: updated };
  });
}

type RepositoryQueueSummary = {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  configured: boolean;
  maxConcurrentIssues: number;
  runningCount: number;
  queuedCount: number;
  reviewCount: number;
  blockedCount: number;
  completedCount: number;
  totalCount: number;
  availableSlots: number;
  tasks: Task[];
};

function buildRepositoryQueueSummaries(tasks: Task[], repositories: RepositoryConfig[]): RepositoryQueueSummary[] {
  const summaries = new Map<string, RepositoryQueueSummary>();

  for (const repository of repositories) {
    const key = repositoryKey(repository.github_owner, repository.github_repo);
    const state = computeRepositoryQueueState(tasks, repository);
    summaries.set(key, {
      id: repository.id,
      owner: repository.github_owner,
      repo: repository.github_repo,
      fullName: `${repository.github_owner}/${repository.github_repo}`,
      configured: true,
      ...state,
      tasks: []
    });
  }

  for (const task of tasks) {
    const key = repositoryKey(task.issue.owner, task.issue.repo);
    let summary = summaries.get(key);

    if (!summary) {
      const inferredRepository = {
        id: key,
        github_owner: task.issue.owner,
        github_repo: task.issue.repo,
        queue: {
          max_concurrent_issues: 1
        }
      };
      const state = computeRepositoryQueueState(tasks, inferredRepository);
      summary = {
        id: key,
        owner: task.issue.owner,
        repo: task.issue.repo,
        fullName: `${task.issue.owner}/${task.issue.repo}`,
        configured: false,
        ...state,
        tasks: []
      };
      summaries.set(key, summary);
    }

    summary.tasks.push(task);
  }

  return [...summaries.values()].sort((left, right) => {
    const activityDelta = right.runningCount + right.queuedCount - (left.runningCount + left.queuedCount);

    if (activityDelta !== 0) {
      return activityDelta;
    }

    return left.fullName.localeCompare(right.fullName);
  });
}

function repositoryKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}
