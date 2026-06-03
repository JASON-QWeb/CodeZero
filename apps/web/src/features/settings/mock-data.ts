import type {
  ConfigResponse,
  ConfigSection,
  ConfigSectionName,
  ProviderApiKeySaveResponse,
  ProviderValidationResponse,
  RepositoryRuntimeSettingsInput,
  ValidationResponse,
} from "./types";

type MockSection = ConfigSection & {
  parsed: Record<string, unknown>;
};

let sectionsState = createSections();

export async function mockFetchConfig(): Promise<ConfigResponse> {
  return {
    rootDir: "/workspace/codezero",
    sections: clone(sectionsState),
  };
}

export async function mockValidateConfig(input: {
  section: ConfigSectionName;
  content: string;
}): Promise<ValidationResponse> {
  return {
    section: input.section,
    valid: true,
    parsed: sectionFor(input.section).parsed,
    message: "Mock data mode: YAML validation simulated successfully.",
  };
}

export async function mockSaveConfig(input: {
  section: ConfigSectionName;
  content: string;
}): Promise<ConfigSection> {
  sectionsState = sectionsState.map((section) =>
    section.section === input.section
      ? {
          ...section,
          content: input.content,
          updatedAt: "2026-06-02T07:45:00.000Z",
        }
      : section,
  );
  return clone(sectionFor(input.section));
}

export async function mockValidateProviderConnection(input: {
  providerId: string;
}): Promise<ProviderValidationResponse> {
  return {
    providerId: input.providerId,
    valid: true,
    message: "Mock data mode: provider connection looks healthy.",
    baseUrl: "https://api.example.invalid/v1",
    model: "codezero-agent-pro",
    statusCode: 200,
    latencyMs: 184,
    usedApiKeySource: "request",
  };
}

export async function mockSaveProviderApiKey(input: {
  providerId: string;
}): Promise<ProviderApiKeySaveResponse> {
  return {
    providerId: input.providerId,
    apiKeyEnv: "OPENAI_API_KEY",
    saved: true,
    message: "Mock data mode: API key was not stored.",
  };
}

export async function mockUpdateRepositoryRuntimeSettings(
  input: RepositoryRuntimeSettingsInput,
): Promise<ConfigSection> {
  const repositoriesSection = sectionFor("repositories");
  const parsed = clone(repositoriesSection.parsed) as {
    repositories?: Array<Record<string, unknown>>;
  };
  parsed.repositories = (parsed.repositories ?? []).map((repository) =>
    repository.id === input.repositoryId
      ? {
          ...repository,
          project_skill_path: input.projectSkillPath,
          project_rule_path: input.projectRulePath,
          trigger: {
            mode: input.triggerMode,
            mention: input.mention,
          },
          queue: {
            max_concurrent_issues: input.maxConcurrentIssues,
          },
        }
      : repository,
  );
  const nextSection: MockSection = {
    ...repositoriesSection,
    content: repositoriesYaml(parsed.repositories ?? []),
    parsed,
    updatedAt: "2026-06-02T07:45:00.000Z",
  };
  sectionsState = sectionsState.map((section) =>
    section.section === "repositories" ? nextSection : section,
  );
  return clone(nextSection);
}

function createSections(): MockSection[] {
  return [
    section("agents", agentsYaml(), {
      providers: {
        default: {
          type: "openai-compatible",
          base_url: "${OPENAI_BASE_URL}",
          api_key_env: "OPENAI_API_KEY",
          model: "codezero-agent-pro",
          supports_structured_output: true,
        },
      },
      agents: {
        prd: { provider: "default" },
        implementation: { provider: "default" },
        review: { provider: "default" },
      },
    }),
    section("repositories", repositoriesYaml(seedRepositories()), {
      repositories: seedRepositories(),
    }),
    section("sandbox", sandboxYaml(), {
      sandbox: {
        mode: "worktree",
        image: "agent-sandbox-node:local",
        root_dir: "./sandboxes",
      },
    }),
    section("memory", memoryYaml(), {
      memory: {
        max_records: 500,
        max_bytes: 2_000_000,
        max_record_bytes: 16_000,
      },
    }),
    section("workflow_graph", workflowGraphYaml(), {
      workflow_graph: {
        checkpoint_file: "data/langgraph-checkpoints.json",
      },
    }),
  ];
}

function seedRepositories(): Array<Record<string, unknown>> {
  return [
    {
      id: "JASON-QWeb/CodeZero",
      github_owner: "JASON-QWeb",
      github_repo: "CodeZero",
      default_branch: "main",
      project_skill_path: ".agent",
      project_rule_path: ".agent/rules",
      trigger: { mode: "mention", mention: "@agent-prd" },
      queue: { max_concurrent_issues: 3 },
    },
    {
      id: "JASON-QWeb/BeautySkillsHub",
      github_owner: "JASON-QWeb",
      github_repo: "BeautySkillsHub",
      default_branch: "main",
      project_skill_path: ".agent",
      project_rule_path: ".agent/rules",
      trigger: { mode: "label", mention: "@agent-prd" },
      queue: { max_concurrent_issues: 2 },
    },
  ];
}

function section(
  sectionName: ConfigSectionName,
  content: string,
  parsed: Record<string, unknown>,
): MockSection {
  return {
    section: sectionName,
    path: `mock://config/${sectionName}.yaml`,
    templatePath: `mock://config/${sectionName}.example.yaml`,
    exists: true,
    content,
    parsed,
    updatedAt: "2026-06-02T07:45:00.000Z",
  };
}

function sectionFor(sectionName: ConfigSectionName): MockSection {
  const section = sectionsState.find((item) => item.section === sectionName);

  if (!section) {
    throw new Error(`Mock settings section '${sectionName}' is unavailable`);
  }

  return section;
}

function agentsYaml(): string {
  return [
    "providers:",
    "  default:",
    "    type: openai-compatible",
    "    base_url: ${OPENAI_BASE_URL}",
    "    api_key_env: OPENAI_API_KEY",
    "    model: codezero-agent-pro",
    "    supports_structured_output: true",
    "",
    "agents:",
    "  prd:",
    "    provider: default",
    "  implementation:",
    "    provider: default",
    "  review:",
    "    provider: default",
    "",
  ].join("\n");
}

function repositoriesYaml(repositories: Array<Record<string, unknown>>): string {
  const lines = ["repositories:"];

  for (const repository of repositories) {
    const trigger = repository.trigger as Record<string, unknown>;
    const queue = repository.queue as Record<string, unknown>;
    lines.push(
      `  - id: ${repository.id}`,
      `    github_owner: ${repository.github_owner}`,
      `    github_repo: ${repository.github_repo}`,
      `    default_branch: ${repository.default_branch}`,
      `    project_skill_path: ${repository.project_skill_path}`,
      `    project_rule_path: ${repository.project_rule_path}`,
      "    trigger:",
      `      mode: ${trigger.mode}`,
      `      mention: ${trigger.mention}`,
      "    queue:",
      `      max_concurrent_issues: ${queue.max_concurrent_issues}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function sandboxYaml(): string {
  return [
    "sandbox:",
    "  mode: worktree",
    "  image: agent-sandbox-node:local",
    "  root_dir: ./sandboxes",
    "  network:",
    "    allow:",
    "      - github.com",
    "      - api.github.com",
    "  filesystem:",
    "    allow_repo_only: true",
    "",
  ].join("\n");
}

function memoryYaml(): string {
  return [
    "memory:",
    "  max_records: 500",
    "  max_bytes: 2000000",
    "  max_record_bytes: 16000",
    "",
  ].join("\n");
}

function workflowGraphYaml(): string {
  return [
    "workflow_graph:",
    "  checkpoint_file: data/langgraph-checkpoints.json",
    "",
  ].join("\n");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
