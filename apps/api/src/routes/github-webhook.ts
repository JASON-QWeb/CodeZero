import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { evaluateRepositoryTrigger, findRepository } from "@agent/config";
import { z } from "zod";
import { canTransition, transitionTask } from "@agent/orchestrator";
import { createTaskEvent } from "@agent/persistence";
import { createAndEnqueueTask, enqueueIssueWorkflow, getServices } from "../services/task-services.js";

const issueSchema = z.object({
  number: z.number(),
  html_url: z.string().url(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.object({ name: z.string().nullable() })).default([]),
  pull_request: z.object({ url: z.string().url().optional(), html_url: z.string().url().optional() }).optional()
});

const repositorySchema = z.object({
  name: z.string(),
  owner: z.object({
    login: z.string()
  }),
  default_branch: z.string()
});

const issueWebhookSchema = z.object({
  action: z.string(),
  issue: issueSchema,
  repository: repositorySchema,
  sender: z.object({ login: z.string().optional() }).nullable().optional()
});

const issueCommentWebhookSchema = z.object({
  action: z.string(),
  issue: issueSchema,
  comment: z.object({
    id: z.number().optional(),
    body: z.string().nullable(),
    user: z.object({ login: z.string().optional() }).nullable().optional(),
    html_url: z.string().url().optional(),
    created_at: z.string().optional()
  }),
  repository: repositorySchema,
  sender: z.object({ login: z.string().optional() }).nullable().optional()
});

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  number: z.number(),
  pull_request: z.object({
    number: z.number().optional(),
    html_url: z.string().url(),
    merged: z.boolean().default(false),
    merged_at: z.string().nullable().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    head: z.object({ ref: z.string().optional() }).optional()
  }),
  repository: repositorySchema,
  sender: z.object({ login: z.string().optional() }).nullable().optional()
});

export async function registerGitHubWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/github", async (request, reply) => {
    const services = await getServices();
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});

    if (services.config.github.webhookSecret && !verifyGitHubSignature(request, rawBody, services.config.github.webhookSecret)) {
      return reply.code(401).send({ message: "Invalid GitHub signature" });
    }

    const event = request.headers["x-github-event"];

    if (event === "issues") {
      const parsed = issueWebhookSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid GitHub webhook payload", issues: parsed.error.issues });
      }

      if (!["opened", "labeled", "reopened"].includes(parsed.data.action)) {
        return { ignored: true, reason: `Unsupported issue action ${parsed.data.action}` };
      }

      const labels = parsed.data.issue.labels.map((label) => label.name ?? "").filter(Boolean);
      const repository = findRepository(services.config, parsed.data.repository.owner.login, parsed.data.repository.name);
      const decision = evaluateRepositoryTrigger({
        repository,
        eventName: "issues",
        action: parsed.data.action,
        labels,
        actor: parsed.data.sender?.login
      });

      if (!decision.shouldTrigger) {
        return { ignored: true, reason: decision.reason, trigger: decision.trigger };
      }

      const task = await createAndEnqueueTask({
        provider: "github",
        owner: parsed.data.repository.owner.login,
        repo: parsed.data.repository.name,
        number: parsed.data.issue.number,
        url: parsed.data.issue.html_url,
        title: parsed.data.issue.title,
        body: parsed.data.issue.body ?? "",
        labels,
        comments: [],
        baseBranch: parsed.data.repository.default_branch
      });

      return reply.code(202).send({ task, trigger: decision.trigger, reason: decision.reason });
    }

    if (event === "pull_request") {
      const parsed = pullRequestWebhookSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid GitHub pull_request payload", issues: parsed.error.issues });
      }

      if (parsed.data.action !== "closed" || !parsed.data.pull_request.merged) {
        return { ignored: true, reason: `Unsupported pull_request action ${parsed.data.action}` };
      }

      const pullNumber = parsed.data.pull_request.number ?? parsed.data.number;
      const task = (await services.tasks.listTasks()).find(
        (candidate) =>
          candidate.issue.owner === parsed.data.repository.owner.login &&
          candidate.issue.repo === parsed.data.repository.name &&
          (candidate.prUrl === parsed.data.pull_request.html_url ||
            candidate.prUrl?.endsWith(`/pull/${pullNumber}`) ||
            (parsed.data.pull_request.head?.ref && candidate.branchName === parsed.data.pull_request.head.ref))
      );

      if (!task) {
        return { ignored: true, reason: `No tracked task found for merged PR ${parsed.data.pull_request.html_url}` };
      }

      if (task.status === "DONE") {
        return { ignored: true, reason: `Task ${task.id} is already done` };
      }

      if (task.status === "CANCELLED" || !canTransition(task.status, "DONE")) {
        return { ignored: true, reason: `Task ${task.id} cannot complete from ${task.status}` };
      }

      const completed = transitionTask(task, "DONE");
      const updated = await services.tasks.updateTask(task.id, {
        status: completed.status,
        updatedAt: completed.updatedAt,
        prUrl: task.prUrl ?? parsed.data.pull_request.html_url
      });
      await services.tasks.appendEvent(
        createTaskEvent({
          taskId: task.id,
          type: "TASK_COMPLETED",
          message: `Merged PR completed task: ${parsed.data.pull_request.html_url}`,
          metadata: {
            prUrl: parsed.data.pull_request.html_url,
            pullNumber,
            mergedAt: parsed.data.pull_request.merged_at ?? null,
            mergeCommitSha: parsed.data.pull_request.merge_commit_sha ?? null,
            sandboxRetained: true
          }
        })
      );
      return reply.code(202).send({ task: updated, trigger: "pull_request_merged", reason: "Task completed after PR merge" });
    }

    if (event === "issue_comment") {
      const parsed = issueCommentWebhookSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid GitHub issue_comment payload", issues: parsed.error.issues });
      }

      if (parsed.data.action !== "created") {
        return { ignored: true, reason: `Unsupported issue_comment action ${parsed.data.action}` };
      }

      const commentBody = parsed.data.comment.body ?? "";
      const commentAuthor = parsed.data.comment.user?.login ?? parsed.data.sender?.login ?? "unknown";

      if (parsed.data.issue.pull_request) {
        const task = (await services.tasks.listTasks()).find(
          (candidate) =>
            candidate.prUrl === parsed.data.issue.html_url ||
            candidate.prUrl?.endsWith(`/pull/${parsed.data.issue.number}`) ||
            candidate.branchName === parsed.data.issue.title
        );

        if (!task) {
          return { ignored: true, reason: `No tracked task found for PR ${parsed.data.issue.html_url}` };
        }

        if (isBotActor(commentAuthor)) {
          return { ignored: true, reason: "Ignored bot PR comment" };
        }

        if (!["WAITING_MERGE", "HUMAN_REVIEW", "BLOCKED"].includes(task.status)) {
          return { ignored: true, reason: `Task ${task.id} is not waiting for PR feedback` };
        }

        const updated = await services.tasks.updateTask(task.id, {
          issue: {
            ...task.issue,
            comments: [
              ...task.issue.comments,
              {
                author: commentAuthor,
                body: commentBody,
                createdAt: parsed.data.comment.created_at ?? new Date().toISOString()
              }
            ]
          },
          updatedAt: new Date().toISOString()
        });
        await services.tasks.appendEvent(
          createTaskEvent({
            taskId: task.id,
            type: "PR_REVIEW_COMMENT_RECEIVED",
            message: `PR feedback received from ${commentAuthor}`,
            metadata: {
              commentUrl: parsed.data.comment.html_url ?? null,
              commentId: parsed.data.comment.id ?? null,
              prUrl: parsed.data.issue.html_url
            }
          })
        );
        await enqueueIssueWorkflow(updated.id, `${updated.id}-pr-comment-${parsed.data.comment.id ?? Date.now()}`);
        return reply.code(202).send({ task: updated, trigger: "pr_comment", reason: "Queued same-PR feedback iteration" });
      }

      const labels = parsed.data.issue.labels.map((label) => label.name ?? "").filter(Boolean);
      const repository = findRepository(services.config, parsed.data.repository.owner.login, parsed.data.repository.name);
      const decision = evaluateRepositoryTrigger({
        repository,
        eventName: "issue_comment",
        action: parsed.data.action,
        labels,
        commentBody,
        actor: parsed.data.comment.user?.login ?? parsed.data.sender?.login,
        fallbackMention: process.env.AGENT_TRIGGER_MENTION ?? "@agent-prd"
      });

      if (!decision.shouldTrigger) {
        return { ignored: true, reason: decision.reason, trigger: decision.trigger, mention: decision.mention };
      }

      const task = await createAndEnqueueTask({
        provider: "github",
        owner: parsed.data.repository.owner.login,
        repo: parsed.data.repository.name,
        number: parsed.data.issue.number,
        url: parsed.data.issue.html_url,
        title: parsed.data.issue.title,
        body: parsed.data.issue.body ?? "",
        labels,
        comments: [
          {
            author: parsed.data.comment.user?.login ?? "unknown",
            body: commentBody,
            createdAt: parsed.data.comment.created_at ?? new Date().toISOString()
          }
        ],
        baseBranch: parsed.data.repository.default_branch
      });

      return reply.code(202).send({ task, trigger: decision.trigger, reason: decision.reason, mention: decision.mention });
    }

    return { ignored: true, reason: `Unsupported event ${String(event)}` };
  });
}

function isBotActor(actor: string): boolean {
  return actor.endsWith("[bot]") || actor === "github-actions" || actor === "dependabot";
}

function verifyGitHubSignature(request: FastifyRequest, body: string, secret: string): boolean {
  const signature = request.headers["x-hub-signature-256"];

  if (typeof signature !== "string" || !signature.startsWith("sha256=")) {
    return false;
  }

  const digest = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const signatureBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);

  return signatureBuffer.length === digestBuffer.length && timingSafeEqual(signatureBuffer, digestBuffer);
}
