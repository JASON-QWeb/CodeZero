import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, RepositoryConfig } from "@agent/config";
import { createRepositoryOnboarding, indexRepositoryWithCodeGraph, writeRepositoryOnboarding } from "@agent/codebase-intelligence";
import { getProjectKnowledgeGraphState, prepareRepositoryCheckout, startProjectKnowledgeGraphGeneration } from "./understand-anything.js";

export type RepositoryOnboardingStatus = "missing" | "generating" | "ready" | "failed";

export type RepositoryOnboardingState = {
  repositoryId: string;
  fullName: string;
  status: RepositoryOnboardingStatus;
  codeGraphAvailable: boolean;
  cacheDatabaseFile: string;
  message?: string;
  updatedAt?: string;
  codeGraph?: {
    operation: "initialized" | "synced";
    changeDetection: "initial-index" | "restored-cache-hash-scan" | "working-tree-sync";
    databaseFile: string;
    indexDir: string;
    durationMs: number;
    displayCommand: string;
  };
  summary?: {
    files: number;
    symbols: number;
    routes: number;
    tests: number;
    packageManager: string;
  };
  documents?: Array<{ path: string; type: string; content?: string }>;
};

type StoredRepositoryOnboardingState = Omit<RepositoryOnboardingState, "repositoryId" | "fullName" | "codeGraphAvailable" | "cacheDatabaseFile"> & {
  status: Exclude<RepositoryOnboardingStatus, "missing">;
};

const onboardingRuns = new Map<string, Promise<void>>();

export async function startConfiguredRepositoryOnboarding(config: AppConfig): Promise<void> {
  if (process.env.NODE_ENV === "test" || process.env.CODEZERO_AUTO_ONBOARDING === "0") {
    return;
  }

  for (const repository of config.repositories) {
    void startRepositoryOnboarding(config, repository).catch(() => undefined);
  }
}

export async function startRepositoryOnboarding(config: AppConfig, repository: RepositoryConfig): Promise<RepositoryOnboardingState> {
  const key = repositoryStorageKey(repository);

  if (onboardingRuns.has(key)) {
    return getRepositoryOnboardingState(config, repository);
  }

  const current = await getRepositoryOnboardingState(config, repository);

  if (current.status === "ready") {
    void ensureProjectKnowledgeGraphGeneration(config, repository);
    return current;
  }

  const run = runRepositoryOnboarding(config, repository).finally(() => {
    onboardingRuns.delete(key);
  });
  onboardingRuns.set(key, run);
  void run.catch(() => undefined);
  return getRepositoryOnboardingState(config, repository);
}

export async function getRepositoryOnboardingState(config: AppConfig, repository: RepositoryConfig): Promise<RepositoryOnboardingState> {
  const key = repositoryStorageKey(repository);
  const stored = await readStoredState(config, repository);
  const cacheDatabaseFile = codeGraphCacheDatabaseFile(config, repository);
  const codeGraphAvailable = await exists(cacheDatabaseFile);
  const codeGraphExpected = repository.codebase_intelligence.codegraph.enabled;
  const status = onboardingRuns.has(key)
    ? "generating"
    : stored?.status === "failed"
      ? "failed"
      : (stored?.status === "ready" && (!codeGraphExpected || codeGraphAvailable)) || codeGraphAvailable
        ? "ready"
        : "missing";

  return {
    repositoryId: repository.id,
    fullName: `${repository.github_owner}/${repository.github_repo}`,
    status,
    codeGraphAvailable,
    cacheDatabaseFile,
    message:
      status === "generating"
        ? (stored?.message ?? "Repository onboarding is building CodeGraph and knowledge graph context.")
        : stored?.message,
    updatedAt: stored?.updatedAt,
    codeGraph: stored?.codeGraph,
    summary: stored?.summary,
    documents: await readOnboardingDocuments(config, repository, stored?.documents)
  };
}

export function resetRepositoryOnboardingForTests(): void {
  onboardingRuns.clear();
}

async function runRepositoryOnboarding(config: AppConfig, repository: RepositoryConfig): Promise<void> {
  await writeStoredState(config, repository, {
    status: "generating",
    message: "Preparing managed repository checkout.",
    updatedAt: new Date().toISOString()
  });

  try {
    const repoDir = await prepareRepositoryCheckout(config, repository);
    const codeGraphConfig = repository.codebase_intelligence.codegraph;
    let codeGraph: StoredRepositoryOnboardingState["codeGraph"] | undefined;

    if (codeGraphConfig.enabled) {
      await writeStoredState(config, repository, {
        status: "generating",
        message: "CodeGraph is indexing this repository.",
        updatedAt: new Date().toISOString()
      });
      const result = await indexRepositoryWithCodeGraph({
        repoDir,
        packageName: codeGraphConfig.package,
        initArgs: codeGraphConfig.init_args,
        timeoutMs: codeGraphConfig.timeout_ms,
        env: process.env,
        cacheDatabaseFile: codeGraphCacheDatabaseFile(config, repository)
      });

      codeGraph = {
        operation: result.operation,
        changeDetection: result.changeDetection,
        databaseFile: result.databaseFile,
        indexDir: result.indexDir,
        durationMs: result.durationMs,
        displayCommand: result.displayCommand
      };

      if (result.status !== "success" && codeGraphConfig.fail_on_error) {
        throw new Error(`CodeGraph onboarding failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
      }
    }

    const onboarding = await createRepositoryOnboarding({
      repoDir,
      owner: repository.github_owner,
      repo: repository.github_repo,
      defaultBranch: repository.default_branch,
      triggerMode: repository.trigger.mode,
      mention: repository.trigger.mention,
      qualityGates: Object.values(repository.quality_gates).filter((value): value is string => typeof value === "string" && value.length > 0)
    });
    const documents = await writeRepositoryOnboarding(onboarding, path.join(onboardingDir(config, repository), "documents"));
    await writeStoredState(config, repository, {
      status: "ready",
      message: "Repository onboarding is ready.",
      updatedAt: new Date().toISOString(),
      codeGraph,
      summary: {
        files: onboarding.summary.files,
        symbols: onboarding.summary.symbols,
        routes: onboarding.summary.routes,
        tests: onboarding.summary.tests,
        packageManager: onboarding.summary.packageManager
      },
      documents: documents.map((document) => ({ path: document.path, type: document.type }))
    });
    void ensureProjectKnowledgeGraphGeneration(config, repository);
  } catch (error) {
    await writeStoredState(config, repository, {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    });
  }
}

async function ensureProjectKnowledgeGraphGeneration(config: AppConfig, repository: RepositoryConfig): Promise<void> {
  const state = await getProjectKnowledgeGraphState(config, repository);

  if (state.status === "missing" || state.status === "failed") {
    await startProjectKnowledgeGraphGeneration(config, repository).catch(() => undefined);
  }
}

async function readStoredState(config: AppConfig, repository: RepositoryConfig): Promise<StoredRepositoryOnboardingState | undefined> {
  const content = await readFile(onboardingStateFile(config, repository), "utf8").catch(() => "");

  if (!content) {
    return undefined;
  }

  try {
    return JSON.parse(content) as StoredRepositoryOnboardingState;
  } catch {
    return undefined;
  }
}

async function writeStoredState(config: AppConfig, repository: RepositoryConfig, state: StoredRepositoryOnboardingState): Promise<void> {
  const filePath = onboardingStateFile(config, repository);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryFile = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(state, null, 2));
  await rename(temporaryFile, filePath);
}

function onboardingStateFile(config: AppConfig, repository: RepositoryConfig): string {
  return path.join(onboardingDir(config, repository), "status.json");
}

function onboardingDir(config: AppConfig, repository: RepositoryConfig): string {
  return path.join(config.rootDir, "data", "repository-onboarding", repositoryStorageKey(repository));
}

function codeGraphCacheDatabaseFile(config: AppConfig, repository: RepositoryConfig): string {
  return path.join(config.rootDir, "data", "codegraph", repositoryStorageKey(repository), "codegraph.db");
}

async function readOnboardingDocuments(
  config: AppConfig,
  repository: RepositoryConfig,
  documents: Array<{ path: string; type: string; content?: string }> | undefined
): Promise<Array<{ path: string; type: string; content?: string }> | undefined> {
  if (!documents) {
    return undefined;
  }

  const documentRoot = path.join(onboardingDir(config, repository), "documents");

  return Promise.all(
    documents.map(async (document) => ({
      ...document,
      content: document.content ?? (await readFile(path.join(documentRoot, document.path), "utf8").catch(() => undefined))
    }))
  );
}

function repositoryStorageKey(repository: RepositoryConfig): string {
  return `${repository.github_owner}--${repository.github_repo}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}
