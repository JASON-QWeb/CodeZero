import { access, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  agentsFileSchema,
  policiesFileSchema,
  repositoriesFileSchema,
  sandboxFileSchema,
  toolsFileSchema,
  type AgentsFileConfig,
  type PolicyConfig,
  type RepositoryConfig,
  type SandboxFileConfig,
  type ToolConfig
} from "./schema.js";

type Parser<T> = {
  parse(value: unknown): T;
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

export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key: string) => process.env[key] ?? match);
}

async function readYaml<T>(primaryPath: string, fallbackPath: string, schema: Parser<T>): Promise<T> {
  const content = await readFile(primaryPath, "utf8").catch(async () => readFile(fallbackPath, "utf8"));
  const interpolated = interpolateEnv(content);
  return schema.parse(YAML.parse(interpolated));
}
