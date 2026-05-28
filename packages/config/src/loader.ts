import { access, readFile, writeFile } from "node:fs/promises";
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

const loadedEnvRoots = new Set<string>();

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
  await loadProjectEnv(resolvedRootDir);
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
      filePath: resolveFromRoot(resolvedRootDir, process.env.TASK_STORE_FILE ?? path.join("data", "tasks.json")),
      databaseUrl
    },
    memory: {
      filePath: resolveFromRoot(resolvedRootDir, process.env.MEMORY_STORE_FILE ?? path.join("data", "memory.json"))
    },
    github: {
      token: process.env.GITHUB_TOKEN,
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET
    }
  };
}

function resolveFromRoot(rootDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
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

export async function loadProjectEnv(rootDir?: string): Promise<void> {
  const resolvedRootDir = rootDir ?? process.env.PROJECT_ROOT ?? (await findWorkspaceRoot(process.cwd()));

  if (loadedEnvRoots.has(resolvedRootDir)) {
    return;
  }

  loadedEnvRoots.add(resolvedRootDir);
  const content = await readFile(path.join(resolvedRootDir, ".env"), "utf8").catch(() => undefined);

  if (!content) {
    return;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);

    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2] ?? "";

    if (!key) {
      continue;
    }

    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = parseEnvValue(rawValue);
  }
}

export async function upsertProjectEnv(rootDir: string, key: string, value: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment key: ${key}`);
  }

  const envPath = path.join(rootDir, ".env");
  const sanitizedValue = value.replace(/\r?\n/g, "");
  const existing = await readFile(envPath, "utf8").catch(() => "");
  const lines = existing ? existing.split(/\r?\n/) : [];
  const keyPattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}=`);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (!replaced && keyPattern.test(line.trim())) {
      replaced = true;
      return `${key}=${sanitizedValue}`;
    }

    return line;
  });

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }
    nextLines.push(`${key}=${sanitizedValue}`);
  }

  await writeFile(envPath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`);
  process.env[key] = sanitizedValue;
  loadedEnvRoots.delete(rootDir);
}

async function readYaml<T>(primaryPath: string, fallbackPath: string, schema: Parser<T>): Promise<T> {
  const content = await readFile(primaryPath, "utf8").catch(async () => readFile(fallbackPath, "utf8"));
  const interpolated = interpolateEnv(content);
  return schema.parse(YAML.parse(interpolated));
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
