import type {
  ConfigResponse,
  ConfigSection,
  ConfigSectionName,
  ProviderApiKeySaveResponse,
  ProviderValidationResponse,
  RepositoryRuntimeSettingsInput,
  ValidationResponse,
} from "./types";

type DemoSection = ConfigSection & {
  parsed: Record<string, unknown>;
};

let sectionsState = createSections();

export async function demoFetchConfig(): Promise<ConfigResponse> {
  return {
    rootDir: "/demo/codezero",
    sections: clone(sectionsState),
  };
}

export async function demoValidateConfig(input: {
  section: ConfigSectionName;
  content: string;
}): Promise<ValidationResponse> {
  return {
    section: input.section,
    valid: true,
    parsed: sectionFor(input.section).parsed,
    message: "Demo mode: YAML validation simulated successfully.",
  };
}

export async function demoSaveConfig(input: {
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

export async function demoValidateProviderConnection(input: {
  providerId: string;
}): Promise<ProviderValidationResponse> {
  return {
    providerId: input.providerId,
    valid: true,
    message: "Demo mode: provider connection looks healthy.",
    baseUrl: "https://api.example.invalid/v1",
    model: "demo-agent-pro",
    statusCode: 200,
    latencyMs: 184,
    usedApiKeySource: "request",
  };
}

export async function demoSaveProviderApiKey(input: {
  providerId: string;
}): Promise<ProviderApiKeySaveResponse> {
  return {
    providerId: input.providerId,
    apiKeyEnv: "OPENAI_API_KEY",
    saved: true,
    message: "Demo mode: API key was not stored.",
  };
}

export async function demoUpdateRepositoryRuntimeSettings(
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
          permissions: {
            allowed_permissions: input.allowedPermissions,
            blocked_permissions: input.blockedPermissions,
          },
        }
      : repository,
  );
  const nextSection: DemoSection = {
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

function createSections(): DemoSection[] {
  return [
    section("agents", agentsYaml(), {
      providers: {
        default: {
          type: "openai-compatible",
          base_url: "${OPENAI_BASE_URL}",
          api_key_env: "OPENAI_API_KEY",
          model: "demo-agent-pro",
          supports_tools: true,
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
        image: "agent-sandbox-node:demo",
        root_dir: "./sandboxes",
      },
    }),
    section("policies", policiesYaml(), {
      policies: [
        { id: "block-secret-files", action: "block" },
        { id: "require-demo-sanitization", action: "require_approval" },
      ],
    }),
    section("tools", toolsYaml(), {
      tools: [
        { name: "repo.search", permission: "read" },
        { name: "repo.read_file", permission: "read" },
        { name: "shell.run", permission: "repo_write" },
        { name: "browser.screenshot", permission: "read" },
      ],
    }),
  ];
}

function seedRepositories(): Array<Record<string, unknown>> {
  return [
    {
      id: "demo-labs/nova-commerce",
      github_owner: "demo-labs",
      github_repo: "nova-commerce",
      default_branch: "main",
      project_skill_path: ".agent",
      project_rule_path: ".agent/rules",
      trigger: { mode: "mention", mention: "@agent-prd" },
      queue: { max_concurrent_issues: 3 },
      permissions: {
        allowed_permissions: ["read", "safe_write", "repo_write"],
        blocked_permissions: ["dangerous"],
      },
    },
    {
      id: "demo-labs/atlas-crm",
      github_owner: "demo-labs",
      github_repo: "atlas-crm",
      default_branch: "main",
      project_skill_path: ".agent",
      project_rule_path: ".agent/rules",
      trigger: { mode: "label", mention: "@agent-prd" },
      queue: { max_concurrent_issues: 2 },
      permissions: {
        allowed_permissions: ["read", "safe_write"],
        blocked_permissions: ["external_write", "dangerous"],
      },
    },
    {
      id: "demo-labs/docs-hub",
      github_owner: "demo-labs",
      github_repo: "docs-hub",
      default_branch: "main",
      project_skill_path: ".agent",
      project_rule_path: ".agent/rules",
      trigger: { mode: "manual", mention: "@agent-prd" },
      queue: { max_concurrent_issues: 1 },
      permissions: {
        allowed_permissions: ["read", "safe_write"],
        blocked_permissions: ["repo_write", "external_write", "dangerous"],
      },
    },
  ];
}

function section(
  sectionName: ConfigSectionName,
  content: string,
  parsed: Record<string, unknown>,
): DemoSection {
  return {
    section: sectionName,
    path: `demo://config/${sectionName}.yaml`,
    templatePath: `demo://config/${sectionName}.example.yaml`,
    exists: true,
    content,
    parsed,
    updatedAt: "2026-06-02T07:45:00.000Z",
  };
}

function sectionFor(sectionName: ConfigSectionName): DemoSection {
  const section = sectionsState.find((item) => item.section === sectionName);

  if (!section) {
    throw new Error(`Demo settings section '${sectionName}' is unavailable`);
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
    "    model: demo-agent-pro",
    "    supports_tools: true",
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
    const permissions = repository.permissions as Record<string, unknown>;
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
      "    permissions:",
      "      allowed_permissions:",
      ...((permissions.allowed_permissions as string[]) ?? []).map(
        (permission) => `        - ${permission}`,
      ),
      "      blocked_permissions:",
      ...((permissions.blocked_permissions as string[]) ?? []).map(
        (permission) => `        - ${permission}`,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

function sandboxYaml(): string {
  return [
    "sandbox:",
    "  mode: worktree",
    "  image: agent-sandbox-node:demo",
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

function policiesYaml(): string {
  return [
    "policies:",
    "  - id: block-secret-files",
    "    description: Demo branch blocks secrets and private keys.",
    "    match_paths:",
    "      - .env*",
    "      - '**/*.pem'",
    "      - '**/*.key'",
    "    action: block",
    "  - id: require-demo-sanitization",
    "    description: Demo screenshots must use sanitized sample data.",
    "    match_paths:",
    "      - apps/web/**",
    "    action: require_approval",
    "",
  ].join("\n");
}

function toolsYaml(): string {
  return [
    "tools:",
    "  - name: repo.search",
    "    permission: read",
    "  - name: repo.read_file",
    "    permission: read",
    "  - name: shell.run",
    "    permission: repo_write",
    "  - name: browser.screenshot",
    "    permission: read",
    "",
  ].join("\n");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
