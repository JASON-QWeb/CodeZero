import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createAndEnqueueTask, getServices } from "../services/task-services.js";

const issueWebhookSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number(),
    html_url: z.string().url(),
    title: z.string(),
    body: z.string().nullable(),
    labels: z.array(z.object({ name: z.string().nullable() })).default([])
  }),
  repository: z.object({
    name: z.string(),
    owner: z.object({
      login: z.string()
    }),
    default_branch: z.string()
  })
});

export async function registerGitHubWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/github", async (request, reply) => {
    const services = await getServices();
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});

    if (services.config.github.webhookSecret && !verifyGitHubSignature(request, rawBody, services.config.github.webhookSecret)) {
      return reply.code(401).send({ message: "Invalid GitHub signature" });
    }

    const event = request.headers["x-github-event"];

    if (event !== "issues") {
      return { ignored: true, reason: `Unsupported event ${String(event)}` };
    }

    const parsed = issueWebhookSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid GitHub webhook payload", issues: parsed.error.issues });
    }

    if (!["opened", "labeled", "reopened"].includes(parsed.data.action)) {
      return { ignored: true, reason: `Unsupported issue action ${parsed.data.action}` };
    }

    const task = await createAndEnqueueTask({
      provider: "github",
      owner: parsed.data.repository.owner.login,
      repo: parsed.data.repository.name,
      number: parsed.data.issue.number,
      url: parsed.data.issue.html_url,
      title: parsed.data.issue.title,
      body: parsed.data.issue.body ?? "",
      labels: parsed.data.issue.labels.map((label) => label.name ?? "").filter(Boolean),
      comments: [],
      baseBranch: parsed.data.repository.default_branch
    });

    return reply.code(202).send({ task });
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
