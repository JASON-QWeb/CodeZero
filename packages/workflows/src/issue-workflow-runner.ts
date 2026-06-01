import os from "node:os";
import path from "node:path";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import {
  runJsonAgent,
  type AgentDefinition,
  type AgentRunner,
} from "@agent/model-runtime";
import {
  buildContextPack,
  buildNavigationRoute,
  buildRepoNavigationGraph,
  buildCodeGraphTaskContext,
  indexFiles,
  indexRepositoryWithCodeGraph,
  indexSymbols,
  readContextFileSnippets,
  type CodeGraphContextResult,
  type CodeGraphIndexResult,
} from "@agent/codebase-intelligence";
import {
  findRepository,
  type AppConfig,
  type RepositoryConfig,
} from "@agent/config";
import {
  createGitHubRemoteUrl,
  GitHubClient,
  redactRemoteUrl,
} from "@agent/github";
import {
  createTaskMemoryProposal,
  FileMemoryStore,
  toContextMemories,
} from "@agent/memory";
import {
  allQualityGatesPassed,
  reviewAllowsPr,
  shouldRequirePrdReview,
  transitionTask,
} from "@agent/orchestrator";
import { createTaskEvent, type TaskRepository } from "@agent/persistence";
import {
  loadProjectContext,
  summarizeProjectContext,
} from "@agent/project-context";
import {
  cloneRepository,
  cloneRepositoryBranch,
  commitAll,
  DockerSandboxManager,
  getCurrentCommitSha,
  getGitDiff,
  listChangedFiles,
  pushBranch,
  runCommand,
  type Sandbox,
} from "@agent/sandbox";
import type {
  Artifact,
  ContextPack,
  JsonObject,
  JsonValue,
  PlanningDocument,
  QualityGateResult,
  ReviewResult,
  Task,
} from "@agent/shared";
import { loadPlatformSkills } from "@agent/skills";
import {
  createQualityGateCommands,
  runFrontendScreenshotGate,
  runQualityGates,
} from "@agent/verification";
import {
  createExecutionAgents,
  createWorkflowAgent,
  createWorkflowAgentRunner,
} from "./agent-factory.js";
import { createArtifactId, writeTaskArtifact } from "./artifacts.js";
import {
  buildCodingExecutorPrompt,
  normalizeImplementationExecutorConfig,
  runCodingCliExecutor,
  type NormalizedImplementationExecutorConfig,
} from "./coding-executor.js";
import {
  assertAgentPrBodyComplete,
  createAgentPrBody,
  createPrdIssueComment,
  createPrFeedbackUpdateComment,
  createPrReadyIssueComment,
  createPrLocalVerificationPlan,
  detectInstallCommand,
  detectIssueLocale,
  languageInstruction,
} from "./pr-local-verification.js";
import { planningDocumentSchema, reviewSchema } from "./schemas.js";

export type IssueWorkflowResult = {
  taskId: string;
  status: Task["status"];
  prUrl?: string;
};

export class IssueWorkflowRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly tasks: TaskRepository,
  ) {}

  async run(taskId: string): Promise<IssueWorkflowResult> {
    const task = await this.requiredTask(taskId);

    try {
      const repositoryConfig = this.requiredRepository(task);
      if (this.shouldRunPrFeedbackIteration(task)) {
        return await this.runPrFeedbackIteration(task, repositoryConfig);
      }

      const runner = await createWorkflowAgentRunner(this.config);
      const planningAgent = await createWorkflowAgent(
        this.config,
        "prd",
        "prd",
      );

      let updated = task;
      const planningWasCreated = !updated.planningDocument;
      const approvalAlreadySatisfied = updated.status === "PRD_APPROVED";
      if (
        planningWasCreated &&
        (updated.status === "QUEUED" || updated.status === "ISSUE_RECEIVED")
      ) {
        updated = await this.updateStatus(updated.id, "CONTEXT_COLLECTING");
      }

      const prepared = await this.prepareSandbox(updated, repositoryConfig);
      updated = prepared.task;
      const sandbox = prepared.sandbox;

      if (!updated.contextPack) {
        const contextPack = await this.createContextPack(
          updated,
          sandbox,
          repositoryConfig,
        );
        updated = await this.updateStatus(updated.id, "CONTEXT_PACK_CREATED", {
          contextPack,
        });
      }

      let planningDocument = updated.planningDocument;
      if (!planningDocument) {
        planningDocument = await this.draftPlanningDocument(
          updated,
          repositoryConfig,
          runner,
          planningAgent,
        );
        updated = await this.updateStatus(updated.id, "PRD_DRAFTED", {
          planningDocument,
        });
      }
      const agents = await createExecutionAgents(
        this.config,
        planningDocument.complexity.score,
      );

      const requirePrdReview =
        repositoryConfig.workflow?.require_prd_review ?? true;
      const requiresHumanPrdReview =
        requirePrdReview && shouldRequirePrdReview(planningDocument.complexity);
      if (
        !approvalAlreadySatisfied &&
        updated.status !== "PRD_APPROVED" &&
        requiresHumanPrdReview
      ) {
        if (updated.status !== "PRD_REVIEW_REQUIRED") {
          updated = await this.updateStatus(updated.id, "PRD_REVIEW_REQUIRED");
          await this.event(
            updated.id,
            "HUMAN_REVIEW_REQUIRED",
            "PRD requires human approval before implementation",
          );
        }
        if (planningWasCreated) {
          await this.publishPrdIssueComment(
            updated,
            repositoryConfig,
            planningDocument,
            true,
          );
        }
        return { taskId: updated.id, status: updated.status };
      }

      if (updated.status !== "PRD_APPROVED") {
        updated = await this.updateStatus(updated.id, "PRD_APPROVED");
        if (!approvalAlreadySatisfied) {
          await this.event(
            updated.id,
            "PRD_APPROVED",
            requiresHumanPrdReview
              ? "PRD approved"
              : "PRD auto-approved by repository workflow policy",
          );
        }
        if (planningWasCreated) {
          await this.publishPrdIssueComment(
            updated,
            repositoryConfig,
            planningDocument,
            false,
          );
        }
      }

      updated = await this.updateStatus(updated.id, "IMPLEMENTING");

      const selfCheckResult = await this.runImplementationSelfCheckLoop(
        updated,
        sandbox,
        repositoryConfig,
        runner,
        agents.implementation,
        agents.review,
      );
      updated = selfCheckResult.task;

      if (!selfCheckResult.passed) {
        updated = await this.updateStatus(updated.id, "BLOCKED");
        await this.event(
          updated.id,
          "TASK_BLOCKED",
          selfCheckResult.reason,
          "warn",
        );
        return { taskId: updated.id, status: updated.status };
      }

      const prUrl = await this.createDraftPr(
        updated,
        sandbox,
        repositoryConfig,
      );
      updated = await this.updateStatus(updated.id, "WAITING_MERGE", { prUrl });
      return { taskId: updated.id, status: updated.status, prUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.tasks.appendEvent(
        createTaskEvent({
          taskId,
          type: "TASK_FAILED",
          level: "error",
          message,
        }),
      );
      const failed = await this.tasks.updateTask(taskId, { status: "FAILED" });
      return { taskId, status: failed.status };
    }
  }

  shouldRunPrFeedbackIteration(task: Task): boolean {
    return Boolean(
      task.prUrl &&
      task.branchName &&
      task.issue.comments.length > 0 &&
      (task.status === "WAITING_MERGE" ||
        task.status === "HUMAN_REVIEW" ||
        task.status === "BLOCKED"),
    );
  }

  async runPrFeedbackIteration(
    task: Task,
    repositoryConfig: RepositoryConfig,
  ): Promise<IssueWorkflowResult> {
    const runner = await createWorkflowAgentRunner(this.config);
    const agents = await createExecutionAgents(
      this.config,
      task.planningDocument?.complexity.score ?? 30,
    );
    const sandbox = await this.prepareExistingPrSandbox(task, repositoryConfig);
    let updated = await this.updateStatus(task.id, "IMPLEMENTING", { sandbox });
    const feedback = this.latestReviewerFeedback(updated);

    const selfCheckResult = await this.runImplementationSelfCheckLoop(
      updated,
      sandbox,
      repositoryConfig,
      runner,
      agents.implementation,
      agents.review,
      feedback,
    );
    updated = selfCheckResult.task;

    if (!selfCheckResult.passed) {
      updated = await this.updateStatus(updated.id, "BLOCKED");
      await this.event(
        updated.id,
        "TASK_BLOCKED",
        selfCheckResult.reason,
        "warn",
      );
      return {
        taskId: updated.id,
        status: updated.status,
        prUrl: updated.prUrl,
      };
    }

    await this.updateExistingPullRequest(
      updated,
      sandbox,
      repositoryConfig,
      feedback,
    );
    updated = await this.requiredTask(updated.id);
    updated = await this.updateStatus(updated.id, "WAITING_MERGE");
    return { taskId: updated.id, status: updated.status, prUrl: updated.prUrl };
  }

  async draftPlanningDocument(
    task: Task,
    repositoryConfig: RepositoryConfig,
    runner: AgentRunner,
    agent: AgentDefinition,
  ): Promise<PlanningDocument> {
    await this.updateStatus(task.id, "BRAINSTORMING");
    const platformSkills = await loadPlatformSkills(this.config.rootDir);
    const locale = detectIssueLocale(task.issue);
    const result = await runJsonAgent({
      runner,
      agent,
      userPrompt: [
        "Generate one CodeZero planning document JSON. It must include the PRD fields and implementationPlan in the same JSON object. Return only JSON matching the required schema.",
        languageInstruction(locale),
      ].join("\n"),
      context: {
        issue: task.issue as unknown as JsonObject,
        platformSkills: platformSkills.map((skill) => ({
          id: skill.id,
          content: skill.content,
        })),
        contextPack: task.contextPack as unknown as JsonObject,
        repository: {
          owner: repositoryConfig.github_owner,
          repo: repositoryConfig.github_repo,
          defaultBranch: repositoryConfig.default_branch,
          projectSkillPath: repositoryConfig.project_skill_path,
        },
      },
    });
    const planningDocument = planningDocumentSchema.parse(result);
    await this.writeArtifact(
      task.id,
      "prd",
      "planning-document.json",
      JSON.stringify(planningDocument, null, 2),
    );
    await this.event(
      task.id,
      "PRD_DRAFTED",
      `Planning document drafted with complexity ${planningDocument.complexity.score}`,
    );
    return planningDocument;
  }

  async publishPrdIssueComment(
    task: Task,
    repositoryConfig: RepositoryConfig,
    planningDocument: PlanningDocument,
    requiresHumanReview: boolean,
  ): Promise<void> {
    if (!this.config.github.token) {
      await this.event(
        task.id,
        "PRD_DRAFTED",
        "PRD issue comment skipped because GITHUB_TOKEN is not configured",
        "warn",
      );
      return;
    }

    const github = new GitHubClient({ token: this.config.github.token });
    const locale = detectIssueLocale(task.issue);
    const body = createPrdIssueComment({
      task,
      planningDocument,
      requiresHumanReview,
      mention: repositoryConfig.trigger.mention,
      locale,
    });
    const url = await github.createIssueComment({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      issueNumber: task.issue.number,
      body,
    });
    await this.event(
      task.id,
      "PRD_DRAFTED",
      "PRD commented on GitHub issue",
      "info",
      {
        commentUrl: url,
        requiresHumanReview,
      },
    );
  }

  async prepareSandbox(
    task: Task,
    repositoryConfig: RepositoryConfig,
  ): Promise<{ task: Task; sandbox: Sandbox }> {
    const existingSandbox = taskSandbox(task);
    if (
      existingSandbox &&
      (await pathExists(path.join(existingSandbox.repoDir, ".git")))
    ) {
      await this.event(
        task.id,
        "SANDBOX_CREATED",
        `Reusing persistent task sandbox at ${existingSandbox.repoDir}`,
        "info",
        {
          repoDir: existingSandbox.repoDir,
          artifactDir: existingSandbox.artifactDir,
          reused: true,
        },
      );
      return { task, sandbox: existingSandbox };
    }

    const updated =
      task.status === "SANDBOX_PREPARING"
        ? task
        : await this.updateStatus(task.id, "SANDBOX_PREPARING");
    const manager = new DockerSandboxManager({
      mode: this.config.sandbox.mode,
      rootDir: path.resolve(this.config.rootDir, this.config.sandbox.root_dir),
      dockerImage: this.config.sandbox.image,
      networkAllowlist: this.config.sandbox.network.allow,
      maxRuntimeMinutes: this.config.sandbox.limits.max_runtime_minutes,
    });
    const sandbox =
      existingSandbox ??
      (await manager.create({ taskId: task.id, issue: task.issue }));
    await ensureSandboxDirectories(sandbox);
    await this.event(
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
    const remoteUrl = createGitHubRemoteUrl(
      repositoryConfig.github_owner,
      repositoryConfig.github_repo,
      this.config.github.token,
    );
    const results = await cloneRepository({
      sandbox,
      remoteUrl,
      baseBranch: repositoryConfig.default_branch,
      issueBranch: task.branchName ?? `agent/issue-${task.issue.number}`,
      timeoutMs: this.config.sandbox.limits.max_runtime_minutes * 60_000,
    });

    for (const result of results) {
      await this.event(
        task.id,
        "COMMAND_FINISHED",
        `${redactRemoteUrl(result.command)} exited ${result.exitCode}`,
        result.exitCode === 0 ? "info" : "error",
      );
    }

    if (results.some((result) => result.exitCode !== 0)) {
      throw new Error("Repository clone or issue branch creation failed");
    }

    await this.event(
      task.id,
      "REPO_CLONED",
      "Repository cloned and issue branch created",
    );
    return {
      task: await this.updateStatus(updated.id, "ISSUE_BRANCH_CREATED", {
        sandbox: taskSandboxPatch(sandbox),
      }),
      sandbox,
    };
  }

  private async prepareExistingPrSandbox(
    task: Task,
    repositoryConfig: RepositoryConfig,
  ): Promise<Sandbox> {
    await this.event(
      task.id,
      "PR_REVIEW_COMMENT_RECEIVED",
      "PR review feedback queued for same-branch iteration",
      "info",
      {
        prUrl: task.prUrl ?? null,
        branchName: task.branchName ?? null,
      },
    );
    const manager = new DockerSandboxManager({
      mode: this.config.sandbox.mode,
      rootDir: path.resolve(this.config.rootDir, this.config.sandbox.root_dir),
      dockerImage: this.config.sandbox.image,
      networkAllowlist: this.config.sandbox.network.allow,
      maxRuntimeMinutes: this.config.sandbox.limits.max_runtime_minutes,
    });
    const existingSandbox = taskSandbox(task);
    const branch = task.branchName ?? `agent/issue-${task.issue.number}`;
    if (
      existingSandbox &&
      (await pathExists(path.join(existingSandbox.repoDir, ".git")))
    ) {
      const checkout = await runCommand({
        cwd: existingSandbox.repoDir,
        command: `git checkout ${shellQuote(branch)}`,
        timeoutMs: 60_000,
      });
      await this.event(
        task.id,
        "COMMAND_FINISHED",
        `${checkout.command} exited ${checkout.exitCode}`,
        checkout.exitCode === 0 ? "info" : "error",
      );

      if (checkout.exitCode !== 0) {
        throw new Error("Persistent PR sandbox branch checkout failed");
      }

      await this.event(
        task.id,
        "REPO_CLONED",
        "Persistent PR sandbox reused for feedback iteration",
        "info",
        {
          repoDir: existingSandbox.repoDir,
          branchName: branch,
          reused: true,
        },
      );
      return existingSandbox;
    }

    const sandbox =
      existingSandbox ??
      (await manager.create({ taskId: task.id, issue: task.issue }));
    await ensureSandboxDirectories(sandbox);
    const remoteUrl = createGitHubRemoteUrl(
      repositoryConfig.github_owner,
      repositoryConfig.github_repo,
      this.config.github.token,
    );
    const results = await cloneRepositoryBranch({
      sandbox,
      remoteUrl,
      branch,
      timeoutMs: this.config.sandbox.limits.max_runtime_minutes * 60_000,
    });

    for (const result of results) {
      await this.event(
        task.id,
        "COMMAND_FINISHED",
        `${redactRemoteUrl(result.command)} exited ${result.exitCode}`,
        result.exitCode === 0 ? "info" : "error",
      );
    }

    if (results.some((result) => result.exitCode !== 0)) {
      throw new Error("Existing PR branch clone failed");
    }

    await this.event(
      task.id,
      "REPO_CLONED",
      "Existing PR branch cloned for feedback iteration",
    );
    return sandbox;
  }

  async createContextPack(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
  ) {
    await this.updateStatus(task.id, "CODEBASE_INDEXING");
    const codeGraphIndex = await this.createCodeGraphIndex(
      task,
      sandbox,
      repositoryConfig,
    );
    const codeGraphContext =
      codeGraphIndex?.status === "success"
        ? await this.createCodeGraphContext(task, sandbox, repositoryConfig)
        : undefined;
    const files = await indexFiles(sandbox.repoDir);
    const symbols = await indexSymbols(sandbox.repoDir, files);
    const projectContext = await loadProjectContext(
      sandbox.repoDir,
      repositoryConfig.project_skill_path,
    );
    const businessRules = [
      summarizeProjectContext(projectContext),
    ].filter((entry): entry is string => Boolean(entry));
    const memoryStore = new FileMemoryStore(this.config.memory.filePath);
    const memoryResults = await memoryStore.search(task.issue, 8);
    const memories = toContextMemories(memoryResults);
    await this.event(
      task.id,
      "CODEBASE_INDEXED",
      `Indexed ${files.length} files and ${symbols.length} symbols`,
    );
    const navigationRoute = repositoryConfig.codebase_intelligence
      .navigation_graph.enabled
      ? await this.createNavigationRoute(
          task,
          sandbox,
          repositoryConfig,
          files,
          symbols,
          businessRules,
        )
      : undefined;
    await this.updateStatus(task.id, "AGENTIC_SEARCHING");
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
    await this.writeArtifact(
      task.id,
      "memory-context",
      "memory-context.json",
      JSON.stringify(memories, null, 2),
    );
    await this.event(
      task.id,
      "MEMORY_RETRIEVED",
      `Retrieved ${memories.length} approved memory records`,
      "info",
      {
        memoryIds: memories.map((memory) => memory.id),
      },
    );
    await this.writeArtifact(
      task.id,
      "context-pack",
      "context-pack.json",
      JSON.stringify(contextPack, null, 2),
    );
    await this.event(
      task.id,
      "CONTEXT_PACK_CREATED",
      `ContextPack created with ${contextPack.relevantFiles.length} files`,
    );
    return contextPack;
  }

  private async createCodeGraphIndex(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
  ): Promise<CodeGraphIndexResult | undefined> {
    const config = repositoryConfig.codebase_intelligence.codegraph;

    if (!config.enabled) {
      await this.event(
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
      cacheDatabaseFile: this.codeGraphCacheDatabaseFile(repositoryConfig),
    });

    await this.writeArtifact(
      task.id,
      "repo-graph",
      "codegraph-index.json",
      JSON.stringify(result, null, 2),
    );

    if (result.status === "success") {
      const action =
        result.operation === "initialized" ? "initialized" : "synced";
      await this.event(
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

    await this.event(
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

  private async createCodeGraphContext(
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

    await this.writeArtifact(
      task.id,
      "repo-graph",
      "codegraph-context.json",
      JSON.stringify(result, null, 2),
    );

    if (result.status === "success") {
      const relatedFiles = Array.isArray(result.context?.relatedFiles)
        ? result.context.relatedFiles.length
        : 0;
      await this.event(
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

    await this.event(
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

  private async syncCodeGraphAfterImplementation(
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

    await this.writeArtifact(
      task.id,
      "repo-graph",
      "codegraph-working-tree-sync.json",
      JSON.stringify(result, null, 2),
    );

    if (result.status === "success") {
      await this.event(
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

    await this.event(
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

  private codeGraphCacheDatabaseFile(
    repositoryConfig: RepositoryConfig,
  ): string {
    return path.join(
      this.config.rootDir,
      "data",
      "codegraph",
      repositoryStorageKey(repositoryConfig),
      "codegraph.db",
    );
  }

  private async createNavigationRoute(
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
    await this.writeArtifact(
      task.id,
      "repo-graph",
      "repo-navigation-graph.json",
      JSON.stringify(repoGraph, null, 2),
    );
    await this.event(
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
    await this.writeArtifact(
      task.id,
      "navigation-route",
      "navigation-route.json",
      JSON.stringify(navigationRoute, null, 2),
    );
    await this.event(
      task.id,
      "NAVIGATION_ROUTE_CREATED",
      `Navigation route created with ${navigationRoute.mustRead.length} read targets and ${navigationRoute.tests.length} tests`,
    );
    return navigationRoute;
  }

  private async applyImplementation(
    task: Task,
    sandbox: Sandbox,
    agent: AgentDefinition,
    reviewerFeedback = "",
  ): Promise<void> {
    const executor = normalizeImplementationExecutorConfig(
      this.config.sandbox.implementation_executor,
    );

    try {
      await this.applyImplementationWithCodingExecutor(
        task,
        sandbox,
        agent,
        executor,
        reviewerFeedback,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.event(
        task.id,
        "AGENT_RUN_FINISHED",
        "CodeZero implementation executor failed",
        "error",
        {
          executor: executor.name,
          mode: executor.mode,
          error: message.slice(0, 4000),
        },
      );
      throw error;
    }
  }

  private async applyImplementationWithCodingExecutor(
    task: Task,
    sandbox: Sandbox,
    agent: AgentDefinition,
    executor: NormalizedImplementationExecutorConfig,
    reviewerFeedback = "",
  ): Promise<void> {
    const contextPack =
      task.contextPack ?? this.missing<ContextPack>("ContextPack");
    const planningDocument =
      task.planningDocument ??
      this.missing<PlanningDocument>("PlanningDocument");
    const feedbackSnippetPaths = await extractImplementationFeedbackPaths(
      sandbox.repoDir,
      reviewerFeedback,
    );
    const snippets = await readContextFileSnippets(
      sandbox.repoDir,
      contextPack,
      {
        includePaths: uniquePaths([
          ...feedbackSnippetPaths,
          ...selectImplementationSnippetPaths(task),
        ]),
        maxCharsPerFile: 16_000,
        maxFiles: 12,
      },
    );
    const prompt = buildCodingExecutorPrompt({
      task,
      planningDocument,
      implementationContext: compactContextPackForImplementation(contextPack),
      fileSnippets: snippets as JsonObject,
      reviewerFeedback,
      qualityGateResults: task.qualityGateResults,
    });
    const checkpoint = await createImplementationCheckpoint(sandbox.repoDir);

    try {
      await this.event(
        task.id,
        "AGENT_RUN_STARTED",
        "CodeZero implementation executor started",
        "info",
        {
          agentId: agent.id,
          agentRole: agent.role,
          phase: "implementation",
          executor: executor.name,
          mode: executor.mode,
        },
      );
      let result: Awaited<ReturnType<typeof runCodingCliExecutor>>;
      try {
        result = await runCodingCliExecutor({
          config: this.config,
          executor,
          agent,
          task,
          repoDir: sandbox.repoDir,
          artifactDir: sandbox.artifactDir,
          prompt,
          attempt: Date.now(),
          onProgress: async (progress) => {
            await this.event(
              task.id,
              "AGENT_RUN_PROGRESS",
              progress.message,
              progress.level ?? "info",
              {
                ...(progress.metadata ?? {}),
                agentId: agent.id,
                agentRole: agent.role,
                phase: "implementation",
                executor: executor.name,
                mode: executor.mode,
              },
            );
          },
        });
      } catch (error) {
        await restoreImplementationCheckpoint(sandbox.repoDir, checkpoint);
        throw error;
      }

      if (result.commandResult.exitCode !== 0) {
        await restoreImplementationCheckpoint(sandbox.repoDir, checkpoint);
        throw new Error(
          [
            `Implementation executor exited ${result.commandResult.exitCode ?? "without an exit code"}.`,
            result.commandResult.stderr,
            result.commandResult.stdout,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      if (!result.diff) {
        await restoreImplementationCheckpoint(sandbox.repoDir, checkpoint);
        throw new Error(
          "Implementation executor completed but produced no repository diff",
        );
      }

      await this.writeArtifact(
        task.id,
        "tool-call",
        path.basename(result.logPath),
        await readFile(result.logPath, "utf8"),
      );
      await this.writeArtifact(
        task.id,
        "diff",
        "implementation.diff",
        result.diff,
      );
      const changedFiles = await listChangedFiles(sandbox.repoDir);
      await this.event(
        task.id,
        "AGENT_RUN_FINISHED",
        "CodeZero implementation executor finished with repository changes",
        "info",
        {
          agentId: agent.id,
          agentRole: agent.role,
          phase: "implementation",
          executor: executor.name,
          mode: executor.mode,
          durationMs: result.commandResult.durationMs,
        },
      );
      await this.event(
        task.id,
        "FILE_CHANGED",
        "CodeZero implementation executor updated the sandbox working tree",
        "info",
        {
          filePath: changedFiles[0] ?? null,
          filePaths: changedFiles.slice(0, 50),
        },
      );
    } finally {
      await cleanupImplementationCheckpoint(checkpoint);
    }
  }

  async runImplementationSelfCheckLoop(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
    runner: AgentRunner,
    implementationAgent: AgentDefinition,
    reviewAgent: AgentDefinition,
    initialFeedback = "",
  ): Promise<{ task: Task; passed: boolean; reason: string }> {
    let updated = task;
    let implementationFeedback = initialFeedback;
    const configuredMaxAttempts = Math.max(
      1,
      (this.config.sandbox.limits.max_quality_gate_retries ?? 0) + 1,
    );
    const hardMaxAttempts = getSelfCheckHardMaxAttempts(configuredMaxAttempts);
    let maxAttempts = configuredMaxAttempts;
    let previousQualityGateResults: QualityGateResult[] | undefined;
    let previousReviewResult: ReviewResult | undefined;
    let previousSelfCheckFailureKind: "quality" | "review" | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (updated.status !== "IMPLEMENTING") {
        updated = await this.updateStatus(updated.id, "IMPLEMENTING");
      }

      await this.applyImplementation(
        updated,
        sandbox,
        implementationAgent,
        implementationFeedback,
      );
      await this.syncCodeGraphAfterImplementation(
        updated,
        sandbox,
        repositoryConfig,
      );

      const qualityGateResults = await this.runQualityGates(
        updated,
        sandbox,
        repositoryConfig,
      );
      updated = await this.updateStatus(updated.id, "QUALITY_GATES_RUNNING", {
        qualityGateResults,
      });

      if (!allQualityGatesPassed(qualityGateResults)) {
        if (qualityGateFailureLooksEnvironmental(qualityGateResults)) {
          return {
            task: updated,
            passed: false,
            reason:
              "Quality gates failed because the verification environment is unavailable",
          };
        }

        const shouldExtend =
          attempt >= maxAttempts &&
          (shouldExtendQualityGateSelfCheck(
            previousQualityGateResults,
            qualityGateResults,
            attempt,
            hardMaxAttempts,
          ) ||
            shouldExtendSelfCheckAfterFailureKindChange(
              previousSelfCheckFailureKind,
              "quality",
              attempt,
              hardMaxAttempts,
            ));
        if (attempt >= maxAttempts && !shouldExtend) {
          return {
            task: updated,
            passed: false,
            reason: "Quality gates failed after automated repair attempts",
          };
        }

        if (shouldExtend) {
          maxAttempts += 1;
        }
        implementationFeedback = formatQualityGateRepairFeedback(
          qualityGateResults,
          attempt,
          maxAttempts,
        );
        previousQualityGateResults = qualityGateResults;
        previousSelfCheckFailureKind = "quality";
        await this.event(
          updated.id,
          "SELF_CHECK_REPAIR_STARTED",
          `${shouldExtend ? "Quality gates still failed but diagnostics changed; extending automated repair" : "Quality gates failed; starting automated repair"} attempt ${attempt + 1}/${maxAttempts}`,
          "warn",
          {
            attempt: attempt + 1,
            maxAttempts,
            configuredMaxAttempts,
            extended: shouldExtend,
            failedGates: qualityGateResults
              .filter((result) => !result.passed)
              .map((result) => result.kind),
          },
        );
        continue;
      }

      const reviewResult = await this.review(
        updated,
        sandbox,
        runner,
        reviewAgent,
        initialFeedback,
      );
      updated = await this.updateStatus(updated.id, "SUBAGENT_REVIEWING", {
        reviewResult,
      });

      if (reviewAllowsPr(reviewResult)) {
        return { task: updated, passed: true, reason: "Self-check passed" };
      }

      const shouldExtend =
        attempt >= maxAttempts &&
        (shouldExtendReviewSelfCheck(
          previousReviewResult,
          reviewResult,
          attempt,
          hardMaxAttempts,
        ) ||
          shouldExtendSelfCheckAfterFailureKindChange(
            previousSelfCheckFailureKind,
            "review",
            attempt,
            hardMaxAttempts,
          ));
      if (attempt >= maxAttempts && !shouldExtend) {
        return {
          task: updated,
          passed: false,
          reason:
            "Review subagent blocked PR creation after automated repair attempts",
        };
      }

      if (shouldExtend) {
        maxAttempts += 1;
      }
      implementationFeedback = formatReviewRepairFeedback(
        reviewResult,
        attempt,
        maxAttempts,
      );
      previousReviewResult = reviewResult;
      previousSelfCheckFailureKind = "review";
      await this.event(
        updated.id,
        "SELF_CHECK_REPAIR_STARTED",
        `${shouldExtend ? "Review findings changed; extending automated repair" : "Review subagent blocked changes; starting automated repair"} attempt ${attempt + 1}/${maxAttempts}`,
        "warn",
        {
          attempt: attempt + 1,
          maxAttempts,
          configuredMaxAttempts,
          extended: shouldExtend,
          blockingFindings: reviewResult.blockingFindings.length,
          scopeViolations: reviewResult.scopeViolations.length,
        },
      );
    }

    return {
      task: updated,
      passed: false,
      reason: "Self-check did not complete",
    };
  }

  private async runQualityGates(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
  ): Promise<QualityGateResult[]> {
    const gates = createQualityGateCommands({
      setup: repositoryConfig.quality_gates.setup,
      build: repositoryConfig.quality_gates.build,
      lint: repositoryConfig.quality_gates.lint,
      typecheck: repositoryConfig.quality_gates.typecheck,
      unitTest: repositoryConfig.quality_gates.unit_test,
    });
    await this.event(
      task.id,
      "QUALITY_GATE_STARTED",
      `Running ${gates.length} quality gates`,
    );
    const results = await runQualityGates(sandbox.repoDir, gates);
    const taskType = task.planningDocument?.taskType;
    if (
      (taskType === "frontend" || taskType === "fullstack") &&
      repositoryConfig.frontend.dev_command &&
      repositoryConfig.frontend.screenshot_urls.length > 0
    ) {
      const screenshotResult = await runFrontendScreenshotGate({
        cwd: sandbox.repoDir,
        devCommand: repositoryConfig.frontend.dev_command,
        targets: repositoryConfig.frontend.screenshot_urls.map((url) => ({
          url,
        })),
        artifactDir: path.join(sandbox.artifactDir, "screenshots"),
        chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH,
      });
      results.push(screenshotResult.gate);
      for (const screenshot of screenshotResult.screenshots) {
        await this.tasks.addArtifact({
          id: createArtifactId(),
          taskId: task.id,
          type: "screenshot",
          path: screenshot.path,
          metadata: { url: screenshot.url, viewport: screenshot.viewport },
          createdAt: new Date().toISOString(),
        });
      }
    }
    await this.writeArtifact(
      task.id,
      "test-report",
      "quality-gates.json",
      JSON.stringify(results, null, 2),
    );
    await this.event(
      task.id,
      "QUALITY_GATE_FINISHED",
      `${results.filter((result) => result.passed).length}/${results.length} quality gates passed`,
    );
    return results;
  }

  private async review(
    task: Task,
    sandbox: Sandbox,
    runner: AgentRunner,
    agent: AgentDefinition,
    reviewerFeedback = "",
  ): Promise<ReviewResult> {
    const diff = await getGitDiff(sandbox.repoDir);
    const changedFiles = await listChangedFiles(sandbox.repoDir);
    const planningDocument =
      task.planningDocument ??
      this.missing<PlanningDocument>("PlanningDocument");
    const artifacts = await this.tasks.listArtifacts(task.id);
    const screenshotArtifacts =
      this.collectScreenshotArtifactsForPr(artifacts);
    const fileSnippets = task.contextPack
      ? await readContextFileSnippets(sandbox.repoDir, task.contextPack, {
          includePaths: uniquePaths([
            ...changedFiles,
            ...selectImplementationSnippetPaths(task),
          ]),
          maxCharsPerFile: 16_000,
          maxFiles: 12,
        })
      : {};
    const locale = detectIssueLocale(task.issue);
    const result = await runJsonAgent({
      runner,
      agent,
      userPrompt: [
        "Review the draft changes. Return only JSON with approved, findings, missingTests, scopeViolations, riskLevel, and prDescriptionNotes.",
        "Screenshot artifacts captured by CodeZero's frontend_screenshot quality gate are valid visual evidence; do not block only because screenshots are not manually attached when screenshotArtifacts is non-empty.",
        "Use fileSnippets to verify whether referenced CSS classes, design tokens, or helper APIs already exist before reporting them as newly introduced or unknown.",
        reviewerFeedback
          ? `This is a PR feedback iteration. Confirm the diff addresses this latest reviewer feedback:\n${reviewerFeedback}`
          : "",
        languageInstruction(locale),
      ]
        .filter(Boolean)
        .join("\n"),
      context: {
        issue: task.issue as unknown as JsonObject,
        planningDocument: planningDocument as unknown as JsonObject,
        contextPack: task.contextPack as unknown as JsonObject,
        qualityGateResults: (task.qualityGateResults ??
          []) as unknown as JsonObject,
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          type: artifact.type,
          path: artifact.path,
          url: artifact.url,
          metadata: artifact.metadata,
        })) as unknown as JsonObject,
        screenshotArtifacts: screenshotArtifacts as unknown as JsonObject,
        fileSnippets: fileSnippets as JsonObject,
        reviewerFeedback,
        changedFiles,
        diff,
      },
    });
    const review = reviewSchema.parse(result);
    await this.writeArtifact(
      task.id,
      "review",
      "review.json",
      JSON.stringify(review, null, 2),
    );
    await this.event(
      task.id,
      "SUBAGENT_REVIEW_FINISHED",
      `Review approved=${review.approved}`,
    );
    return review;
  }

  async createDraftPr(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
  ): Promise<string> {
    if (!this.config.github.token) {
      throw new Error(
        "GITHUB_TOKEN is required to push branch and create draft PR",
      );
    }

    await this.updateStatus(task.id, "PR_CREATING");
    const agentBranch = task.branchName ?? `agent/issue-${task.issue.number}`;
    const baseSha = await getCurrentCommitSha(sandbox.repoDir);
    const installCommand = await detectInstallCommand(sandbox.repoDir);
    const artifacts = await this.tasks.listArtifacts(task.id);
    const screenshotArtifacts =
      this.collectScreenshotArtifactsForPr(artifacts);
    const verification = createPrLocalVerificationPlan({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      baseBranch: repositoryConfig.default_branch,
      baseSha,
      agentBranch,
      cloneUrl: createGitHubRemoteUrl(
        repositoryConfig.github_owner,
        repositoryConfig.github_repo,
      ),
      installCommand,
      qualityGateResults: task.qualityGateResults ?? [],
      devCommand: repositoryConfig.frontend.dev_command,
      screenshotArtifacts,
      sandbox: {
        mode: sandbox.mode,
        image: this.config.sandbox.image,
        repoDir: sandbox.repoDir,
        artifactDir: sandbox.artifactDir,
      },
    });
    await this.writeArtifact(
      task.id,
      "pr-verification",
      "pr-local-verification.json",
      JSON.stringify(verification, null, 2),
    );
    await this.event(
      task.id,
      "PR_VERIFICATION_CREATED",
      "PR local verification handoff created",
    );

    const commitResults = await commitAll(
      sandbox.repoDir,
      `Agent: ${task.issue.title}`,
    );

    if (commitResults.some((result) => result.exitCode !== 0)) {
      throw new Error("Commit failed");
    }

    const pushResult = await pushBranch(sandbox.repoDir, agentBranch);

    if (pushResult.exitCode !== 0) {
      throw new Error(`Push failed: ${pushResult.stderr || pushResult.stdout}`);
    }

    const github = new GitHubClient({ token: this.config.github.token });
    const locale = detectIssueLocale(task.issue);
    const body = createAgentPrBody({ task, verification, locale });
    assertAgentPrBodyComplete({ task, verification, locale, body });
    const prUrl = await github.createDraftPullRequest({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      title: `${locale === "zh" ? "机器人" : "Agent"}: ${task.issue.title}`,
      body,
      head: agentBranch,
      base: repositoryConfig.default_branch,
    });
    await github.createIssueComment({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      issueNumber: task.issue.number,
      body: createPrReadyIssueComment({ task, verification, prUrl, locale }),
    });
    const memoryProposal = createTaskMemoryProposal({
      task: { ...task, prUrl },
      artifacts: await this.tasks.listArtifacts(task.id),
    });
    await new FileMemoryStore(this.config.memory.filePath).propose(
      memoryProposal.records,
    );
    await this.writeArtifact(
      task.id,
      "memory-proposal",
      "memory-proposal.json",
      JSON.stringify(memoryProposal, null, 2),
    );
    await this.event(
      task.id,
      "MEMORY_PROPOSAL_CREATED",
      `Memory proposal created with ${memoryProposal.records.length} records`,
    );
    await this.event(task.id, "PR_CREATED", `Draft PR created: ${prUrl}`);
    return prUrl;
  }

  private async updateExistingPullRequest(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
    reviewerFeedback: string,
  ): Promise<void> {
    if (!this.config.github.token) {
      throw new Error("GITHUB_TOKEN is required to update the pull request");
    }

    const pullNumber = parseGitHubIssueNumber(task.prUrl ?? "");
    if (!pullNumber) {
      throw new Error(
        `Cannot parse pull request number from ${task.prUrl ?? "missing PR URL"}`,
      );
    }

    const agentBranch = task.branchName ?? `agent/issue-${task.issue.number}`;
    const baseSha = await getCurrentCommitSha(sandbox.repoDir);
    const artifacts = await this.tasks.listArtifacts(task.id);
    const screenshotArtifacts =
      this.collectScreenshotArtifactsForPr(artifacts);
    const installCommand = await detectInstallCommand(sandbox.repoDir);
    const verification = createPrLocalVerificationPlan({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      baseBranch: repositoryConfig.default_branch,
      baseSha,
      agentBranch,
      cloneUrl: createGitHubRemoteUrl(
        repositoryConfig.github_owner,
        repositoryConfig.github_repo,
      ),
      installCommand,
      qualityGateResults: task.qualityGateResults ?? [],
      devCommand: repositoryConfig.frontend.dev_command,
      screenshotArtifacts,
      sandbox: {
        mode: sandbox.mode,
        image: this.config.sandbox.image,
        repoDir: sandbox.repoDir,
        artifactDir: sandbox.artifactDir,
      },
    });

    await this.writeArtifact(
      task.id,
      "pr-verification",
      `pr-local-verification-${Date.now()}.json`,
      JSON.stringify(verification, null, 2),
    );
    await this.updateStatus(task.id, "PR_CREATING");

    const commitResults = await commitAll(
      sandbox.repoDir,
      `Agent feedback: ${task.issue.title}`,
    );

    if (commitResults.some((result) => result.exitCode !== 0)) {
      throw new Error("Feedback commit failed");
    }

    const pushResult = await pushBranch(sandbox.repoDir, agentBranch);

    if (pushResult.exitCode !== 0) {
      throw new Error(
        `Feedback push failed: ${pushResult.stderr || pushResult.stdout}`,
      );
    }

    const github = new GitHubClient({ token: this.config.github.token });
    const locale = detectIssueLocale(task.issue);
    const body = createAgentPrBody({
      task,
      verification,
      locale,
      updateReason: reviewerFeedback,
    });
    assertAgentPrBodyComplete({
      task,
      verification,
      locale,
      updateReason: reviewerFeedback,
      body,
    });
    await github.updatePullRequest({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      pullNumber,
      title: `${locale === "zh" ? "机器人" : "Agent"}: ${task.issue.title}`,
      body,
    });
    await github.createIssueComment({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      issueNumber: pullNumber,
      body: createPrFeedbackUpdateComment({
        task,
        verification,
        updateReason: reviewerFeedback,
        locale,
      }),
    });
    await this.event(
      task.id,
      "PR_UPDATED",
      `Draft PR updated after reviewer feedback: ${task.prUrl}`,
    );
  }

  private collectScreenshotArtifactsForPr(
    artifacts: Artifact[],
  ): Array<Pick<Artifact, "id" | "path" | "url" | "metadata">> {
    return artifacts
      .filter(
        (artifact) =>
          artifact.type === "screenshot" && (artifact.path || artifact.url),
      )
      .map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        url: artifact.url,
        metadata: artifact.metadata,
      }));
  }

  private latestReviewerFeedback(task: Task): string {
    const latest = task.issue.comments.at(-1);
    return latest
      ? `${latest.author} at ${latest.createdAt}:\n${latest.body}`
      : "";
  }

  requiredRepository(task: Task): RepositoryConfig {
    const repository = findRepository(
      this.config,
      task.issue.owner,
      task.issue.repo,
    );

    if (!repository) {
      throw new Error(
        `Repository ${task.issue.owner}/${task.issue.repo} is not configured`,
      );
    }

    return repository;
  }

  async requiredTask(taskId: string): Promise<Task> {
    const task = await this.tasks.getTask(taskId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return task;
  }

  async updateStatus(
    taskId: string,
    status: Task["status"],
    patch: Partial<Task> = {},
  ): Promise<Task> {
    const current = await this.requiredTask(taskId);
    const next = transitionTask(current, status);
    return this.tasks.updateTask(taskId, {
      ...patch,
      status: next.status,
      updatedAt: next.updatedAt,
    });
  }

  async event(
    taskId: string,
    type: Parameters<typeof createTaskEvent>[0]["type"],
    message: string,
    level: Parameters<typeof createTaskEvent>[0]["level"] = "info",
    metadata?: JsonObject,
  ): Promise<void> {
    await this.tasks.appendEvent(
      createTaskEvent({ taskId, type, message, level, metadata }),
    );
  }

  private async writeArtifact(
    taskId: string,
    type: Artifact["type"],
    fileName: string,
    content: string,
  ): Promise<void> {
    await writeTaskArtifact({
      rootDir: this.config.rootDir,
      tasks: this.tasks,
      taskId,
      type,
      fileName,
      content,
    });
  }

  private missing<T>(name: string): T {
    throw new Error(`${name} is required`);
  }
}

export function selectImplementationSnippetPaths(
  task: Pick<Task, "contextPack" | "planningDocument">,
): string[] {
  const plan = task.planningDocument?.implementationPlan;
  const paths = [
    ...(plan?.filesExpectedToChange ?? []),
    ...(plan?.filesToRead ?? []),
    ...(plan?.testsToAddOrUpdate ?? []).map(extractPlanPath),
    ...(task.contextPack?.tests ?? []),
  ]
    .map(normalizePlanPath)
    .filter(Boolean);

  return paths.filter((value, index) => paths.indexOf(value) === index);
}

export function formatQualityGateRepairFeedback(
  results: QualityGateResult[],
  attempt: number,
  maxAttempts: number,
): string {
  const failed = results.filter((result) => !result.passed);
  return [
    `Automated self-check failed after implementation attempt ${attempt}/${maxAttempts}.`,
    "Repair the repository changes so all required quality gates pass. Do not remove meaningful tests or weaken product behavior.",
    "Use existing test helpers shown in fileSnippets; do not invent helper functions when failures mention undefined test utilities.",
    "Failed quality gates:",
    ...failed.map((result) =>
      [
        `- ${result.kind}: ${result.command}`,
        `  exitCode: ${result.exitCode ?? "unknown"}`,
        `  output:\n${truncateForFeedback(result.output)}`,
      ].join("\n"),
    ),
  ].join("\n");
}

export function formatReviewRepairFeedback(
  review: ReviewResult,
  attempt: number,
  maxAttempts: number,
): string {
  const findings = [
    ...review.blockingFindings.map(
      (finding) =>
        `- BLOCKING: ${finding.title}${finding.file ? ` (${finding.file})` : ""}\n${finding.body}`,
    ),
    ...review.scopeViolations.map((violation) => `- SCOPE: ${violation}`),
    ...review.missingTests.map(
      (missingTest) => `- MISSING TEST: ${missingTest}`,
    ),
  ];
  return [
    `Review subagent blocked the change after implementation attempt ${attempt}/${maxAttempts}.`,
    "Repair the repository changes so the review subagent can approve the PR. Keep the same issue scope.",
    `Risk level: ${review.riskLevel}`,
    "Findings:",
    findings.length > 0
      ? findings.join("\n")
      : "- No detailed finding was provided; inspect the diff and make it safer.",
  ].join("\n");
}

export function getSelfCheckHardMaxAttempts(
  configuredMaxAttempts: number,
): number {
  return Math.min(14, Math.max(1, configuredMaxAttempts) + 6);
}

export function shouldExtendQualityGateSelfCheck(
  previousResults: QualityGateResult[] | undefined,
  currentResults: QualityGateResult[],
  attempt: number,
  hardMaxAttempts: number,
): boolean {
  return (
    attempt < hardMaxAttempts &&
    qualityGateFailuresChanged(previousResults, currentResults)
  );
}

export function qualityGateFailuresChanged(
  previousResults: QualityGateResult[] | undefined,
  currentResults: QualityGateResult[],
): boolean {
  if (!previousResults) {
    return false;
  }

  const previousFailed = previousResults.filter((result) => !result.passed);
  const currentFailed = currentResults.filter((result) => !result.passed);
  if (previousFailed.length === 0 || currentFailed.length === 0) {
    return previousFailed.length !== currentFailed.length;
  }

  if (
    previousResults.filter((result) => result.passed).length !==
    currentResults.filter((result) => result.passed).length
  ) {
    return true;
  }

  return (
    qualityGateFailureSignature(previousFailed) !==
    qualityGateFailureSignature(currentFailed)
  );
}

export function shouldExtendReviewSelfCheck(
  previousReview: ReviewResult | undefined,
  currentReview: ReviewResult,
  attempt: number,
  hardMaxAttempts: number,
): boolean {
  return (
    attempt < hardMaxAttempts &&
    reviewFailuresChanged(previousReview, currentReview)
  );
}

export function shouldExtendSelfCheckAfterFailureKindChange(
  previousKind: "quality" | "review" | undefined,
  currentKind: "quality" | "review",
  attempt: number,
  hardMaxAttempts: number,
): boolean {
  return (
    attempt < hardMaxAttempts &&
    previousKind !== undefined &&
    previousKind !== currentKind
  );
}

export function reviewFailuresChanged(
  previousReview: ReviewResult | undefined,
  currentReview: ReviewResult,
): boolean {
  if (!previousReview) {
    return false;
  }

  return (
    reviewFailureSignature(previousReview) !==
    reviewFailureSignature(currentReview)
  );
}

export function qualityGateFailureLooksEnvironmental(
  results: QualityGateResult[],
): boolean {
  const failedResults = results.filter((result) => !result.passed);
  const failedOutput = failedResults
    .map((result) => `${result.command}\n${result.output}`)
    .join("\n")
    .toLowerCase();
  const generalEnvironmentMarkers = [
    "cannot connect to the docker daemon",
    "docker daemon is not running",
    "docker: command not found",
    "no such file or directory: docker",
    "orbstack is not running",
  ];
  const setupEnvironmentMarkers = [
    "ssl is not enabled on the server",
    "failed to open database",
    "failed to connect to",
    "connection refused",
  ];

  return (
    generalEnvironmentMarkers.some((marker) => failedOutput.includes(marker)) ||
    failedResults.some(
      (result) =>
        result.kind === "setup" &&
        setupEnvironmentMarkers.some((marker) =>
          `${result.command}\n${result.output}`.toLowerCase().includes(marker),
        ),
    )
  );
}

function qualityGateFailureSignature(results: QualityGateResult[]): string {
  return results
    .map((result) =>
      [
        result.kind,
        result.command,
        result.exitCode ?? "unknown",
        diagnosticOutputSignature(result.output),
      ].join("|"),
    )
    .sort()
    .join("\n");
}

function diagnosticOutputSignature(output: string): string {
  const diagnosticLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) =>
      /error|fail|failed|cannot|undefined|missing|expected|received|exception|panic|fatal|assert/i.test(
        line,
      ),
    );

  const lines =
    diagnosticLines.length > 0
      ? diagnosticLines
      : output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
  return lines.slice(-30).join("\n").slice(-4000);
}

function reviewFailureSignature(review: ReviewResult): string {
  return [
    ...review.blockingFindings.map(
      (finding) =>
        `blocking:${finding.title}:${finding.file ?? ""}:${finding.body}`,
    ),
    ...review.scopeViolations.map((violation) => `scope:${violation}`),
    ...review.missingTests.map((missingTest) => `missing-test:${missingTest}`),
  ]
    .sort()
    .join("\n");
}

export async function resetImplementationAttempt(
  repoDir: string,
): Promise<void> {
  const reset = await runCommand({
    cwd: repoDir,
    command: "git reset --hard HEAD",
    timeoutMs: 60_000,
  });
  const clean = await runCommand({
    cwd: repoDir,
    command: "git clean -fd",
    timeoutMs: 60_000,
  });
  const failed = [reset, clean].find((result) => result.exitCode !== 0);

  if (failed) {
    throw new Error(
      `Failed to reset implementation attempt: ${failed.command}\n${failed.stderr || failed.stdout}`,
    );
  }
}

export type ImplementationCheckpoint = {
  rootDir: string;
  patchPath: string;
  untrackedDir: string;
  untrackedFiles: string[];
};

export async function createImplementationCheckpoint(
  repoDir: string,
): Promise<ImplementationCheckpoint> {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "agent-implementation-checkpoint-"),
  );
  const patchPath = path.join(rootDir, "tracked.patch");
  const untrackedDir = path.join(rootDir, "untracked");
  await mkdir(untrackedDir, { recursive: true });

  const diff = await runCommand({
    cwd: repoDir,
    command: `git diff --binary HEAD -- > ${shellQuote(patchPath)}`,
    timeoutMs: 60_000,
  });
  if (diff.exitCode !== 0) {
    await rm(rootDir, { recursive: true, force: true });
    throw new Error(
      `Failed to create implementation checkpoint diff: ${diff.stderr || diff.stdout}`,
    );
  }

  const untracked = await runCommand({
    cwd: repoDir,
    command: "git ls-files --others --exclude-standard -z",
    timeoutMs: 60_000,
  });
  if (untracked.exitCode !== 0) {
    await rm(rootDir, { recursive: true, force: true });
    throw new Error(
      `Failed to list untracked files for implementation checkpoint: ${untracked.stderr || untracked.stdout}`,
    );
  }

  const untrackedFiles = untracked.stdout
    .split("\0")
    .map(normalizeRepairPath)
    .filter(Boolean);
  const repoRoot = path.resolve(repoDir);
  for (const relativePath of untrackedFiles) {
    const sourcePath = path.resolve(repoDir, relativePath);
    if (!sourcePath.startsWith(`${repoRoot}${path.sep}`)) {
      continue;
    }

    const destinationPath = path.join(untrackedDir, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }

  return { rootDir, patchPath, untrackedDir, untrackedFiles };
}

export async function restoreImplementationCheckpoint(
  repoDir: string,
  checkpoint: ImplementationCheckpoint,
): Promise<void> {
  await resetImplementationAttempt(repoDir);

  const patchStat = await stat(checkpoint.patchPath).catch(() => undefined);
  if (patchStat && patchStat.size > 0) {
    const apply = await runCommand({
      cwd: repoDir,
      command: `git apply --binary --whitespace=nowarn ${shellQuote(checkpoint.patchPath)}`,
      timeoutMs: 60_000,
    });
    if (apply.exitCode !== 0) {
      throw new Error(
        `Failed to restore implementation checkpoint patch: ${apply.stderr || apply.stdout}`,
      );
    }
  }

  for (const relativePath of checkpoint.untrackedFiles) {
    const normalized = normalizeRepairPath(relativePath);
    if (!normalized) {
      continue;
    }

    const sourcePath = path.join(checkpoint.untrackedDir, normalized);
    const destinationPath = path.resolve(repoDir, normalized);
    const repoRoot = path.resolve(repoDir);
    if (!destinationPath.startsWith(`${repoRoot}${path.sep}`)) {
      continue;
    }

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

export async function cleanupImplementationCheckpoint(
  checkpoint: ImplementationCheckpoint,
): Promise<void> {
  await rm(checkpoint.rootDir, { recursive: true, force: true });
}

function truncateForFeedback(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 3_000
    ? `${trimmed.slice(-3_000)}\n[truncated]`
    : trimmed || "(no output)";
}

export async function extractImplementationFeedbackPaths(
  repoDir: string,
  feedback: string,
): Promise<string[]> {
  if (!feedback.trim()) {
    return [];
  }

  const rawPaths = new Set<string>();
  const pathPattern =
    /(?:^|[\s"'`(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:go|ts|tsx|js|jsx|mjs|cjs|json|sql|css|scss|md|yml|yaml))(?:[:)"'`\s]|$)/gm;
  for (const match of feedback.matchAll(pathPattern)) {
    if (match[1]) {
      rawPaths.add(match[1]);
    }
  }

  if (/\btestutil\./.test(feedback)) {
    rawPaths.add("backend/internal/testutil/postgres.go");
  }

  const resolved: string[] = [];
  for (const rawPath of rawPaths) {
    const normalized = normalizeRepairPath(rawPath);
    if (!normalized) {
      continue;
    }

    for (const candidate of expandFeedbackPathCandidates(normalized)) {
      if (await repositoryFileExists(repoDir, candidate)) {
        resolved.push(candidate);
        break;
      }
    }
  }

  return uniquePaths(resolved);
}

function expandFeedbackPathCandidates(filePath: string): string[] {
  const candidates = [filePath];
  if (!filePath.startsWith("backend/")) {
    candidates.push(`backend/${filePath}`);
  }
  if (!filePath.startsWith("frontend/")) {
    candidates.push(`frontend/${filePath}`);
  }
  return uniquePaths(candidates);
}

async function repositoryFileExists(
  repoDir: string,
  filePath: string,
): Promise<boolean> {
  const normalized = normalizeRepairPath(filePath);
  if (!normalized) {
    return false;
  }

  const absolutePath = path.resolve(repoDir, normalized);
  const repoRoot = path.resolve(repoDir);
  if (!absolutePath.startsWith(`${repoRoot}${path.sep}`)) {
    return false;
  }

  const fileStat = await stat(absolutePath).catch(() => undefined);
  return fileStat?.isFile() ?? false;
}

function normalizeRepairPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.isAbsolute(normalized)
  ) {
    return "";
  }
  return normalized;
}

export function compactContextPackForImplementation(
  contextPack: ContextPack,
): JsonObject {
  const codeGraphContext = compactCodeGraphContext(
    contextPack.codeGraphContext,
  );
  return {
    id: contextPack.id,
    taskSummary: contextPack.taskSummary,
    businessRules: contextPack.businessRules,
    memories: contextPack.memories.map((memory) => ({
      id: memory.id,
      kind: memory.kind,
      title: memory.title,
      content: memory.content,
      score: memory.score,
      confidence: memory.confidence,
    })),
    ...(codeGraphContext ? { codeGraphContext } : {}),
    relevantFiles: contextPack.relevantFiles.map((file) => ({
      path: file.path,
      reason: file.reason,
      readMode: file.readMode,
    })),
    symbols: contextPack.symbols.slice(0, 40),
    tests: contextPack.tests,
    openQuestions: contextPack.openQuestions,
  };
}

function compactCodeGraphContext(
  value: JsonValue | undefined,
): JsonObject | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }

  return {
    ...(typeof value.query === "string" ? { query: value.query } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(Array.isArray(value.entryPoints)
      ? { entryPoints: value.entryPoints.slice(0, 8) as JsonValue[] }
      : {}),
    ...(Array.isArray(value.relatedFiles)
      ? { relatedFiles: value.relatedFiles.slice(0, 12) as JsonValue[] }
      : {}),
    ...(isJsonObject(value.stats) ? { stats: value.stats } : {}),
  };
}

function extractPlanPath(value: string): string {
  return value.split(/\s|\(/)[0] ?? "";
}

function normalizePlanPath(value: string): string {
  return value
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function uniquePaths(paths: string[]): string[] {
  return paths.filter(
    (value, index) => value.length > 0 && paths.indexOf(value) === index,
  );
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskSandbox(task: Pick<Task, "id" | "sandbox">): Sandbox | undefined {
  if (!task.sandbox) {
    return undefined;
  }

  return {
    taskId: task.id,
    repoDir: task.sandbox.repoDir,
    artifactDir: task.sandbox.artifactDir,
    logDir: task.sandbox.logDir,
    mode: task.sandbox.mode,
  };
}

function taskSandboxPatch(sandbox: Sandbox): NonNullable<Task["sandbox"]> {
  return {
    repoDir: sandbox.repoDir,
    artifactDir: sandbox.artifactDir,
    logDir: sandbox.logDir,
    mode: sandbox.mode,
  };
}

async function ensureSandboxDirectories(sandbox: Sandbox): Promise<void> {
  await Promise.all([
    mkdir(sandbox.repoDir, { recursive: true }),
    mkdir(sandbox.artifactDir, { recursive: true }),
    mkdir(sandbox.logDir, { recursive: true }),
  ]);
}

function parseGitHubIssueNumber(url: string): number | undefined {
  const match = /\/(?:pull|issues)\/(\d+)(?:$|[?#])/.exec(url);
  return match?.[1] ? Number(match[1]) : undefined;
}

function repositoryStorageKey(
  repositoryConfig: Pick<RepositoryConfig, "github_owner" | "github_repo">,
): string {
  return `${repositoryConfig.github_owner}--${repositoryConfig.github_repo}`.replace(
    /[^A-Za-z0-9._-]+/g,
    "-",
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
