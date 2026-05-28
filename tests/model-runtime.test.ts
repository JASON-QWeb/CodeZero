import { describe, expect, it, vi } from "vitest";
import {
  AgentRunner,
  createModelRuntimeProviders,
  parseJsonObject,
  runJsonAgent,
  type AgentDefinition,
} from "@agent/model-runtime";
import type { AppConfig } from "@agent/config";

const agent: AgentDefinition = {
  id: "implementation",
  role: "main-implementation",
  providerId: "test-provider",
  systemPrompt: "You are a test agent.",
  skillRefs: [],
  tools: [],
  guardrails: [],
};

describe("model runtime", () => {
  it("parses raw and fenced JSON objects", () => {
    expect(parseJsonObject('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonObject("```json\n{\"name\":\"agent\"}\n```")).toEqual({
      name: "agent",
    });
    expect(() => parseJsonObject("[1,2,3]")).toThrow(
      "Agent response was not a JSON object",
    );
  });

  it("repairs raw control characters inside JSON strings", () => {
    const response = `{"summary":"repair","unifiedDiff":"diff --git a/a b/a
@@ -1 +1 @@
-old
+new"}`;

    expect(parseJsonObject(response)).toEqual({
      summary: "repair",
      unifiedDiff: "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new",
    });
  });

  it("repairs common trailing commas in JSON-like agent responses", () => {
    expect(
      parseJsonObject(
        '{"summary":"ok","actions":[{"tool":"repo.read_file","input":{"path":"src/a.ts","maxBytes":128,},}],}',
      ),
    ).toEqual({
      summary: "ok",
      actions: [
        {
          tool: "repo.read_file",
          input: {
            path: "src/a.ts",
            maxBytes: 128,
          },
        },
      ],
    });
  });

  it("repairs comments outside strings in JSON-like agent responses", () => {
    const response = `{
      // implementation summary
      "summary": "ok // keep string content",
      "actions": [
        {"tool": "repo.read_file", /* inline comment */ "input": {"path": "src/a.ts", "maxBytes": 64}}
      ],
    }`;

    expect(parseJsonObject(response)).toEqual({
      summary: "ok // keep string content",
      actions: [
        {
          tool: "repo.read_file",
          input: {
            path: "src/a.ts",
            maxBytes: 64,
          },
        },
      ],
    });
  });

  it("runs JSON agents through the selected provider", async () => {
    const runner = new AgentRunner(
      new Map([
        [
          "test-provider",
          {
            id: "test-provider",
            generate: vi
              .fn()
              .mockResolvedValue({ content: "{\"files\":[\"src/a.ts\"]}", raw: {} }),
          },
        ],
      ]),
    );

    await expect(
      runJsonAgent({ runner, agent, userPrompt: "Plan", context: { issue: "demo" } }),
    ).resolves.toEqual({
      files: ["src/a.ts"],
    });
  });

  it("repairs invalid JSON agent responses with one follow-up call", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        content: '{"approved": false, "blockingFindings": [{"title" "missing colon"}]}',
        raw: {},
      })
      .mockResolvedValueOnce({
        content: '{"approved":false,"blockingFindings":[{"title":"missing colon"}]}',
        raw: {},
      });
    const runner = new AgentRunner(
      new Map([
        [
          "test-provider",
          {
            id: "test-provider",
            generate,
          },
        ],
      ]),
    );

    await expect(
      runJsonAgent({ runner, agent, userPrompt: "Review", context: { issue: "demo" } }),
    ).resolves.toEqual({
      approved: false,
      blockingFindings: [{ title: "missing colon" }],
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0].messages.at(-1)?.content).toContain(
      "The previous response was invalid JSON",
    );
  });

  it("validates provider env and unresolved placeholders before creating providers", () => {
    const config = createConfig();

    expect(() => createModelRuntimeProviders(config, {})).toThrow(
      "TEST_API_KEY is required for provider default",
    );

    expect(() =>
      createModelRuntimeProviders(
        {
          ...config,
          agents: {
            ...config.agents,
            providers: {
              default: {
                ...config.agents.providers.default,
                model: "${OPENAI_MODEL}",
              },
            },
          },
        },
        { TEST_API_KEY: "secret" },
      ),
    ).toThrow("Provider default has unresolved environment placeholders");
  });
});

function createConfig(): AppConfig {
  return {
    rootDir: process.cwd(),
    agents: {
      providers: {
        default: {
          type: "openai-compatible",
          base_url: "https://api.example.test/v1",
          api_key_env: "TEST_API_KEY",
          model: "test-model",
          supports_tools: true,
          supports_structured_output: true,
          coding_executor: {
            mode: "auto",
            options: {},
            model_options: {},
            env: {},
          },
        },
      },
      agents: {},
    },
    repositories: [],
    sandbox: {
      mode: "worktree",
      image: "agent-sandbox-node:latest",
      root_dir: "./sandboxes",
      network: { allow: [] },
      limits: {
        max_runtime_minutes: 90,
        max_diff_files: 30,
        max_diff_lines: 1200,
        max_quality_gate_retries: 6,
      },
      implementation_executor: {
        mode: "cli",
        name: "codezero-coding-cli",
        command: "opencode run test",
        timeout_ms: 60_000,
        env: {},
      },
    },
    policies: [],
    tools: [],
    storage: {
      driver: "file",
      filePath: "data/tasks.json",
    },
    memory: {
      filePath: "data/memory.json",
    },
    github: {},
  };
}
