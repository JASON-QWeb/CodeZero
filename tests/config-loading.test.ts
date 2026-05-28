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
  it("loads repository, tool, and policy configuration from examples", async () => {
    const config = await loadAppConfig(process.cwd());

    expect(config.repositories[0]?.trigger.mode).toBe("mention");
    expect(config.repositories[0]?.codebase_intelligence.codegraph.enabled).toBe(true);
    expect(config.repositories[0]?.codebase_intelligence.codegraph.init_args).toContain("--index");
    expect(config.repositories[0]?.queue.max_concurrent_issues).toBe(2);
    expect(config.repositories[0]?.workflow.require_prd_review).toBe(true);
    expect(config.repositories[0]?.permissions.blocked_permissions).toContain("dangerous");
    expect(config.sandbox.implementation_executor?.mode).toBe("cli");
    expect(config.sandbox.implementation_executor?.name).toBe("codezero-coding-cli");
    expect(config.tools.map((tool) => tool.name)).toContain("repo.apply_patch");
    expect(config.policies.map((policy) => policy.id)).toContain("block-dangerous-shell");
    expect(config.memory.filePath).toContain("memory.json");
  });

  it("resolves relative file storage env paths from the project root", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-storage-"));
    await mkdir(path.join(dir, "config"), { recursive: true });
    await Promise.all(
      ["agents", "repositories", "sandbox", "policies", "tools"].map((section) =>
        writeFile(path.join(dir, "config", `${section}.example.yaml`), section === "repositories" ? "repositories: []\n" : section === "policies" ? "policies: []\n" : section === "tools" ? "tools: []\n" : section === "sandbox" ? "sandbox: {}\n" : "providers: {}\nagents: {}\n")
      )
    );
    const previousTaskStore = process.env.TASK_STORE_FILE;
    const previousMemoryStore = process.env.MEMORY_STORE_FILE;
    process.env.TASK_STORE_FILE = "data/custom-tasks.json";
    process.env.MEMORY_STORE_FILE = "data/custom-memory.json";

    try {
      const config = await loadAppConfig(dir);

      expect(config.storage.filePath).toBe(path.join(dir, "data", "custom-tasks.json"));
      expect(config.memory.filePath).toBe(path.join(dir, "data", "custom-memory.json"));
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
      writeFile(
        path.join(dir, "config", "agents.example.yaml"),
        [
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
      ),
      writeFile(path.join(dir, "config", "repositories.example.yaml"), "repositories: []\n"),
      writeFile(path.join(dir, "config", "sandbox.example.yaml"), "sandbox: {}\n"),
      writeFile(path.join(dir, "config", "policies.example.yaml"), "policies: []\n"),
      writeFile(path.join(dir, "config", "tools.example.yaml"), "tools: []\n")
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

  it("validates and writes editable config sections", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-"));
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
  });

  it("interpolates environment placeholders without hiding unresolved values", () => {
    process.env.AGENT_CONFIG_TEST_VALUE = "resolved";

    expect(interpolateEnv("token=${AGENT_CONFIG_TEST_VALUE} missing=${NOT_DEFINED_FOR_TEST}")).toBe("token=resolved missing=${NOT_DEFINED_FOR_TEST}");
    expect(isConfigSectionName("repositories")).toBe(true);
    expect(isConfigSectionName("nope")).toBe(false);
  });

  it("applies repository runtime settings through the editable config module", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-runtime-"));
    await mkdir(path.join(dir, "config"), { recursive: true });
    await writeFile(
      path.join(dir, "config", "agents.example.yaml"),
      [
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
      ].join("\n")
    );
    await writeFile(
      path.join(dir, "config", "repositories.example.yaml"),
      [
        "repositories:",
        "  - id: demo",
        "    github_owner: acme",
        "    github_repo: shop",
        "    trigger:",
        "      mode: mention",
        "      mention: '@agent-prd'",
        "    permissions:",
        "      allowed_permissions:",
        "        - read",
        ""
      ].join("\n")
    );
    await writeFile(path.join(dir, "config", "sandbox.example.yaml"), "sandbox: {}\n");
    await writeFile(path.join(dir, "config", "policies.example.yaml"), "policies: []\n");
    await writeFile(path.join(dir, "config", "tools.example.yaml"), "tools: []\n");

    const snapshot = await loadEditableConfig(dir);
    const updated = await updateRepositoryRuntimeSettings(dir, "demo", {
      triggerMode: "label",
      mention: "   ",
      maxConcurrentIssues: 3,
      allowedPermissions: ["read", "repo_write"],
      blockedPermissions: ["dangerous"]
    });
    const written = await readFile(path.join(dir, "config", "repositories.yaml"), "utf8");

    expect(snapshot.sections.find((section) => section.section === "repositories")?.exists).toBe(false);
    expect(updated.exists).toBe(true);
    expect(written).toContain("mode: label");
    expect(written).toContain("max_concurrent_issues: 3");
    expect(written).toContain("repo_write");
    expect(written).toContain("dangerous");
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
