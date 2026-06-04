import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { createServer } from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig, RepositoryConfig } from "@agent/config";
import {
  createGitHubRemoteUrl,
  getGitHubAuthToken,
  redactRemoteUrl,
} from "@agent/github";
import { runCommand, type CommandResult } from "@agent/sandbox";
import { pathExists, shellQuote } from "@agent/shared";

export const understandAnythingProjectUrl =
  "https://github.com/Lum1104/Understand-Anything";
export const understandAnythingTestedVersion = "v2.7.3";

export type KnowledgeGraphStatus =
  | "missing"
  | "generating"
  | "ready"
  | "failed";

export type ProjectKnowledgeGraphState = {
  repositoryId: string;
  fullName: string;
  status: KnowledgeGraphStatus;
  graphAvailable: boolean;
  pluginInstalled: boolean;
  provider: {
    name: "Understand-Anything";
    projectUrl: string;
    testedVersion: string;
    outputFile: ".understand-anything/knowledge-graph.json";
  };
  graph?: {
    projectName?: string;
    analyzedAt?: string;
    nodes?: number;
    edges?: number;
  };
  message?: string;
  dashboardUrl?: string;
};

type StoredGenerationState = {
  status: Exclude<KnowledgeGraphStatus, "missing">;
  message: string;
  updatedAt: string;
};

const generationRuns = new Map<string, Promise<void>>();
const dashboards = new Map<string, { child: ChildProcess; url: string }>();
const dashboardPreparation = new Map<string, Promise<void>>();

export async function getProjectKnowledgeGraphState(
  config: AppConfig,
  repository: RepositoryConfig,
): Promise<ProjectKnowledgeGraphState> {
  const key = repositoryStorageKey(repository);
  const pluginRoot = await resolveUnderstandAnythingPluginRoot();
  const graph = await readGraphSummary(projectGraphFile(config, repository));
  const stored = await readStoredState(config, repository);
  const isGenerating = generationRuns.has(key);
  const interrupted =
    stored?.status === "generating" && !isGenerating && !graph;
  const status: KnowledgeGraphStatus = isGenerating
    ? "generating"
    : graph
      ? "ready"
      : stored?.status === "failed" || interrupted
        ? "failed"
        : "missing";

  return {
    repositoryId: repository.id,
    fullName: `${repository.github_owner}/${repository.github_repo}`,
    status,
    graphAvailable: Boolean(graph),
    pluginInstalled: Boolean(pluginRoot),
    provider: {
      name: "Understand-Anything",
      projectUrl: understandAnythingProjectUrl,
      testedVersion: understandAnythingTestedVersion,
      outputFile: ".understand-anything/knowledge-graph.json",
    },
    graph,
    message:
      status === "generating"
        ? (stored?.message ??
          "Understand-Anything is analyzing this repository.")
        : status === "failed"
          ? interrupted
            ? "The previous Understand-Anything analysis was interrupted before it produced a graph. Start generation again."
            : stored?.message
          : !pluginRoot
            ? "Install the official Understand-Anything Codex skill before generating a graph."
            : undefined,
    dashboardUrl: dashboards.get(key)?.url,
  };
}

export async function startProjectKnowledgeGraphGeneration(
  config: AppConfig,
  repository: RepositoryConfig,
  input: { full?: boolean } = {},
): Promise<ProjectKnowledgeGraphState> {
  const key = repositoryStorageKey(repository);

  if (generationRuns.has(key)) {
    return getProjectKnowledgeGraphState(config, repository);
  }

  const pluginRoot = await resolveUnderstandAnythingPluginRoot();

  if (!pluginRoot) {
    throw new Error(
      "Understand-Anything is not installed. Install the official Codex integration with: curl -fsSL https://raw.githubusercontent.com/Lum1104/Understand-Anything/main/install.sh | bash -s codex",
    );
  }

  if (generationRuns.has(key)) {
    return getProjectKnowledgeGraphState(config, repository);
  }

  const generation = (async () => {
    await writeStoredState(config, repository, {
      status: "generating",
      message:
        "Preparing the repository for the official Understand-Anything analysis.",
      updatedAt: new Date().toISOString(),
    });
    await generateProjectKnowledgeGraph(config, repository, pluginRoot, input);
  })()
    .catch(async (error) => {
      await writeStoredState(config, repository, {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
    })
    .finally(() => {
      generationRuns.delete(key);
    });

  generationRuns.set(key, generation);
  return getProjectKnowledgeGraphState(config, repository);
}

export async function openProjectKnowledgeGraphDashboard(
  config: AppConfig,
  repository: RepositoryConfig,
): Promise<ProjectKnowledgeGraphState> {
  const graphFile = projectGraphFile(config, repository);

  if (!(await pathExists(graphFile))) {
    throw new Error(
      "No Understand-Anything knowledge graph exists for this repository. Generate it first.",
    );
  }

  const pluginRoot = await resolveUnderstandAnythingPluginRoot();

  if (!pluginRoot) {
    throw new Error(
      "Understand-Anything is not installed, so its official dashboard cannot be started.",
    );
  }

  const key = repositoryStorageKey(repository);
  const active = dashboards.get(key);

  if (active && active.child.exitCode === null) {
    return getProjectKnowledgeGraphState(config, repository);
  }

  await prepareOfficialDashboard(pluginRoot);

  const port = await availablePort();
  const token = crypto.randomBytes(16).toString("hex");
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  const child = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: path.join(pluginRoot, "packages", "dashboard"),
      env: {
        ...process.env,
        BROWSER: "none",
        GRAPH_DIR: projectRepositoryDir(config, repository),
        UNDERSTAND_ACCESS_TOKEN: token,
      },
      stdio: "ignore",
    },
  );

  dashboards.set(key, { child, url });
  child.once("exit", () => {
    const current = dashboards.get(key);

    if (current?.child === child) {
      dashboards.delete(key);
    }
  });

  try {
    await waitForDashboard(port, child);
  } catch (error) {
    child.kill();
    dashboards.delete(key);
    throw error;
  }

  return getProjectKnowledgeGraphState(config, repository);
}

export function projectRepositoryDir(
  config: AppConfig,
  repository: RepositoryConfig,
): string {
  return path.join(
    config.rootDir,
    "data",
    "understand-anything",
    repositoryStorageKey(repository),
    "repo",
  );
}

export function projectGraphFile(
  config: AppConfig,
  repository: RepositoryConfig,
): string {
  return path.join(
    projectRepositoryDir(config, repository),
    ".understand-anything",
    "knowledge-graph.json",
  );
}

export function resetUnderstandAnythingProcessesForTests(): void {
  for (const dashboard of dashboards.values()) {
    dashboard.child.kill();
  }
  dashboards.clear();
  dashboardPreparation.clear();
}

async function generateProjectKnowledgeGraph(
  config: AppConfig,
  repository: RepositoryConfig,
  pluginRoot: string,
  input: { full?: boolean },
): Promise<void> {
  const repoDir = await prepareRepositoryCheckout(config, repository);
  await prepareOfficialCore(pluginRoot);
  await writeStoredState(config, repository, {
    status: "generating",
    message:
      "The official Understand-Anything multi-agent pipeline is generating the project graph.",
    updatedAt: new Date().toISOString(),
  });

  const language = process.env.UNDERSTAND_ANYTHING_LANGUAGE ?? "zh";
  const argumentsText = [
    repoDir,
    input.full ? "--full" : "",
    "--language",
    language,
  ]
    .filter(Boolean)
    .join(" ");
  const prompt = [
    "Use the official `$understand` skill from Lum1104/Understand-Anything.",
    `Its installed skill definition is at ${path.join(pluginRoot, "skills", "understand", "SKILL.md")}; read and follow that upstream workflow if skill discovery has not named it automatically.`,
    `Run it for this managed project checkout with these arguments: ${argumentsText}`,
    "This generation was explicitly requested from the dashboard. If `.understand-anything/.understandignore` is generated or already exists, its current defaults are approved for this run; continue the official pipeline without waiting for another confirmation.",
    "Do not create a replacement graph or a simplified visualization. Completion requires the official `.understand-anything/knowledge-graph.json` artifact.",
  ].join("\n");
  const codex = process.env.CODEX_COMMAND ?? "codex";
  const result = await runCommand({
    cwd: repoDir,
    command: `${shellQuote(codex)} -a never exec --ephemeral -s workspace-write --skip-git-repo-check -C ${shellQuote(repoDir)} ${shellQuote(prompt)}`,
    stdin: "",
    timeoutMs: Number(
      process.env.UNDERSTAND_ANYTHING_TIMEOUT_MS ?? 90 * 60_000,
    ),
  });

  await writeFile(
    path.join(path.dirname(repoDir), "generation.log"),
    `${result.stdout}\n${result.stderr}`.trim(),
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Official Understand-Anything analysis failed: ${failureMessage(result)}`,
    );
  }

  if (!(await pathExists(projectGraphFile(config, repository)))) {
    throw new Error(
      "Official Understand-Anything analysis finished without producing .understand-anything/knowledge-graph.json.",
    );
  }

  await writeStoredState(config, repository, {
    status: "ready",
    message: "Knowledge graph generated by Understand-Anything.",
    updatedAt: new Date().toISOString(),
  });
}

export async function prepareRepositoryCheckout(
  config: AppConfig,
  repository: RepositoryConfig,
): Promise<string> {
  const repoDir = projectRepositoryDir(config, repository);
  const remoteUrl = createGitHubRemoteUrl(
    repository.github_owner,
    repository.github_repo,
    await getGitHubAuthToken(config.github),
  );
  await mkdir(path.dirname(repoDir), { recursive: true });

  if (!(await pathExists(path.join(repoDir, ".git")))) {
    const result = await runCommand({
      cwd: path.dirname(repoDir),
      command: `git clone --depth 1 --branch ${shellQuote(repository.default_branch)} ${shellQuote(remoteUrl)} ${shellQuote(repoDir)}`,
      timeoutMs: 10 * 60_000,
    });
    assertCommandSucceeded(result, "clone repository", remoteUrl);
    return repoDir;
  }

  const setRemote = await runCommand({
    cwd: repoDir,
    command: `git remote set-url origin ${shellQuote(remoteUrl)}`,
    timeoutMs: 60_000,
  });
  assertCommandSucceeded(setRemote, "set repository remote", remoteUrl);
  const fetch = await runCommand({
    cwd: repoDir,
    command: `git fetch --depth 1 origin ${shellQuote(repository.default_branch)}`,
    timeoutMs: 10 * 60_000,
  });
  assertCommandSucceeded(fetch, "refresh repository", remoteUrl);
  const checkout = await runCommand({
    cwd: repoDir,
    command: `git checkout -B understand-anything-dashboard ${shellQuote(`origin/${repository.default_branch}`)}`,
    timeoutMs: 60_000,
  });
  assertCommandSucceeded(checkout, "checkout repository baseline", remoteUrl);
  return repoDir;
}

async function resolveUnderstandAnythingPluginRoot(): Promise<
  string | undefined
> {
  const configuredRoot = process.env.UNDERSTAND_ANYTHING_PLUGIN_ROOT;
  const candidates = configuredRoot
    ? [configuredRoot]
    : [
        path.join(os.homedir(), ".understand-anything-plugin"),
        path.join(
          os.homedir(),
          ".understand-anything",
          "repo",
          "understand-anything-plugin",
        ),
        path.join(
          os.homedir(),
          ".codex",
          "understand-anything",
          "understand-anything-plugin",
        ),
      ];

  for (const candidate of candidates) {
    if (
      await pathExists(path.join(candidate, "skills", "understand", "SKILL.md"))
    ) {
      return candidate;
    }
  }

  return undefined;
}

async function prepareOfficialCore(pluginRoot: string): Promise<void> {
  if (
    await pathExists(
      path.join(pluginRoot, "packages", "core", "dist", "index.js"),
    )
  ) {
    return;
  }

  const install = await runCommand({
    cwd: pluginRoot,
    command: "pnpm install --frozen-lockfile",
    timeoutMs: 10 * 60_000,
  });
  assertCommandSucceeded(install, "install Understand-Anything dependencies");
  const build = await runCommand({
    cwd: pluginRoot,
    command: "pnpm --filter @understand-anything/core build",
    timeoutMs: 10 * 60_000,
  });
  assertCommandSucceeded(build, "build Understand-Anything core");
}

async function prepareOfficialDashboard(pluginRoot: string): Promise<void> {
  const existing = dashboardPreparation.get(pluginRoot);

  if (existing) {
    return existing;
  }

  const preparation = (async () => {
    const dashboardDir = path.join(pluginRoot, "packages", "dashboard");
    const install = await runCommand({
      cwd: dashboardDir,
      command: "pnpm install --frozen-lockfile",
      timeoutMs: 10 * 60_000,
    });
    assertCommandSucceeded(
      install,
      "install Understand-Anything dashboard dependencies",
    );
    await prepareOfficialCore(pluginRoot);
  })();

  dashboardPreparation.set(pluginRoot, preparation);

  try {
    await preparation;
  } catch (error) {
    dashboardPreparation.delete(pluginRoot);
    throw error;
  }
}

async function readGraphSummary(
  filePath: string,
): Promise<ProjectKnowledgeGraphState["graph"] | undefined> {
  const content = await readFile(filePath, "utf8").catch(() => "");

  if (!content) {
    return undefined;
  }

  try {
    const value = JSON.parse(content) as {
      project?: { name?: unknown; analyzedAt?: unknown };
      nodes?: unknown[];
      edges?: unknown[];
    };

    return {
      projectName:
        typeof value.project?.name === "string"
          ? value.project.name
          : undefined,
      analyzedAt:
        typeof value.project?.analyzedAt === "string"
          ? value.project.analyzedAt
          : undefined,
      nodes: Array.isArray(value.nodes) ? value.nodes.length : undefined,
      edges: Array.isArray(value.edges) ? value.edges.length : undefined,
    };
  } catch {
    return undefined;
  }
}

async function readStoredState(
  config: AppConfig,
  repository: RepositoryConfig,
): Promise<StoredGenerationState | undefined> {
  const content = await readFile(
    projectStateFile(config, repository),
    "utf8",
  ).catch(() => "");

  if (!content) {
    return undefined;
  }

  try {
    return JSON.parse(content) as StoredGenerationState;
  } catch {
    return undefined;
  }
}

async function writeStoredState(
  config: AppConfig,
  repository: RepositoryConfig,
  state: StoredGenerationState,
): Promise<void> {
  const filePath = projectStateFile(config, repository);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryFile = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(state, null, 2));
  await rename(temporaryFile, filePath);
}

function projectStateFile(
  config: AppConfig,
  repository: RepositoryConfig,
): string {
  return path.join(
    config.rootDir,
    "data",
    "understand-anything",
    repositoryStorageKey(repository),
    "status.json",
  );
}

function repositoryStorageKey(repository: RepositoryConfig): string {
  return `${repository.github_owner}--${repository.github_repo}`.replace(
    /[^A-Za-z0-9._-]+/g,
    "-",
  );
}

function assertCommandSucceeded(
  result: CommandResult,
  action: string,
  secretUrl?: string,
): void {
  if (result.exitCode !== 0) {
    const output = secretUrl
      ? redactRemoteUrl(`${result.stderr}\n${result.stdout}`)
      : `${result.stderr}\n${result.stdout}`;
    throw new Error(
      `Failed to ${action}: ${output.trim() || `exit ${result.exitCode}`}`,
    );
  }
}

function failureMessage(result: CommandResult): string {
  return (
    redactRemoteUrl(`${result.stderr}\n${result.stdout}`).trim().slice(-4000) ||
    `exit ${result.exitCode}`
  );
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a dashboard port."));
        return;
      }

      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForDashboard(
  port: number,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        "The official Understand-Anything dashboard process exited before it became available.",
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);

      if (response.ok) {
        return;
      }
    } catch {
      // Vite may still be compiling.
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    "Timed out while starting the official Understand-Anything dashboard.",
  );
}
