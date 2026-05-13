import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const providerSchema = z.object({
  type: z.literal("openai-compatible").default("openai-compatible"),
  base_url: z.string().min(1),
  api_key_env: z.string().min(1),
  model: z.string().min(1),
  supports_tools: z.boolean().default(true),
  supports_structured_output: z.boolean().default(true),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  timeout_ms: z.number().optional()
});

const agentSchema = z.object({
  provider: z.string().min(1),
  provider_by_complexity: z
    .object({
      low: z.string().optional(),
      medium: z.string().optional(),
      high: z.string().optional()
    })
    .default({}),
  system_prompt: z.string().min(1),
  skills: z.array(z.string()).default([])
});

const agentsFileSchema = z
  .object({
    providers: z.record(z.string(), providerSchema),
    agents: z.record(z.string(), agentSchema)
  })
  .superRefine((config, context) => {
    const providerIds = new Set(Object.keys(config.providers));

    for (const [agentName, agent] of Object.entries(config.agents)) {
      validateAgentProviderRef(context, providerIds, ["agents", agentName, "provider"], agent.provider);

      for (const [complexity, providerId] of Object.entries(agent.provider_by_complexity)) {
        if (providerId) {
          validateAgentProviderRef(context, providerIds, ["agents", agentName, "provider_by_complexity", complexity], providerId);
        }
      }
    }
  });

const triggerModeSchema = z.enum(["auto", "mention", "label", "manual", "disabled"]);
const toolPermissionSchema = z.enum(["read", "safe_write", "repo_write", "external_write", "dangerous"]);

const repositoryTriggerSchema = z
  .object({
    mode: triggerModeSchema.default("auto"),
    mention: z.string().min(1).default("@agent-prd"),
    auto_events: z.array(z.string()).default(["issues.opened", "issues.labeled", "issues.reopened"]),
    label_allowlist: z.array(z.string()).default([]),
    label_blocklist: z.array(z.string()).default([]),
    actor_allowlist: z.array(z.string()).default([])
  })
  .default({
    mode: "auto",
    mention: "@agent-prd",
    auto_events: ["issues.opened", "issues.labeled", "issues.reopened"],
    label_allowlist: [],
    label_blocklist: [],
    actor_allowlist: []
  });

const repositoryCodebaseIntelligenceSchema = z
  .object({
    navigation_graph: z
      .object({
        enabled: z.boolean().default(true),
        include_git_history: z.boolean().default(true),
        include_codeowners: z.boolean().default(true),
        max_depth: z.number().int().positive().default(4)
      })
      .default({
        enabled: true,
        include_git_history: true,
        include_codeowners: true,
        max_depth: 4
      })
  })
  .default({
    navigation_graph: {
      enabled: true,
      include_git_history: true,
      include_codeowners: true,
      max_depth: 4
    }
  });

const repositoryPermissionsSchema = z
  .object({
    allowed_tools: z.array(z.string()).default([]),
    blocked_tools: z.array(z.string()).default([]),
    allowed_permissions: z.array(toolPermissionSchema).default([]),
    blocked_permissions: z.array(toolPermissionSchema).default([])
  })
  .default({
    allowed_tools: [],
    blocked_tools: [],
    allowed_permissions: [],
    blocked_permissions: []
  });

const repositorySchema = z.object({
  id: z.string().min(1),
  github_owner: z.string().min(1),
  github_repo: z.string().min(1),
  default_branch: z.string().default("main"),
  project_skill_path: z.string().default(".agent"),
  trigger: repositoryTriggerSchema,
  codebase_intelligence: repositoryCodebaseIntelligenceSchema,
  permissions: repositoryPermissionsSchema,
  quality_gates: z
    .object({
      build: z.string().optional(),
      lint: z.string().optional(),
      typecheck: z.string().optional(),
      unit_test: z.string().optional()
    })
    .default({}),
  frontend: z
    .object({
      dev_command: z.string().optional(),
      screenshot_urls: z.array(z.string()).default([])
    })
    .default({ screenshot_urls: [] }),
  pr: z
    .object({
      default_draft: z.boolean().default(true)
    })
    .default({ default_draft: true })
});

const repositoriesFileSchema = z.object({
  repositories: z.array(repositorySchema)
});

const sandboxFileSchema = z.object({
  sandbox: z.object({
    mode: z.enum(["docker", "worktree"]).default("docker"),
    image: z.string().default("agent-sandbox-node:latest"),
    root_dir: z.string().default("./sandboxes"),
    network: z
      .object({
        allow: z.array(z.string()).default([])
      })
      .default({ allow: [] }),
    limits: z
      .object({
        max_runtime_minutes: z.number().default(90),
        max_diff_files: z.number().default(30),
        max_diff_lines: z.number().default(1200),
        max_quality_gate_retries: z.number().default(3)
      })
      .default({
        max_runtime_minutes: 90,
        max_diff_files: 30,
        max_diff_lines: 1200,
        max_quality_gate_retries: 3
      })
  })
});

const policyActionSchema = z.enum(["allow", "audit", "require_approval", "block"]);

const policySchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  tool_names: z.array(z.string()).default([]),
  permissions: z.array(toolPermissionSchema).default([]),
  match_paths: z.array(z.string()).default([]),
  match_commands: z.array(z.string()).default([]),
  action: policyActionSchema
});

const policiesFileSchema = z.object({
  policies: z.array(policySchema).default([])
});

const toolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  permission: toolPermissionSchema,
  timeout_ms: z.number().int().positive().optional(),
  policy_refs: z.array(z.string()).default([])
});

const toolsFileSchema = z.object({
  tools: z.array(toolSchema).default([])
});

export type AgentsFileConfig = z.infer<typeof agentsFileSchema>;
export type RepositoryConfig = z.infer<typeof repositorySchema>;
export type RepositoryTriggerConfig = RepositoryConfig["trigger"];
export type RepositoryTriggerMode = RepositoryTriggerConfig["mode"];
export type SandboxFileConfig = z.infer<typeof sandboxFileSchema>;
export type PoliciesFileConfig = z.infer<typeof policiesFileSchema>;
export type PolicyConfig = z.infer<typeof policySchema>;
export type ToolsFileConfig = z.infer<typeof toolsFileSchema>;
export type ToolConfig = z.infer<typeof toolSchema>;

export const configSectionNames = ["agents", "repositories", "sandbox", "policies", "tools"] as const;

export type ConfigSectionName = (typeof configSectionNames)[number];

export type EditableConfigSection = {
  section: ConfigSectionName;
  path: string;
  fallbackPath: string;
  exists: boolean;
  content: string;
  parsed: unknown;
  updatedAt?: string;
};

export type EditableConfigSnapshot = {
  rootDir: string;
  sections: EditableConfigSection[];
};

export type RepositoryTriggerDecisionInput = {
  repository?: RepositoryConfig;
  eventName: string;
  action: string;
  labels?: string[];
  commentBody?: string;
  actor?: string;
  fallbackMention?: string;
};

export type RepositoryTriggerDecision = {
  shouldTrigger: boolean;
  trigger: RepositoryTriggerMode | "unconfigured";
  reason: string;
  mention?: string;
};

export type AppConfig = {
  rootDir: string;
  agents: AgentsFileConfig;
  repositories: RepositoryConfig[];
  sandbox: SandboxFileConfig["sandbox"];
  policies: PolicyConfig[];
  tools: ToolConfig[];
  storage: {
    driver: "file" | "postgres";
    filePath: string;
    databaseUrl?: string;
  };
  memory: {
    filePath: string;
  };
  github: {
    token?: string;
    webhookSecret?: string;
  };
};

export async function loadAppConfig(rootDir?: string): Promise<AppConfig> {
  const resolvedRootDir = rootDir ?? process.env.PROJECT_ROOT ?? (await findWorkspaceRoot(process.cwd()));
  const [agents, repositories, sandbox, policies, tools] = await Promise.all([
    readYaml(path.join(resolvedRootDir, "config", "agents.yaml"), path.join(resolvedRootDir, "config", "agents.example.yaml"), agentsFileSchema),
    readYaml(
      path.join(resolvedRootDir, "config", "repositories.yaml"),
      path.join(resolvedRootDir, "config", "repositories.example.yaml"),
      repositoriesFileSchema
    ),
    readYaml(path.join(resolvedRootDir, "config", "sandbox.yaml"), path.join(resolvedRootDir, "config", "sandbox.example.yaml"), sandboxFileSchema),
    readYaml(path.join(resolvedRootDir, "config", "policies.yaml"), path.join(resolvedRootDir, "config", "policies.example.yaml"), policiesFileSchema),
    readYaml(path.join(resolvedRootDir, "config", "tools.yaml"), path.join(resolvedRootDir, "config", "tools.example.yaml"), toolsFileSchema)
  ]);

  const databaseUrl = process.env.DATABASE_URL;

  return {
    rootDir: resolvedRootDir,
    agents,
    repositories: repositories.repositories,
    sandbox: sandbox.sandbox,
    policies: policies.policies,
    tools: tools.tools,
    storage: {
      driver: process.env.STORAGE_DRIVER === "postgres" && databaseUrl ? "postgres" : "file",
      filePath: process.env.TASK_STORE_FILE ?? path.join(resolvedRootDir, "data", "tasks.json"),
      databaseUrl
    },
    memory: {
      filePath: process.env.MEMORY_STORE_FILE ?? path.join(resolvedRootDir, "data", "memory.json")
    },
    github: {
      token: process.env.GITHUB_TOKEN,
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET
    }
  };
}

export async function loadEditableConfig(rootDir?: string): Promise<EditableConfigSnapshot> {
  const resolvedRootDir = rootDir ?? process.env.PROJECT_ROOT ?? (await findWorkspaceRoot(process.cwd()));
  const sections = await Promise.all(configSectionNames.map((section) => readConfigSection(resolvedRootDir, section)));
  return { rootDir: resolvedRootDir, sections };
}

export async function readConfigSection(rootDir: string, section: ConfigSectionName): Promise<EditableConfigSection> {
  const paths = getConfigSectionPaths(rootDir, section);
  const primary = await readFile(paths.path, "utf8")
    .then((content) => ({ content, exists: true }))
    .catch(async () => ({ content: await readFile(paths.fallbackPath, "utf8"), exists: false }));
  const stats = await stat(paths.path).catch(() => undefined);

  return {
    section,
    path: paths.path,
    fallbackPath: paths.fallbackPath,
    exists: primary.exists,
    content: primary.content,
    parsed: parseConfigSection(section, primary.content),
    updatedAt: stats?.mtime.toISOString()
  };
}

export async function writeConfigSection(rootDir: string, section: ConfigSectionName, content: string): Promise<EditableConfigSection> {
  parseConfigSection(section, content);
  const paths = getConfigSectionPaths(rootDir, section);
  await mkdir(path.dirname(paths.path), { recursive: true });
  const tempPath = `${paths.path}.tmp`;
  await writeFile(tempPath, content.endsWith("\n") ? content : `${content}\n`);
  await rename(tempPath, paths.path);
  return readConfigSection(rootDir, section);
}

export function parseConfigSection(section: ConfigSectionName, content: string): unknown {
  return schemaForSection(section).parse(YAML.parse(interpolateEnv(content)));
}

export function isConfigSectionName(value: string): value is ConfigSectionName {
  return configSectionNames.includes(value as ConfigSectionName);
}

function validateAgentProviderRef(context: z.RefinementCtx, providerIds: Set<string>, path: (string | number)[], providerId: string): void {
  if (providerIds.has(providerId)) {
    return;
  }

  context.addIssue({
    code: "custom",
    path,
    message: `Unknown provider '${providerId}'`
  });
}

export async function findWorkspaceRoot(startDir: string): Promise<string> {
  let current = path.resolve(startDir);

  for (;;) {
    const candidate = path.join(current, "pnpm-workspace.yaml");
    const found = await access(candidate).then(
      () => true,
      () => false
    );

    if (found) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return path.resolve(startDir);
    }

    current = parent;
  }
}

export function findRepository(config: AppConfig, owner: string, repo: string): RepositoryConfig | undefined {
  return config.repositories.find((entry) => entry.github_owner === owner && entry.github_repo === repo);
}

export function evaluateRepositoryTrigger(input: RepositoryTriggerDecisionInput): RepositoryTriggerDecision {
  const repository = input.repository;

  if (!repository) {
    return {
      shouldTrigger: false,
      trigger: "unconfigured",
      reason: "Repository is not configured"
    };
  }

  const trigger = repository.trigger;
  const labels = new Set((input.labels ?? []).map(normalizeForCompare).filter(Boolean));
  const actor = input.actor ? normalizeForCompare(input.actor) : undefined;
  const eventKey = `${input.eventName}.${input.action}`;

  if (trigger.mode === "disabled") {
    return { shouldTrigger: false, trigger: trigger.mode, reason: "Repository trigger mode is disabled" };
  }

  if (trigger.mode === "manual") {
    return { shouldTrigger: false, trigger: trigger.mode, reason: "Repository trigger mode is manual" };
  }

  if (trigger.actor_allowlist.length > 0 && (!actor || !trigger.actor_allowlist.map(normalizeForCompare).includes(actor))) {
    return { shouldTrigger: false, trigger: trigger.mode, reason: "Actor is not allowlisted" };
  }

  const blockedLabel = trigger.label_blocklist.map(normalizeForCompare).find((label) => labels.has(label));

  if (blockedLabel) {
    return { shouldTrigger: false, trigger: trigger.mode, reason: `Issue has blocked label ${blockedLabel}` };
  }

  if (trigger.mode === "auto") {
    const shouldTrigger = trigger.auto_events.includes(eventKey);
    return {
      shouldTrigger,
      trigger: trigger.mode,
      reason: shouldTrigger ? `Matched auto event ${eventKey}` : `Auto mode does not include event ${eventKey}`
    };
  }

  if (trigger.mode === "label") {
    const allowlist = trigger.label_allowlist.map(normalizeForCompare);
    const matchedLabel = allowlist.find((label) => labels.has(label));
    return {
      shouldTrigger: Boolean(matchedLabel),
      trigger: trigger.mode,
      reason: matchedLabel ? `Matched allowlisted label ${matchedLabel}` : "Issue does not contain an allowlisted label"
    };
  }

  const mention = trigger.mention || input.fallbackMention || "@agent-prd";

  if (input.eventName !== "issue_comment" || input.action !== "created") {
    return {
      shouldTrigger: false,
      trigger: trigger.mode,
      reason: "Mention mode only triggers on issue_comment.created",
      mention
    };
  }

  const shouldTrigger = containsCaseInsensitive(input.commentBody ?? "", mention);

  return {
    shouldTrigger,
    trigger: trigger.mode,
    reason: shouldTrigger ? `Comment contains trigger mention ${mention}` : `Comment does not contain trigger mention ${mention}`,
    mention
  };
}

export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key: string) => process.env[key] ?? match);
}

function containsCaseInsensitive(value: string, needle: string): boolean {
  return normalizeForCompare(value).includes(normalizeForCompare(needle));
}

function normalizeForCompare(value: string): string {
  return value.trim().toLowerCase();
}

async function readYaml<T>(primaryPath: string, fallbackPath: string, schema: z.ZodType<T>): Promise<T> {
  const content = await readFile(primaryPath, "utf8").catch(async () => readFile(fallbackPath, "utf8"));
  const interpolated = interpolateEnv(content);
  return schema.parse(YAML.parse(interpolated));
}

function getConfigSectionPaths(rootDir: string, section: ConfigSectionName): { path: string; fallbackPath: string } {
  return {
    path: path.join(rootDir, "config", `${section}.yaml`),
    fallbackPath: path.join(rootDir, "config", `${section}.example.yaml`)
  };
}

function schemaForSection(section: ConfigSectionName): z.ZodType<unknown> {
  switch (section) {
    case "agents":
      return agentsFileSchema;
    case "repositories":
      return repositoriesFileSchema;
    case "sandbox":
      return sandboxFileSchema;
    case "policies":
      return policiesFileSchema;
    case "tools":
      return toolsFileSchema;
  }
}
