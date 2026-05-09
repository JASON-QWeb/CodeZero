import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerGitHubWebhookRoutes } from "./routes/github-webhook.js";
import { registerTaskRoutes } from "./routes/tasks.js";

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const rawBody = body.toString("utf8");
    Object.assign(request, { rawBody });

    try {
      done(null, rawBody ? JSON.parse(rawBody) : {});
    } catch (error) {
      done(error as Error);
    }
  });

  await app.register(cors, {
    origin: true
  });

  app.get("/health", async () => ({
    ok: true,
    service: "agent-prd-api"
  }));

  await registerGitHubWebhookRoutes(app);
  await registerTaskRoutes(app);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4000);
  const app = await buildServer();
  await app.listen({ port, host: "0.0.0.0" });
}
