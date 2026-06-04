import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { resetServicesForTests } from "../apps/api/src/services/task-services.js";

describe("api auth", () => {
  afterEach(() => {
    delete process.env.CODEZERO_API_TOKEN;
    delete process.env.API_AUTH_TOKEN;
    resetServicesForTests();
  });

  it("protects REST endpoints when an API token is configured", async () => {
    process.env.CODEZERO_API_TOKEN = "server-token";
    const app = await buildServer();

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/settings/config",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const authenticated = await app.inject({
      method: "GET",
      url: "/settings/config",
      headers: { authorization: "Bearer server-token" },
    });
    expect(authenticated.statusCode).toBe(200);

    await app.close();
  });

  it("leaves health checks and GitHub webhooks outside REST API auth", async () => {
    process.env.CODEZERO_API_TOKEN = "server-token";
    const app = await buildServer();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const webhook = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "x-github-event": "unsupported" },
      payload: {},
    });
    expect(webhook.json<{ message?: string }>().message).not.toBe(
      "Unauthorized",
    );

    await app.close();
  });
});
