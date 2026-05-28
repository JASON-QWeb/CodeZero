import { z } from "zod";

export const codingExecutorProviderModes = [
  "auto",
  "custom",
  "native",
] as const;
export const modelProviderTypes = [
  "openai-compatible",
  "anthropic",
  "google",
  "xai",
  "mistral",
  "groq",
] as const;

const codingExecutorProviderModeSchema = z.enum(codingExecutorProviderModes);
const modelProviderTypeSchema = z.enum(modelProviderTypes);
const codingExecutorProviderSchema = z
  .object({
    mode: codingExecutorProviderModeSchema.default("auto"),
    provider_id: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    npm: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    options: z.record(z.string(), z.unknown()).default({}),
    model_options: z.record(z.string(), z.unknown()).default({}),
    env: z.record(z.string(), z.string()).default({}),
  })
  .default({
    mode: "auto",
    options: {},
    model_options: {},
    env: {},
  });

export const providerSchema = z
  .object({
    type: modelProviderTypeSchema.default("openai-compatible"),
    base_url: z.string().min(1).optional(),
    api_key_env: z.string().min(1),
    model: z.string().min(1),
    supports_tools: z.boolean().default(true),
    supports_structured_output: z.boolean().default(true),
    temperature: z.number().optional(),
    max_tokens: z.number().optional(),
    timeout_ms: z.number().optional(),
    coding_executor: codingExecutorProviderSchema.optional(),
  })
  .superRefine((provider, context) => {
    if (provider.type !== "openai-compatible" || provider.base_url) {
      return;
    }

    context.addIssue({
      code: "custom",
      path: ["base_url"],
      message: "base_url is required for openai-compatible providers",
    });
  });

export const agentSchema = z.object({
  provider: z.string().min(1),
  provider_by_complexity: z
    .object({
      low: z.string().optional(),
      medium: z.string().optional(),
      high: z.string().optional(),
    })
    .default({}),
  system_prompt: z.string().min(1),
  skills: z.array(z.string()).default([]),
});

const agentsFileBaseSchema = z.object({
  providers: z.record(z.string(), providerSchema),
  agents: z.record(z.string(), agentSchema),
});

function validateAgentProviderRefs(
  config: z.infer<typeof agentsFileBaseSchema>,
  context: z.RefinementCtx,
): void {
  const providerIds = new Set(Object.keys(config.providers));

  for (const [agentName, agent] of Object.entries(config.agents)) {
    validateAgentProviderRef(
      context,
      providerIds,
      ["agents", agentName, "provider"],
      agent.provider,
    );

    for (const [complexity, providerId] of Object.entries(
      agent.provider_by_complexity,
    )) {
      if (providerId) {
        validateAgentProviderRef(
          context,
          providerIds,
          ["agents", agentName, "provider_by_complexity", complexity],
          providerId,
        );
      }
    }
  }
}

export const agentsFileSchema = agentsFileBaseSchema.superRefine(
  validateAgentProviderRefs,
);

export const codezeroFileSchema = agentsFileBaseSchema
  .merge(z.object({ repositories: z.array(z.lazy(() => repositorySchema)) }))
  .merge(z.object({ sandbox: z.lazy(() => sandboxFileSchema.shape.sandbox) }))
  .merge(
    z.object({ policies: z.array(z.lazy(() => policySchema)).default([]) }),
  )
  .merge(z.object({ tools: z.array(z.lazy(() => toolSchema)).default([]) }))
  .superRefine(validateAgentProviderRefs);

export const repositoryTriggerModes = [
  "auto",
  "mention",
  "label",
  "manual",
  "disabled",
] as const;
export const toolPermissionLevels = [
  "read",
  "safe_write",
  "repo_write",
  "external_write",
  "dangerous",
] as const;
export const implementationExecutorModes = ["cli"] as const;

const triggerModeSchema = z.enum(repositoryTriggerModes);
const toolPermissionSchema = z.enum(toolPermissionLevels);
const implementationExecutorModeSchema = z.enum(implementationExecutorModes);

const repositoryTriggerSchema = z
  .object({
    mode: triggerModeSchema.default("auto"),
    mention: z.string().min(1).default("@agent-prd"),
    auto_events: z
      .array(z.string())
      .default(["issues.opened", "issues.labeled", "issues.reopened"]),
    label_allowlist: z.array(z.string()).default([]),
    label_blocklist: z.array(z.string()).default([]),
    actor_allowlist: z.array(z.string()).default([]),
  })
  .default({
    mode: "auto",
    mention: "@agent-prd",
    auto_events: ["issues.opened", "issues.labeled", "issues.reopened"],
    label_allowlist: [],
    label_blocklist: [],
    actor_allowlist: [],
  });

const repositoryCodebaseIntelligenceSchema = z
  .object({
    codegraph: z
      .object({
        enabled: z.boolean().default(true),
        package: z.string().min(1).default("@colbymchenry/codegraph@0.9.3"),
        init_args: z.array(z.string()).default(["--index"]),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .default(10 * 60_000),
        fail_on_error: z.boolean().default(true),
      })
      .default({
        enabled: true,
        package: "@colbymchenry/codegraph@0.9.3",
        init_args: ["--index"],
        timeout_ms: 10 * 60_000,
        fail_on_error: true,
      }),
    navigation_graph: z
      .object({
        enabled: z.boolean().default(true),
        include_git_history: z.boolean().default(true),
        include_codeowners: z.boolean().default(true),
        max_depth: z.number().int().positive().default(4),
      })
      .default({
        enabled: true,
        include_git_history: true,
        include_codeowners: true,
        max_depth: 4,
      }),
  })
  .default({
    codegraph: {
      enabled: true,
      package: "@colbymchenry/codegraph@0.9.3",
      init_args: ["--index"],
      timeout_ms: 10 * 60_000,
      fail_on_error: true,
    },
    navigation_graph: {
      enabled: true,
      include_git_history: true,
      include_codeowners: true,
      max_depth: 4,
    },
  });

const repositoryPermissionsSchema = z
  .object({
    allowed_tools: z.array(z.string()).default([]),
    blocked_tools: z.array(z.string()).default([]),
    allowed_permissions: z.array(toolPermissionSchema).default([]),
    blocked_permissions: z.array(toolPermissionSchema).default([]),
  })
  .default({
    allowed_tools: [],
    blocked_tools: [],
    allowed_permissions: [],
    blocked_permissions: [],
  });

const repositoryWorkflowSchema = z
  .object({
    require_prd_review: z.boolean().default(true),
  })
  .default({
    require_prd_review: true,
  });

export const repositorySchema = z.object({
  id: z.string().min(1),
  github_owner: z.string().min(1),
  github_repo: z.string().min(1),
  default_branch: z.string().default("main"),
  project_skill_path: z.string().default(".agent"),
  trigger: repositoryTriggerSchema,
  codebase_intelligence: repositoryCodebaseIntelligenceSchema,
  queue: z
    .object({
      max_concurrent_issues: z.number().int().positive().default(1),
    })
    .default({
      max_concurrent_issues: 1,
    }),
  workflow: repositoryWorkflowSchema,
  permissions: repositoryPermissionsSchema,
  quality_gates: z
    .object({
      setup: z.string().optional(),
      build: z.string().optional(),
      lint: z.string().optional(),
      typecheck: z.string().optional(),
      unit_test: z.string().optional(),
    })
    .default({}),
  frontend: z
    .object({
      dev_command: z.string().optional(),
      screenshot_urls: z.array(z.string()).default([]),
    })
    .default({ screenshot_urls: [] }),
  pr: z
    .object({
      default_draft: z.boolean().default(true),
    })
    .default({ default_draft: true }),
});

export const repositoriesFileSchema = z.object({
  repositories: z.array(repositorySchema),
});

const implementationExecutorSchema = z
  .object({
    mode: implementationExecutorModeSchema.default("cli"),
    name: z.string().min(1).default("codezero-coding-cli"),
    command: z
      .string()
      .min(1)
      .default(
        'OPENCODE_BIN="${OPENCODE_BIN:-opencode}"; "$OPENCODE_BIN" run --agent build --model "$CODEZERO_OPENCODE_MODEL" --variant "${CODEZERO_OPENCODE_VARIANT:-minimal}" --format json "Implement the CodeZero request in the attached prompt file." --file="$CODEZERO_PROMPT_FILE"',
      ),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .default(60 * 60_000),
    env: z.record(z.string(), z.string()).default({}),
  })
  .default({
    mode: "cli",
    name: "codezero-coding-cli",
    command:
      'OPENCODE_BIN="${OPENCODE_BIN:-opencode}"; "$OPENCODE_BIN" run --agent build --model "$CODEZERO_OPENCODE_MODEL" --variant "${CODEZERO_OPENCODE_VARIANT:-minimal}" --format json "Implement the CodeZero request in the attached prompt file." --file="$CODEZERO_PROMPT_FILE"',
    timeout_ms: 60 * 60_000,
    env: {},
  });

export const sandboxFileSchema = z.object({
  sandbox: z.object({
    mode: z.enum(["docker", "worktree"]).default("docker"),
    image: z.string().default("agent-sandbox-node:latest"),
    root_dir: z.string().default("./sandboxes"),
    network: z
      .object({
        allow: z.array(z.string()).default([]),
      })
      .default({ allow: [] }),
    limits: z
      .object({
        max_runtime_minutes: z.number().default(90),
        max_diff_files: z.number().default(30),
        max_diff_lines: z.number().default(1200),
        max_quality_gate_retries: z.number().default(6),
      })
      .default({
        max_runtime_minutes: 90,
        max_diff_files: 30,
        max_diff_lines: 1200,
        max_quality_gate_retries: 6,
      }),
    implementation_executor: implementationExecutorSchema.optional(),
  }),
});

const policyActionSchema = z.enum([
  "allow",
  "audit",
  "require_approval",
  "block",
]);

export const policySchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  tool_names: z.array(z.string()).default([]),
  permissions: z.array(toolPermissionSchema).default([]),
  match_paths: z.array(z.string()).default([]),
  match_commands: z.array(z.string()).default([]),
  action: policyActionSchema,
});

export const policiesFileSchema = z.object({
  policies: z.array(policySchema).default([]),
});

export const toolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  permission: toolPermissionSchema,
  timeout_ms: z.number().int().positive().optional(),
  policy_refs: z.array(z.string()).default([]),
});

export const toolsFileSchema = z.object({
  tools: z.array(toolSchema).default([]),
});

export const configSectionNames = [
  "agents",
  "repositories",
  "sandbox",
  "policies",
  "tools",
] as const;

export type AgentsFileConfig = z.infer<typeof agentsFileSchema>;
export type CodeZeroFileConfig = z.infer<typeof codezeroFileSchema>;
export type CodingExecutorProviderConfig = z.infer<
  typeof codingExecutorProviderSchema
>;
export type ImplementationExecutorConfig = z.infer<
  typeof implementationExecutorSchema
>;
export type ModelProviderType = z.infer<typeof modelProviderTypeSchema>;
export type RepositoryConfig = z.infer<typeof repositorySchema>;
export type RepositoryTriggerConfig = RepositoryConfig["trigger"];
export type RepositoryTriggerMode = RepositoryTriggerConfig["mode"];
export type ToolPermissionLevel = z.infer<typeof toolPermissionSchema>;
export type RepositoryRuntimeSettingsPatch = {
  triggerMode?: RepositoryTriggerMode;
  mention?: string;
  maxConcurrentIssues?: number;
  projectSkillPath?: string;
  allowedPermissions?: ToolPermissionLevel[];
  blockedPermissions?: ToolPermissionLevel[];
};
export type SandboxFileConfig = z.infer<typeof sandboxFileSchema>;
export type PoliciesFileConfig = z.infer<typeof policiesFileSchema>;
export type PolicyConfig = z.infer<typeof policySchema>;
export type ToolsFileConfig = z.infer<typeof toolsFileSchema>;
export type ToolConfig = z.infer<typeof toolSchema>;
export type ConfigSectionName = (typeof configSectionNames)[number];

export function schemaForSection(
  section: ConfigSectionName,
): z.ZodType<unknown> {
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

function validateAgentProviderRef(
  context: z.RefinementCtx,
  providerIds: Set<string>,
  path: (string | number)[],
  providerId: string,
): void {
  if (providerIds.has(providerId)) {
    return;
  }

  context.addIssue({
    code: "custom",
    path,
    message: `Unknown provider '${providerId}'`,
  });
}
