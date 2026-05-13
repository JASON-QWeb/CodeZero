import { access, readFile } from "node:fs/promises";
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
  system_prompt: z.string().min(1),
  skills: z.array(z.string()).default([])
});

const agentsFileSchema = z.object({
  providers: z.record(z.string(), providerSchema),
  agents: z.record(z.string(), agentSchema)
});

const triggerModeSchema = z.enum(["auto", "mention", "label", "manual", "disabled"]);

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

const repositorySchema = z.object({
  id: z.string().min(1),
  github_owner: z.string().min(1),
  github_repo: z.string().min(1),
  default_branch: z.string().default("main"),
  project_skill_path: z.string().default(".agent"),
  trigger: repositoryTriggerSchema,
  codebase_intelligence: repositoryCodebaseIntelligenceSchema,
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
const toolPermissionSchema = z.enum(["read", "safe_write", "repo_write", "external_write", "dangerous"]);

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
