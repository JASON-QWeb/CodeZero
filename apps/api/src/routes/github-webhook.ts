import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { evaluateRepositoryTrigger, findRepository } from "@agent/config";
import { z } from "zod";
import { createAndEnqueueTask, getServices } from "../services/task-services.js";

const issueSchema = z.object({
  number: z.number(),
  html_url: z.string().url(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.object({ name: z.string().nullable() })).default([])
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
    body: z.string().nullable(),
    user: z.object({ login: z.string().optional() }).nullable().optional(),
    html_url: z.string().url().optional(),
    created_at: z.string().optional()
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

    if (event === "issue_comment") {
      const parsed = issueCommentWebhookSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid GitHub issue_comment payload", issues: parsed.error.issues });
      }

      if (parsed.data.action !== "created") {
        return { ignored: true, reason: `Unsupported issue_comment action ${parsed.data.action}` };
      }

      const commentBody = parsed.data.comment.body ?? "";
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
