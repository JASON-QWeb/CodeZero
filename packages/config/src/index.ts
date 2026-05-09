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

const repositorySchema = z.object({
  id: z.string().min(1),
  github_owner: z.string().min(1),
  github_repo: z.string().min(1),
  default_branch: z.string().default("main"),
  project_skill_path: z.string().default(".agent"),
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

export type AgentsFileConfig = z.infer<typeof agentsFileSchema>;
export type RepositoryConfig = z.infer<typeof repositorySchema>;
export type SandboxFileConfig = z.infer<typeof sandboxFileSchema>;

export type AppConfig = {
  rootDir: string;
  agents: AgentsFileConfig;
  repositories: RepositoryConfig[];
  sandbox: SandboxFileConfig["sandbox"];
  storage: {
    driver: "file" | "postgres";
    filePath: string;
    databaseUrl?: string;
  };
  github: {
    token?: string;
    webhookSecret?: string;
  };
};

export async function loadAppConfig(rootDir?: string): Promise<AppConfig> {
  const resolvedRootDir = rootDir ?? process.env.PROJECT_ROOT ?? (await findWorkspaceRoot(process.cwd()));
  const [agents, repositories, sandbox] = await Promise.all([
    readYaml(path.join(resolvedRootDir, "config", "agents.yaml"), path.join(resolvedRootDir, "config", "agents.example.yaml"), agentsFileSchema),
    readYaml(
      path.join(resolvedRootDir, "config", "repositories.yaml"),
      path.join(resolvedRootDir, "config", "repositories.example.yaml"),
      repositoriesFileSchema
    ),
    readYaml(path.join(resolvedRootDir, "config", "sandbox.yaml"), path.join(resolvedRootDir, "config", "sandbox.example.yaml"), sandboxFileSchema)
  ]);

  const databaseUrl = process.env.DATABASE_URL;

  return {
    rootDir: resolvedRootDir,
    agents,
    repositories: repositories.repositories,
    sandbox: sandbox.sandbox,
    storage: {
      driver: process.env.STORAGE_DRIVER === "postgres" && databaseUrl ? "postgres" : "file",
      filePath: process.env.TASK_STORE_FILE ?? path.join(resolvedRootDir, "data", "tasks.json"),
      databaseUrl
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

export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key: string) => process.env[key] ?? match);
}

async function readYaml<T>(primaryPath: string, fallbackPath: string, schema: z.ZodType<T>): Promise<T> {
  const content = await readFile(primaryPath, "utf8").catch(async () => readFile(fallbackPath, "utf8"));
  const interpolated = interpolateEnv(content);
  return schema.parse(YAML.parse(interpolated));
}
