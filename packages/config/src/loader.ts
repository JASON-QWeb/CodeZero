import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  codezeroFileSchema,
  type AgentsFileConfig,
  type CodeZeroFileConfig,
  type MemoryFileConfig,
  type RepositoryConfig,
  type SandboxFileConfig,
  type WorkflowGraphFileConfig
} from "./schema.js";

const loadedEnvRoots = new Set<string>();

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
  memory: {
    filePath: string;
    maxRecords: number;
    maxBytes: number;
    maxRecordBytes: number;
  };
  workflowGraph: {
    checkpointFilePath: string;
  };
  github: {
    token?: string;
    webhookSecret?: string;
    app?: {
      appId?: string;
      installationId?: string;
      privateKey?: string;
      privateKeyPath?: string;
    };
  };
};

export async function loadAppConfig(rootDir?: string): Promise<AppConfig> {
  const resolvedRootDir = rootDir ?? process.env.PROJECT_ROOT ?? (await findWorkspaceRoot(process.cwd()));
  await loadProjectEnv(resolvedRootDir);
  const runtimeConfig = toRuntimeConfigSections(await readCodeZeroConfig(resolvedRootDir));

  const databaseUrl = process.env.DATABASE_URL;

  return {
    rootDir: resolvedRootDir,
    agents: runtimeConfig.agents,
    repositories: runtimeConfig.repositories,
    sandbox: runtimeConfig.sandbox,
    storage: {
      driver: process.env.STORAGE_DRIVER === "postgres" && databaseUrl ? "postgres" : "file",
      filePath: resolveFromRoot(resolvedRootDir, process.env.TASK_STORE_FILE ?? path.join("data", "tasks.json")),
      databaseUrl
    },
    memory: {
      filePath: resolveFromRoot(resolvedRootDir, process.env.MEMORY_STORE_FILE ?? path.join("data", "memory.json")),
      maxRecords: numberEnv("MEMORY_MAX_RECORDS") ?? runtimeConfig.memory.max_records,
      maxBytes: numberEnv("MEMORY_MAX_BYTES") ?? runtimeConfig.memory.max_bytes,
      maxRecordBytes: numberEnv("MEMORY_MAX_RECORD_BYTES") ?? runtimeConfig.memory.max_record_bytes
    },
    workflowGraph: {
      checkpointFilePath: resolveFromRoot(
        resolvedRootDir,
        process.env.LANGGRAPH_CHECKPOINT_FILE ??
          runtimeConfig.workflowGraph.checkpoint_file
      )
    },
    github: {
      token: optionalEnv("GITHUB_TOKEN"),
      webhookSecret: optionalEnv("GITHUB_WEBHOOK_SECRET"),
      app: githubAppConfig(resolvedRootDir)
    }
  };
}

export type RuntimeConfigSections = {
  agents: AgentsFileConfig;
  repositories: RepositoryConfig[];
  sandbox: SandboxFileConfig["sandbox"];
  memory: MemoryFileConfig["memory"];
  workflowGraph: WorkflowGraphFileConfig["workflow_graph"];
};

export function toRuntimeConfigSections(config: CodeZeroFileConfig): RuntimeConfigSections {
  return {
    agents: {
      providers: config.providers,
      agents: config.agents
    },
    repositories: config.repositories,
    sandbox: config.sandbox,
    memory: config.memory,
    workflowGraph: config.workflow_graph
  };
}

export async function readCodeZeroConfig(rootDir: string): Promise<CodeZeroFileConfig> {
  const configPath = path.join(rootDir, "config", "codezero.yaml");
  const content = await readFile(configPath, "utf8");
  return codezeroFileSchema.parse(YAML.parse(interpolateEnv(content)));
}

function resolveFromRoot(rootDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

function githubAppConfig(rootDir: string): AppConfig["github"]["app"] {
  const privateKeyPath = optionalEnv("GITHUB_APP_PRIVATE_KEY_PATH");
  const app = {
    appId: optionalEnv("GITHUB_APP_ID"),
    installationId: optionalEnv("GITHUB_APP_INSTALLATION_ID"),
    privateKey: optionalEnv("GITHUB_APP_PRIVATE_KEY"),
    privateKeyPath: privateKeyPath ? resolveFromRoot(rootDir, privateKeyPath) : undefined
  };
  return app.appId || app.installationId || app.privateKey || app.privateKeyPath ? app : undefined;
}

function optionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function numberEnv(key: string): number | undefined {
  const value = process.env[key]?.trim();

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
