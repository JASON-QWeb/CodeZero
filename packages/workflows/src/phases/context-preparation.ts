import path from "node:path";
import {
  buildCodeGraphTaskContext,
  buildContextPack,
  buildNavigationRoute,
  buildRepoNavigationGraph,
  indexFiles,
  indexRepositoryWithCodeGraph,
  indexSymbols,
  type CodeGraphContextResult,
  type CodeGraphIndexResult,
} from "@agent/codebase-intelligence";
import type { RepositoryConfig } from "@agent/config";
import { redactRemoteUrl } from "@agent/github";
import { toContextMemories } from "@agent/memory";
import {
  loadProjectContext,
  summarizeProjectContext,
} from "@agent/project-context";
import {
  cloneRepository,
  cloneRepositoryBranch,
  createSandboxManager,
  runCommand,
  type Sandbox,
} from "@agent/sandbox";
import type { ContextPack, Task } from "@agent/shared";
import { pathExists, shellQuote } from "@agent/shared";
import { authenticatedRemoteUrl } from "./github-utils.js";
import { createConfiguredMemoryStore } from "./memory-store.js";
import {
  ensureSandboxDirectories,
  hydrateSandboxConfig,
  taskSandbox,
  taskSandboxPatch,
} from "./sandbox-utils.js";
import type { WorkflowServices } from "./types.js";

export async function prepareSandbox(
  host: WorkflowServices,
  task: Task,
  repositoryConfig: RepositoryConfig,
): Promise<{ task: Task; sandbox: Sandbox }> {
  const existingSandbox = taskSandbox(task);
  if (
    existingSandbox &&
    (await pathExists(path.join(existingSandbox.repoDir, ".git")))
  ) {
    const restoredSandbox = hydrateSandboxConfig(existingSandbox, host.config);
    await host.event(
      task.id,
      "SANDBOX_CREATED",
      `Reusing persistent task sandbox at ${restoredSandbox.repoDir}`,
      "info",
      {
        repoDir: restoredSandbox.repoDir,
        artifactDir: restoredSandbox.artifactDir,
        reused: true,
      },
    );
    return { task, sandbox: restoredSandbox };
  }

  const updated =
    task.status === "SANDBOX_PREPARING"
      ? task
      : await host.updateStatus(task.id, "SANDBOX_PREPARING");
  const manager = createSandboxManager({
    mode: host.config.sandbox.mode,
    rootDir: path.resolve(host.config.rootDir, host.config.sandbox.root_dir),
    dockerImage: host.config.sandbox.image,
    networkAllowlist: host.config.sandbox.network.allow,
    maxRuntimeMinutes: host.config.sandbox.limits.max_runtime_minutes,
    maxDiffFiles: host.config.sandbox.limits.max_diff_files,
    maxDiffLines: host.config.sandbox.limits.max_diff_lines,
    filesystemAllowRepoOnly: host.config.sandbox.filesystem.allow_repo_only,
    docker: {
      memory: host.config.sandbox.docker.memory,
      cpus: host.config.sandbox.docker.cpus,
      pidsLimit: host.config.sandbox.docker.pids_limit,
    },
  });
  const sandbox =
    existingSandbox ??
    (await manager.create({ taskId: task.id, issue: task.issue }));
  await ensureSandboxDirectories(sandbox);
  await host.event(
    task.id,
    "SANDBOX_CREATED",
    `${existingSandbox ? "Persistent task sandbox restored" : "Sandbox created"} at ${sandbox.repoDir}`,
    "info",
    {
      repoDir: sandbox.repoDir,
      artifactDir: sandbox.artifactDir,
      reused: Boolean(existingSandbox),
    },
  );
  const remoteUrl = await authenticatedRemoteUrl(host, repositoryConfig);
  const results = await cloneRepository({
    sandbox,
    remoteUrl,
    baseBranch: repositoryConfig.default_branch,
    issueBranch: task.branchName ?? `agent/issue-${task.issue.number}`,
    timeoutMs: host.config.sandbox.limits.max_runtime_minutes * 60_000,
  });

  for (const result of results) {
    await host.event(
      task.id,
      "COMMAND_FINISHED",
      `${redactRemoteUrl(result.command)} exited ${result.exitCode}`,
      result.exitCode === 0 ? "info" : "error",
    );
  }

  if (results.some((result) => result.exitCode !== 0)) {
    throw new Error("Repository clone or issue branch creation failed");
  }

  await host.event(
    task.id,
    "REPO_CLONED",
    "Repository cloned and issue branch created",
  );
  return {
    task: await host.updateStatus(updated.id, "ISSUE_BRANCH_CREATED", {
      sandbox: taskSandboxPatch(sandbox),
    }),
    sandbox,
  };
}

export async function prepareExistingPrSandbox(
  host: WorkflowServices,
  task: Task,
  repositoryConfig: RepositoryConfig,
): Promise<Sandbox> {
  await host.event(
    task.id,
    "PR_REVIEW_COMMENT_RECEIVED",
    "PR review feedback queued for same-branch iteration",
    "info",
    {
      prUrl: task.prUrl ?? null,
      branchName: task.branchName ?? null,
    },
  );
  const manager = createSandboxManager({
    mode: host.config.sandbox.mode,
    rootDir: path.resolve(host.config.rootDir, host.config.sandbox.root_dir),
    dockerImage: host.config.sandbox.image,
    networkAllowlist: host.config.sandbox.network.allow,
    maxRuntimeMinutes: host.config.sandbox.limits.max_runtime_minutes,
    maxDiffFiles: host.config.sandbox.limits.max_diff_files,
    maxDiffLines: host.config.sandbox.limits.max_diff_lines,
    filesystemAllowRepoOnly: host.config.sandbox.filesystem.allow_repo_only,
    docker: {
      memory: host.config.sandbox.docker.memory,
      cpus: host.config.sandbox.docker.cpus,
      pidsLimit: host.config.sandbox.docker.pids_limit,
    },
  });
  const existingSandbox = taskSandbox(task);
  const branch = task.branchName ?? `agent/issue-${task.issue.number}`;
  if (
    existingSandbox &&
    (await pathExists(path.join(existingSandbox.repoDir, ".git")))
  ) {
    const restoredSandbox = hydrateSandboxConfig(existingSandbox, host.config);
    const checkout = await runCommand({
      cwd: restoredSandbox.repoDir,
      command: `git checkout ${shellQuote(branch)}`,
      timeoutMs: 60_000,
    });
    await host.event(
      task.id,
      "COMMAND_FINISHED",
      `${checkout.command} exited ${checkout.exitCode}`,
      checkout.exitCode === 0 ? "info" : "error",
    );

    if (checkout.exitCode !== 0) {
      throw new Error("Persistent PR sandbox branch checkout failed");
    }

    await host.event(
      task.id,
      "REPO_CLONED",
      "Persistent PR sandbox reused for feedback iteration",
      "info",
      {
        repoDir: restoredSandbox.repoDir,
        branchName: branch,
        reused: true,
      },
    );
    return restoredSandbox;
  }

  const sandbox =
    existingSandbox ??
    (await manager.create({ taskId: task.id, issue: task.issue }));
  await ensureSandboxDirectories(sandbox);
  const remoteUrl = await authenticatedRemoteUrl(host, repositoryConfig);
  const results = await cloneRepositoryBranch({
    sandbox,
    remoteUrl,
    branch,
    timeoutMs: host.config.sandbox.limits.max_runtime_minutes * 60_000,
  });

  for (const result of results) {
    await host.event(
      task.id,
      "COMMAND_FINISHED",
      `${redactRemoteUrl(result.command)} exited ${result.exitCode}`,
      result.exitCode === 0 ? "info" : "error",
    );
  }

  if (results.some((result) => result.exitCode !== 0)) {
    throw new Error("Existing PR branch clone failed");
  }

  await host.event(
    task.id,
    "REPO_CLONED",
    "Existing PR branch cloned for feedback iteration",
  );
  return sandbox;
}

export async function createContextPack(
  host: WorkflowServices,
  task: Task,
  sandbox: Sandbox,
  repositoryConfig: RepositoryConfig,
): Promise<ContextPack> {
  await host.updateStatus(task.id, "CODEBASE_INDEXING");
  const codeGraphIndex = await createCodeGraphIndex(
    host,
    task,
    sandbox,
    repositoryConfig,
  );
  const codeGraphContext =
    codeGraphIndex?.status === "success"
      ? await createCodeGraphContext(host, task, sandbox, repositoryConfig)
      : undefined;
  const files = await indexFiles(sandbox.repoDir);
  const symbols = await indexSymbols(sandbox.repoDir, files);
  const projectContext = await loadProjectContext(
    sandbox.repoDir,
    repositoryConfig.project_skill_path,
    repositoryConfig.project_rule_path,
  );
  const businessRules = [summarizeProjectContext(projectContext)].filter(
    (entry): entry is string => Boolean(entry),
  );
  const memoryStore = createConfiguredMemoryStore(host.config);
  const memoryResults = await memoryStore.search(task.issue, 8);
  const memories = toContextMemories(memoryResults);
  await host.event(
    task.id,
    "CODEBASE_INDEXED",
    `Indexed ${files.length} files and ${symbols.length} symbols`,
  );
  const navigationRoute = repositoryConfig.codebase_intelligence
    .navigation_graph.enabled
    ? await createNavigationRoute(
        host,
        task,
        sandbox,
        repositoryConfig,
        files,
        symbols,
        businessRules,
      )
    : undefined;
  await host.updateStatus(task.id, "AGENTIC_SEARCHING");
  const contextPack = await buildContextPack({
    taskId: task.id,
    issue: task.issue,
    repoDir: sandbox.repoDir,
    files,
    symbols,
    businessRules,
    memories,
    codeGraphContext: codeGraphContext?.context,
    navigationRoute,
  });
  await host.writeArtifact(
    task.id,
    "memory-context",
    "memory-context.json",
    JSON.stringify(memories, null, 2),
  );
  await host.event(
    task.id,
    "MEMORY_RETRIEVED",
    `Retrieved ${memories.length} approved memory records`,
    "info",
    {
      memoryIds: memories.map((memory) => memory.id),
    },
  );
  await host.writeArtifact(
    task.id,
    "context-pack",
    "context-pack.json",
    JSON.stringify(contextPack, null, 2),
  );
  await host.event(
    task.id,
    "CONTEXT_PACK_CREATED",
    `ContextPack created with ${contextPack.relevantFiles.length} files`,
  );
  return contextPack;
}

export async function createCodeGraphIndex(
  host: WorkflowServices,
  task: Task,
  sandbox: Sandbox,
  repositoryConfig: RepositoryConfig,
): Promise<CodeGraphIndexResult | undefined> {
  const config = repositoryConfig.codebase_intelligence.codegraph;

  if (!config.enabled) {
    await host.event(
      task.id,
      "CODEBASE_INDEXED",
      "CodeGraph indexing is disabled for this repository",
      "debug",
    );
    return undefined;
  }

  const result = await indexRepositoryWithCodeGraph({
    repoDir: sandbox.repoDir,
    packageName: config.package,
    initArgs: config.init_args,
    timeoutMs: config.timeout_ms,
    cacheDatabaseFile: codeGraphCacheDatabaseFile(host, repositoryConfig),
  });

  await host.writeArtifact(
    task.id,
    "repo-graph",
    "codegraph-index.json",
    JSON.stringify(result, null, 2),
  );

  if (result.status === "success") {
    const action =
      result.operation === "initialized" ? "initialized" : "synced";
    await host.event(
      task.id,
      "CODEBASE_INDEXED",
      `CodeGraph index ${action}`,
      "info",
      {
        command: result.displayCommand,
        durationMs: result.durationMs,
        indexDir: result.indexDir,
        databaseFile: result.databaseFile,
        cacheDatabaseFile: result.cacheDatabaseFile ?? null,
        restoredFromCache: result.restoredFromCache,
        changeDetection: result.changeDetection,
      },
    );
    return result;
  }

  await host.event(
    task.id,
    "CODEBASE_INDEXED",
    "CodeGraph index initialization or sync failed",
    "error",
    {
      command: result.displayCommand,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(-4000),
      stdout: result.stdout.slice(-4000),
    },
  );

  if (config.fail_on_error) {
    throw new Error(
      `CodeGraph initialization or sync failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }

  return result;
}

export async function createCodeGraphContext(
  host: WorkflowServices,
  task: Task,
  sandbox: Sandbox,
  repositoryConfig: RepositoryConfig,
): Promise<CodeGraphContextResult> {
  const config = repositoryConfig.codebase_intelligence.codegraph;
  const result = await buildCodeGraphTaskContext({
    repoDir: sandbox.repoDir,
    task: [task.issue.title, task.issue.body, task.issue.labels.join(" ")]
      .filter(Boolean)
      .join("\n"),
    packageName: config.package,
    timeoutMs: config.timeout_ms,
    maxNodes: 30,
    maxCode: 10,
  });

  await host.writeArtifact(
    task.id,
    "repo-graph",
    "codegraph-context.json",
    JSON.stringify(result, null, 2),
  );

  if (result.status === "success") {
    const relatedFiles = Array.isArray(result.context?.relatedFiles)
      ? result.context.relatedFiles.length
      : 0;
    await host.event(
      task.id,
      "AGENTIC_SEARCH_FINISHED",
      `CodeGraph task context created with ${relatedFiles} related files`,
      "info",
      {
        command: result.displayCommand,
        durationMs: result.durationMs,
        relatedFiles,
      },
    );
    return result;
  }

  await host.event(
    task.id,
    "AGENTIC_SEARCH_FINISHED",
    "CodeGraph task context creation failed",
    "error",
    {
      command: result.displayCommand,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(-4000),
      stdout: result.stdout.slice(-4000),
    },
  );

  if (config.fail_on_error) {
    throw new Error(
      `CodeGraph context failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }

  return result;
}

export async function syncCodeGraphAfterImplementation(
  host: WorkflowServices,
  task: Task,
  sandbox: Sandbox,
  repositoryConfig: RepositoryConfig,
): Promise<void> {
  const config = repositoryConfig.codebase_intelligence.codegraph;

  if (!config.enabled) {
    return;
  }

  const result = await indexRepositoryWithCodeGraph({
    repoDir: sandbox.repoDir,
    packageName: config.package,
    initArgs: config.init_args,
    timeoutMs: config.timeout_ms,
  });

  await host.writeArtifact(
    task.id,
    "repo-graph",
    "codegraph-working-tree-sync.json",
    JSON.stringify(result, null, 2),
  );

  if (result.status === "success") {
    await host.event(
      task.id,
      "CODEBASE_INDEXED",
      "CodeGraph synced after implementation changes",
      "info",
      {
        command: result.displayCommand,
        durationMs: result.durationMs,
        databaseFile: result.databaseFile,
        changeDetection: result.changeDetection,
      },
    );
    return;
  }

  await host.event(
    task.id,
    "CODEBASE_INDEXED",
    "CodeGraph post-implementation sync failed",
    "error",
    {
      command: result.displayCommand,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(-4000),
      stdout: result.stdout.slice(-4000),
    },
  );

  if (config.fail_on_error) {
    throw new Error(
      `CodeGraph post-implementation sync failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }
}

export function codeGraphCacheDatabaseFile(
  host: WorkflowServices,
  repositoryConfig: RepositoryConfig,
): string {
  return path.join(
    host.config.rootDir,
    "data",
    "codegraph",
    repositoryStorageKey(repositoryConfig),
    "codegraph.db",
  );
}

export async function createNavigationRoute(
  host: WorkflowServices,
  task: Task,
  sandbox: Sandbox,
  repositoryConfig: RepositoryConfig,
  files: Awaited<ReturnType<typeof indexFiles>>,
  symbols: Awaited<ReturnType<typeof indexSymbols>>,
  businessRules: string[],
) {
  const repoGraph = await buildRepoNavigationGraph({
    repoDir: sandbox.repoDir,
    files,
    symbols,
    businessRules,
    includeGitHistory:
      repositoryConfig.codebase_intelligence.navigation_graph
        .include_git_history,
  });
  await host.writeArtifact(
    task.id,
    "repo-graph",
    "repo-navigation-graph.json",
    JSON.stringify(repoGraph, null, 2),
  );
  await host.event(
    task.id,
    "REPO_NAVIGATION_GRAPH_CREATED",
    `Repo navigation graph created with ${repoGraph.nodes.length} nodes and ${repoGraph.edges.length} edges`,
  );
  const navigationRoute = buildNavigationRoute({
    taskId: task.id,
    issue: task.issue,
    graph: repoGraph,
    files,
    symbols,
  });
  await host.writeArtifact(
    task.id,
    "navigation-route",
    "navigation-route.json",
    JSON.stringify(navigationRoute, null, 2),
  );
  await host.event(
    task.id,
    "NAVIGATION_ROUTE_CREATED",
    `Navigation route created with ${navigationRoute.mustRead.length} read targets and ${navigationRoute.tests.length} tests`,
  );
  return navigationRoute;
}

function repositoryStorageKey(
  repositoryConfig: Pick<RepositoryConfig, "github_owner" | "github_repo">,
): string {
  return `${repositoryConfig.github_owner}--${repositoryConfig.github_repo}`.replace(
    /[^A-Za-z0-9._-]+/g,
    "-",
  );
}
