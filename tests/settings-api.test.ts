import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";

describe("settings api", () => {
  afterEach(() => {
    delete process.env.PROJECT_ROOT;
    delete process.env.TEST_MODEL_API_KEY;
  });

  it("returns editable config sections and validates YAML without writing", async () => {
    const app = await buildServer();

    const list = await app.inject({ method: "GET", url: "/settings/config" });
    expect(list.statusCode).toBe(200);
    expect(
      list
        .json<{ sections: Array<{ section: string }> }>()
        .sections.map((section) => section.section),
    ).toContain("agents");

    const valid = await app.inject({
      method: "POST",
      url: "/settings/config/agents/validate",
      payload: {
        content: [
          "providers:",
          "  qwen:",
          "    type: openai-compatible",
          "    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1",
          "    api_key_env: QWEN_API_KEY",
          "    model: qwen3.5",
          "agents:",
          "  implementation:",
          "    provider: qwen",
          "    system_prompt: prompts/system/main-agent.md",
          "    skills:",
          "      - implementation-scope-planner",
          "",
        ].join("\n"),
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json<{ valid: boolean }>().valid).toBe(true);

    const invalid = await app.inject({
      method: "POST",
      url: "/settings/config/repositories/validate",
      payload: { content: "repositories: bad" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ valid: boolean }>().valid).toBe(false);

    await app.close();
  });

  it("validates OpenAI-compatible provider credentials with a minimal chat completion", async () => {
    const modelServer = await startModelServer();
    const app = await buildServer();
    process.env.TEST_MODEL_API_KEY = "server-env-key";

    const valid = await app.inject({
      method: "POST",
      url: "/settings/providers/validate",
      payload: {
        providerId: "qwen",
        content: [
          "providers:",
          "  qwen:",
          "    type: openai-compatible",
          `    base_url: ${modelServer.baseUrl}`,
          "    api_key_env: TEST_MODEL_API_KEY",
          "    model: qwen3.5",
          "agents:",
          "  prd:",
          "    provider: qwen",
          "    system_prompt: prompts/system/prd-agent.md",
          "",
        ].join("\n"),
      },
    });

    expect(valid.statusCode).toBe(200);
    expect(
      valid.json<{
        valid: boolean;
        usedApiKeySource: string;
        statusCode: number;
      }>().valid,
    ).toBe(true);
    expect(
      valid.json<{
        valid: boolean;
        usedApiKeySource: string;
        statusCode: number;
      }>().usedApiKeySource,
    ).toBe("env");
    expect(
      valid.json<{
        valid: boolean;
        usedApiKeySource: string;
        statusCode: number;
      }>().statusCode,
    ).toBe(200);

    delete process.env.TEST_MODEL_API_KEY;
    const oneTimeKey = await app.inject({
      method: "POST",
      url: "/settings/providers/validate",
      payload: {
        providerId: "qwen",
        apiKey: "server-env-key",
        content: [
          "providers:",
          "  qwen:",
          "    type: openai-compatible",
          `    base_url: ${modelServer.baseUrl}`,
          "    api_key_env: TEST_MODEL_API_KEY",
          "    model: qwen3.5",
          "agents:",
          "  prd:",
          "    provider: qwen",
          "    system_prompt: prompts/system/prd-agent.md",
          "",
        ].join("\n"),
      },
    });

    expect(oneTimeKey.statusCode).toBe(200);
    expect(
      oneTimeKey.json<{ valid: boolean; usedApiKeySource: string }>().valid,
    ).toBe(true);
    expect(
      oneTimeKey.json<{ valid: boolean; usedApiKeySource: string }>()
        .usedApiKeySource,
    ).toBe("request");

    const missing = await app.inject({
      method: "POST",
      url: "/settings/providers/validate",
      payload: {
        providerId: "qwen",
        content: [
          "providers:",
          "  qwen:",
          "    type: openai-compatible",
          `    base_url: ${modelServer.baseUrl}`,
          "    api_key_env: MISSING_MODEL_API_KEY",
          "    model: qwen3.5",
          "agents:",
          "  prd:",
          "    provider: qwen",
          "    system_prompt: prompts/system/prd-agent.md",
          "",
        ].join("\n"),
      },
    });

    expect(missing.statusCode).toBe(200);
    expect(
      missing.json<{ valid: boolean; usedApiKeySource: string }>().valid,
    ).toBe(false);
    expect(
      missing.json<{ valid: boolean; usedApiKeySource: string }>()
        .usedApiKeySource,
    ).toBe("missing");

    await app.close();
    await modelServer.close();
  });

  it("updates repository runtime settings without requiring manual YAML edits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-settings-api-"));
    await mkdir(path.join(dir, "config"), { recursive: true });
    await writeFile(
      path.join(dir, "config", "repositories.yaml"),
      [
        "repositories:",
        "  - id: shop",
        "    github_owner: acme",
        "    github_repo: shop",
        "    trigger:",
        "      mode: mention",
        '      mention: "@agent-prd"',
        "    queue:",
        "      max_concurrent_issues: 1",
        "",
      ].join("\n"),
    );
    process.env.PROJECT_ROOT = dir;
    const app = await buildServer();

    const response = await app.inject({
      method: "PUT",
      url: "/settings/repositories/shop/runtime",
      payload: {
        triggerMode: "label",
        mention: "@repo-agent",
        maxConcurrentIssues: 3,
        allowedPermissions: ["read", "repo_write"],
        blockedPermissions: ["dangerous"],
      },
    });
    const body = response.json<{
      parsed: {
        repositories: Array<{
          trigger: { mode: string; mention: string };
          queue: { max_concurrent_issues: number };
          permissions: {
            allowed_permissions: string[];
            blocked_permissions: string[];
          };
        }>;
      };
    }>();
    const repository = body.parsed.repositories[0];

    expect(response.statusCode).toBe(200);
    expect(repository?.trigger.mode).toBe("label");
    expect(repository?.trigger.mention).toBe("@repo-agent");
    expect(repository?.queue.max_concurrent_issues).toBe(3);
    expect(repository?.permissions.allowed_permissions).toEqual([
      "read",
      "repo_write",
    ]);
    expect(repository?.permissions.blocked_permissions).toEqual(["dangerous"]);

    await app.close();
  });
});

async function startModelServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
    const authHeader = request.headers.authorization;

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end("not found");
      return;
    }

    if (authHeader !== "Bearer server-env-key") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid key" } }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Model test server did not start on a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
