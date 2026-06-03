import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findWorkspaceRoot,
  interpolateEnv,
  isConfigSectionName,
  loadAppConfig,
  loadEditableConfig,
  parseConfigSection,
  readConfigSection,
  updateRepositoryRuntimeSettings,
  writeConfigSection
} from "@agent/config";

describe("app config loading", () => {
  it("loads repository and runtime configuration from examples", async () => {
    const config = await loadAppConfig(process.cwd());

    expect(config.repositories[0]?.trigger.mode).toBe("mention");
    expect(config.repositories[0]?.codebase_intelligence.codegraph.enabled).toBe(true);
    expect(config.repositories[0]?.codebase_intelligence.codegraph.init_args).toContain("--index");
    expect(config.repositories[0]?.queue.max_concurrent_issues).toBe(2);
    expect(config.repositories[0]?.workflow.require_prd_review).toBe(true);
    expect(config.sandbox.implementation_executor?.mode).toBe("cli");
    expect(config.sandbox.implementation_executor?.name).toBe("codezero-coding-cli");
    expect(config.sandbox.filesystem.allow_repo_only).toBe(true);
    expect(config.sandbox.docker.memory).toBe("4g");
    expect(config.memory.filePath).toContain("memory.json");
    expect(config.memory.maxRecords).toBeGreaterThan(0);
    expect(config.workflowGraph.checkpointFilePath).toContain("langgraph-checkpoints.json");
  });

  it("resolves relative file storage env paths from the project root", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-storage-"));
    await writeCodeZeroConfig(dir);
    const previousTaskStore = process.env.TASK_STORE_FILE;
    const previousMemoryStore = process.env.MEMORY_STORE_FILE;
    const previousCheckpointFile = process.env.LANGGRAPH_CHECKPOINT_FILE;
    process.env.TASK_STORE_FILE = "data/custom-tasks.json";
    process.env.MEMORY_STORE_FILE = "data/custom-memory.json";
    process.env.LANGGRAPH_CHECKPOINT_FILE = "data/custom-checkpoints.json";

    try {
      const config = await loadAppConfig(dir);

      expect(config.storage.filePath).toBe(path.join(dir, "data", "custom-tasks.json"));
      expect(config.memory.filePath).toBe(path.join(dir, "data", "custom-memory.json"));
      expect(config.workflowGraph.checkpointFilePath).toBe(
        path.join(dir, "data", "custom-checkpoints.json"),
      );
    } finally {
      if (previousTaskStore === undefined) {
        delete process.env.TASK_STORE_FILE;
      } else {
        process.env.TASK_STORE_FILE = previousTaskStore;
      }
      if (previousMemoryStore === undefined) {
        delete process.env.MEMORY_STORE_FILE;
      } else {
        process.env.MEMORY_STORE_FILE = previousMemoryStore;
      }
      if (previousCheckpointFile === undefined) {
        delete process.env.LANGGRAPH_CHECKPOINT_FILE;
      } else {
        process.env.LANGGRAPH_CHECKPOINT_FILE = previousCheckpointFile;
      }
    }
  });

  it("loads project .env values before parsing YAML placeholders", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-env-"));
    await mkdir(path.join(dir, "config"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(dir, ".env"),
        [
          "CONFIG_ENV_BASE_URL=https://env-provider.example.test/v1",
          "CONFIG_ENV_MODEL=env-model",
          "CONFIG_ENV_API_KEY=env-key",
          "TASK_STORE_FILE=data/env-tasks.json",
          ""
        ].join("\n")
      ),
      writeCodeZeroConfig(dir, {
        agents: [
          "providers:",
          "  default:",
          "    type: openai-compatible",
          "    base_url: ${CONFIG_ENV_BASE_URL}",
          "    api_key_env: CONFIG_ENV_API_KEY",
          "    model: ${CONFIG_ENV_MODEL}",
          "agents:",
          "  prd:",
          "    provider: default",
          "    system_prompt: prompts/system/prd-agent.md",
          ""
        ].join("\n")
      })
    ]);
    const previousBaseUrl = process.env.CONFIG_ENV_BASE_URL;
    const previousModel = process.env.CONFIG_ENV_MODEL;
    const previousApiKey = process.env.CONFIG_ENV_API_KEY;
    const previousTaskStore = process.env.TASK_STORE_FILE;
    delete process.env.CONFIG_ENV_BASE_URL;
    delete process.env.CONFIG_ENV_MODEL;
    delete process.env.CONFIG_ENV_API_KEY;
    delete process.env.TASK_STORE_FILE;

    try {
      const config = await loadAppConfig(dir);

      expect(config.agents.providers.default?.base_url).toBe("https://env-provider.example.test/v1");
      expect(config.agents.providers.default?.model).toBe("env-model");
      expect(process.env.CONFIG_ENV_API_KEY).toBe("env-key");
      expect(config.storage.filePath).toBe(path.join(dir, "data", "env-tasks.json"));
    } finally {
      restoreEnv("CONFIG_ENV_BASE_URL", previousBaseUrl);
      restoreEnv("CONFIG_ENV_MODEL", previousModel);
      restoreEnv("CONFIG_ENV_API_KEY", previousApiKey);
      restoreEnv("TASK_STORE_FILE", previousTaskStore);
    }
  });

  it("loads GitHub App credentials from project .env", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-github-app-"));
    await writeCodeZeroConfig(dir);
    await writeFile(
      path.join(dir, ".env"),
      [
        "GITHUB_APP_ID=12345",
        "GITHUB_APP_INSTALLATION_ID=67890",
        "GITHUB_APP_PRIVATE_KEY_PATH=secrets/codezero-app.pem",
        "GITHUB_TOKEN=",
        ""
      ].join("\n")
    );
    const previousAppId = process.env.GITHUB_APP_ID;
    const previousInstallationId = process.env.GITHUB_APP_INSTALLATION_ID;
    const previousPrivateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    const previousToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    delete process.env.GITHUB_TOKEN;

    try {
      const config = await loadAppConfig(dir);

      expect(config.github.token).toBeUndefined();
      expect(config.github.app).toMatchObject({
        appId: "12345",
        installationId: "67890",
        privateKeyPath: path.join(dir, "secrets", "codezero-app.pem")
      });
    } finally {
      restoreEnv("GITHUB_APP_ID", previousAppId);
      restoreEnv("GITHUB_APP_INSTALLATION_ID", previousInstallationId);
      restoreEnv("GITHUB_APP_PRIVATE_KEY_PATH", previousPrivateKeyPath);
      restoreEnv("GITHUB_TOKEN", previousToken);
    }
  });

  it("validates and writes editable config sections", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-"));
    await writeCodeZeroConfig(dir);
    const content = [
      "providers:",
      "  simple:",
      "    type: openai-compatible",
      "    base_url: https://api.deepseek.com",
      "    api_key_env: DEEPSEEK_API_KEY",
      "    model: deepseek-chat",
      "agents:",
      "  prd:",
      "    provider: simple",
      "    system_prompt: prompts/system/prd-agent.md",
      "    skills:",
      "      - draft-prd",
      ""
    ].join("\n");

    const saved = await writeConfigSection(dir, "agents", content);
    const reloaded = await readConfigSection(dir, "agents");

    expect(saved.exists).toBe(true);
    expect(reloaded.content).toContain("deepseek-chat");
    expect(parseConfigSection("agents", content)).toMatchObject({
      providers: {
        simple: {
          model: "deepseek-chat"
        }
      }
    });
    expect(() => parseConfigSection("agents", "providers: []")).toThrow();

    await writeConfigSection(
      dir,
      "workflow_graph",
      "workflow_graph:\n  checkpoint_file: data/custom-checkpoints.json\n",
    );
    const workflowGraph = await readConfigSection(dir, "workflow_graph");
    expect(workflowGraph.content).toContain("custom-checkpoints.json");
  });

  it("parses optional coding executor provider overrides", () => {
    const parsed = parseConfigSection(
      "agents",
      [
        "providers:",
        "  default:",
        "    type: openai-compatible",
        "    base_url: https://api.example.test/v1",
        "    api_key_env: TEST_API_KEY",
        "    model: planner-model",
        "    coding_executor:",
        "      mode: native",
        "      provider_id: anthropic",
        "      model: claude-sonnet-4-5",
        "      env:",
        "        ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}",
        "agents:",
        "  implementation:",
        "    provider: default",
        "    system_prompt: prompts/system/main-agent.md",
        ""
      ].join("\n")
    ) as {
      providers: {
        default: {
          coding_executor?: {
            mode: string;
            provider_id?: string;
            model?: string;
            env: Record<string, string>;
          };
        };
      };
    };

    expect(parsed.providers.default.coding_executor?.mode).toBe("native");
    expect(parsed.providers.default.coding_executor?.provider_id).toBe("anthropic");
    expect(parsed.providers.default.coding_executor?.model).toBe("claude-sonnet-4-5");
  });

  it("interpolates environment placeholders without hiding unresolved values", () => {
    process.env.AGENT_CONFIG_TEST_VALUE = "resolved";

    expect(interpolateEnv("token=${AGENT_CONFIG_TEST_VALUE} missing=${NOT_DEFINED_FOR_TEST}")).toBe("token=resolved missing=${NOT_DEFINED_FOR_TEST}");
    expect(isConfigSectionName("repositories")).toBe(true);
    expect(isConfigSectionName("workflow_graph")).toBe(true);
    expect(isConfigSectionName("nope")).toBe(false);
  });

  it("applies repository runtime settings through the editable config module", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-runtime-"));
    await writeCodeZeroConfig(dir, {
      agents: [
        "providers:",
        "  simple:",
        "    type: openai-compatible",
        "    base_url: https://api.example.test",
        "    api_key_env: API_KEY",
        "    model: test-model",
        "agents:",
        "  prd:",
        "    provider: simple",
        "    system_prompt: prompts/prd.md",
        ""
      ].join("\n"),
      repositories: [
        "repositories:",
        "  - id: demo",
        "    github_owner: acme",
        "    github_repo: shop",
        "    trigger:",
        "      mode: mention",
        "      mention: '@agent-prd'",
        ""
      ].join("\n")
    });

    const snapshot = await loadEditableConfig(dir);
    const updated = await updateRepositoryRuntimeSettings(dir, "demo", {
      triggerMode: "label",
      mention: "   ",
      maxConcurrentIssues: 3,
    });
    const written = await readFile(path.join(dir, "config", "codezero.yaml"), "utf8");

    expect(snapshot.sections.find((section) => section.section === "repositories")?.exists).toBe(true);
    expect(updated.exists).toBe(true);
    expect(written).toContain("mode: label");
    expect(written).toContain("max_concurrent_issues: 3");
    expect((updated.parsed as { repositories: Array<{ trigger: { mention: string } }> }).repositories[0]?.trigger.mention).toBe("@agent-prd");
  });

  it("finds the workspace root from nested directories and validates provider refs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-root-"));
    const nested = path.join(dir, "apps", "api");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages: []\n");

    await expect(findWorkspaceRoot(nested)).resolves.toBe(dir);
    expect(() =>
      parseConfigSection(
        "agents",
        [
          "providers:",
          "  simple:",
          "    type: openai-compatible",
          "    base_url: https://api.example.test",
          "    api_key_env: API_KEY",
          "    model: test-model",
          "agents:",
          "  prd:",
          "    provider: missing",
          "    system_prompt: prompts/prd.md",
          ""
        ].join("\n")
      )
    ).toThrow("Unknown provider");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function writeCodeZeroConfig(
  rootDir: string,
  sections: {
    agents?: string;
    repositories?: string;
    sandbox?: string;
    workflowGraph?: string;
  } = {}
): Promise<void> {
  await mkdir(path.join(rootDir, "config"), { recursive: true });
  await writeFile(
    path.join(rootDir, "config", "codezero.yaml"),
    [
      sections.agents ??
        [
          "providers:",
          "  default:",
          "    type: openai-compatible",
          "    base_url: https://api.example.test/v1",
          "    api_key_env: TEST_API_KEY",
          "    model: test-model",
          "agents:",
          "  prd:",
          "    provider: default",
          "    system_prompt: prompts/system/prd-agent.md",
          ""
        ].join("\n"),
      sections.repositories ?? "repositories: []\n",
      sections.sandbox ?? "sandbox: {}\n",
      sections.workflowGraph ??
        "workflow_graph:\n  checkpoint_file: data/langgraph-checkpoints.json\n"
    ].join("\n")
  );
}
