import os from "node:os";
import path from "node:path";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { runJsonAgent, type AgentDefinition, type AgentRunner } from "@agent/agent-runtime";
import {
  buildContextPack,
  buildNavigationRoute,
  buildRepoNavigationGraph,
  buildCodeGraphTaskContext,
  createContextSnippet,
  indexFiles,
  indexRepositoryWithCodeGraph,
  indexSymbols,
  readContextFileSnippets,
  type CodeGraphContextResult,
  type CodeGraphIndexResult
} from "@agent/codebase-intelligence";
import { findRepository, type AppConfig, type RepositoryConfig } from "@agent/config";
import { createGitHubRemoteUrl, GitHubClient, redactRemoteUrl } from "@agent/github";
import { createTaskMemoryProposal, FileMemoryStore, toContextMemories } from "@agent/memory";
import { allQualityGatesPassed, reviewAllowsPr, shouldRequirePrdReview, transitionTask } from "@agent/orchestrator";
import { createTaskEvent, type TaskRepository } from "@agent/persistence";
import { loadProjectContext, summarizeProjectContext } from "@agent/project-context";
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
  type Sandbox
} from "@agent/sandbox";
import type { Artifact, ContextPack, JsonObject, JsonValue, MinimalChangePlan, PrdDocument, QualityGateResult, ReviewResult, Task } from "@agent/shared";
import { loadPlatformSkills } from "@agent/skills";
import {
  createBuiltInToolRegistry,
  extractDiffPaths,
  ToolGateway,
  type JsonToolAction,
  type PolicyDefinition,
  type ToolCallResult,
  type ToolDefinition
} from "@agent/tool-gateway";
import { createQualityGateCommands, runFrontendScreenshotGate, runQualityGates } from "@agent/verification";
import { createExecutionAgents, createWorkflowAgent, createWorkflowAgentRunner } from "./agent-factory.js";
import { createArtifactId, writeTaskArtifact } from "./artifacts.js";
import {
  assertAgentPrBodyComplete,
  createAgentPrBody,
  createPrdIssueComment,
  createPrFeedbackUpdateComment,
  createPrReadyIssueComment,
  createPrLocalVerificationPlan,
  detectInstallCommand,
  detectIssueLocale,
  languageInstruction
} from "./pr-local-verification.js";
import { createRepositoryPermissionPolicies, repositoryAllowsTool } from "./repository-policies.js";
import { implementationSchema, planSchema, prdSchema, reviewSchema } from "./schemas.js";
import { implementationToToolActions, summarizeToolFailure } from "./tool-actions.js";

const MAX_IMPLEMENTATION_ATTEMPTS = 8;
const MAX_EXISTING_WRITE_FILE_BYTES = 2_000;
const MAX_EXISTING_WRITE_FILE_LINES = 120;

export type IssueWorkflowResult = {
  taskId: string;
  status: Task["status"];
  prUrl?: string;
};

export class IssueWorkflowRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly tasks: TaskRepository
  ) {}

  async run(taskId: string): Promise<IssueWorkflowResult> {
    const task = await this.requiredTask(taskId);

    try {
      const repositoryConfig = this.requiredRepository(task);
      if (this.shouldRunPrFeedbackIteration(task)) {
        return await this.runPrFeedbackIteration(task, repositoryConfig);
      }

      const runner = await createWorkflowAgentRunner(this.config);
      const prdAgent = await createWorkflowAgent(this.config, "prd", "prd");

      const prdWasCreated = !task.prd;
      const prd = task.prd ?? (await this.draftPrd(task, repositoryConfig, runner, prdAgent));
      let updated = task.prd ? task : await this.updateStatus(task.id, "PRD_DRAFTED", { prd });
      const agents = await createExecutionAgents(this.config, prd.complexity.score);

      const requirePrdReview = repositoryConfig.workflow?.require_prd_review ?? true;
      const requiresHumanPrdReview = requirePrdReview && shouldRequirePrdReview(prd.complexity);
      if (updated.status !== "PRD_APPROVED" && requiresHumanPrdReview) {
        if (updated.status !== "PRD_REVIEW_REQUIRED") {
          updated = await this.updateStatus(updated.id, "PRD_REVIEW_REQUIRED");
          await this.event(updated.id, "HUMAN_REVIEW_REQUIRED", "PRD requires human approval before implementation");
        }
        if (prdWasCreated) {
          await this.publishPrdIssueComment(updated, repositoryConfig, prd, true);
        }
        return { taskId: updated.id, status: updated.status };
      }

      if (updated.status !== "PRD_APPROVED") {
        updated = await this.updateStatus(updated.id, "PRD_APPROVED");
        await this.event(updated.id, "PRD_APPROVED", requiresHumanPrdReview ? "PRD approved" : "PRD auto-approved by repository workflow policy");
        if (prdWasCreated) {
          await this.publishPrdIssueComment(updated, repositoryConfig, prd, false);
        }
      }

      const sandbox = await this.prepareSandbox(updated, repositoryConfig);
      updated = await this.updateStatus(updated.id, "ISSUE_BRANCH_CREATED", { sandbox });

      const contextPack = await this.createContextPack(updated, sandbox, repositoryConfig);
      updated = await this.updateStatus(updated.id, "CONTEXT_PACK_CREATED", { contextPack });

      const plan = await this.createMinimalChangePlan(updated, runner, agents.implementation);
      updated = await this.updateStatus(updated.id, "IMPLEMENTING", { minimalChangePlan: plan });

      const selfCheckResult = await this.runImplementationSelfCheckLoop(updated, sandbox, repositoryConfig, runner, agents.implementation, agents.review);
      updated = selfCheckResult.task;

      if (!selfCheckResult.passed) {
        updated = await this.updateStatus(updated.id, "BLOCKED");
        await this.event(updated.id, "TASK_BLOCKED", selfCheckResult.reason, "warn");
        return { taskId: updated.id, status: updated.status };
      }

      const prUrl = await this.createDraftPr(updated, sandbox, repositoryConfig);
      updated = await this.updateStatus(updated.id, "HUMAN_REVIEW", { prUrl });
      return { taskId: updated.id, status: updated.status, prUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.tasks.appendEvent(createTaskEvent({ taskId, type: "TASK_FAILED", level: "error", message }));
      const failed = await this.tasks.updateTask(taskId, { status: "FAILED" });
      return { taskId, status: failed.status };
    }
  }

  private shouldRunPrFeedbackIteration(task: Task): boolean {
    return Boolean(
      task.prUrl &&
        task.branchName &&
        task.issue.comments.length > 0 &&
        (task.status === "HUMAN_REVIEW" || task.status === "BLOCKED")
    );
  }

  private async runPrFeedbackIteration(task: Task, repositoryConfig: RepositoryConfig): Promise<IssueWorkflowResult> {
    const runner = await createWorkflowAgentRunner(this.config);
    const agents = await createExecutionAgents(this.config, task.prd?.complexity.score ?? 30);
    const sandbox = await this.prepareExistingPrSandbox(task, repositoryConfig);
    let updated = await this.updateStatus(task.id, "IMPLEMENTING", { sandbox });
    const feedback = this.latestReviewerFeedback(updated);

    const selfCheckResult = await this.runImplementationSelfCheckLoop(updated, sandbox, repositoryConfig, runner, agents.implementation, agents.review, feedback);
    updated = selfCheckResult.task;

    if (!selfCheckResult.passed) {
      updated = await this.updateStatus(updated.id, "BLOCKED");
      await this.event(updated.id, "TASK_BLOCKED", selfCheckResult.reason, "warn");
      return { taskId: updated.id, status: updated.status, prUrl: updated.prUrl };
    }

    await this.updateExistingPullRequest(updated, sandbox, repositoryConfig, feedback);
    updated = await this.requiredTask(updated.id);
    updated = await this.updateStatus(updated.id, "HUMAN_REVIEW");
    return { taskId: updated.id, status: updated.status, prUrl: updated.prUrl };
  }

  private async draftPrd(task: Task, repositoryConfig: RepositoryConfig, runner: AgentRunner, agent: AgentDefinition): Promise<PrdDocument> {
    await this.updateStatus(task.id, "CONTEXT_COLLECTING");
    await this.updateStatus(task.id, "BRAINSTORMING");
    const platformSkills = await loadPlatformSkills(this.config.rootDir);
    const repositoryContext = await this.loadRepositoryProjectContextForPrd(task, repositoryConfig);
    const locale = detectIssueLocale(task.issue);
    const result = await runJsonAgent({
      runner,
      agent,
      userPrompt: ["Generate the PRD JSON. Return only JSON matching the required schema.", languageInstruction(locale)].join("\n"),
      context: {
        issue: task.issue as unknown as JsonObject,
        platformSkills: platformSkills.map((skill) => ({ id: skill.id, content: skill.content })),
        repositoryContext
      }
    });
    const prd = prdSchema.parse(result);
    await this.writeArtifact(task.id, "prd", "prd.json", JSON.stringify(prd, null, 2));
    await this.event(task.id, "PRD_DRAFTED", `PRD drafted with complexity ${prd.complexity.score}`);
    return prd;
  }

  private async loadRepositoryProjectContextForPrd(task: Task, repositoryConfig: RepositoryConfig): Promise<JsonObject> {
    if (!this.config.github.token) {
      return {
        available: false,
        reason: "GITHUB_TOKEN is not configured; PRD will use issue text and platform skills only."
      };
    }

    try {
      const repoDir = await this.prepareRepositoryContextCheckout(repositoryConfig);
      const projectContext = await loadProjectContext(repoDir, repositoryConfig.project_skill_path);
      await this.event(task.id, "ISSUE_CONTEXT_COLLECTED", "Repository rules and skills loaded for PRD", "info", {
        projectSkillPath: repositoryConfig.project_skill_path,
        skillCount: projectContext.businessSkills.length
      });
      return {
        available: true,
        projectSkillPath: repositoryConfig.project_skill_path,
        summary: summarizeProjectContext(projectContext)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.event(task.id, "ISSUE_CONTEXT_COLLECTED", "Repository rules could not be loaded for PRD; continuing with issue context", "warn", {
        error: message.slice(0, 2000)
      });
      return {
        available: false,
        reason: message
      };
    }
  }

  private async prepareRepositoryContextCheckout(repositoryConfig: RepositoryConfig): Promise<string> {
    const repoDir = path.join(this.config.rootDir, "data", "repository-context", repositoryStorageKey(repositoryConfig), "repo");
    const remoteUrl = createGitHubRemoteUrl(repositoryConfig.github_owner, repositoryConfig.github_repo, this.config.github.token);
    await mkdir(path.dirname(repoDir), { recursive: true });

    if (!(await pathExists(path.join(repoDir, ".git")))) {
      const clone = await runCommand({
        cwd: path.dirname(repoDir),
        command: `git clone --depth 1 --branch ${shellQuote(repositoryConfig.default_branch)} ${shellQuote(remoteUrl)} ${shellQuote(repoDir)}`,
        timeoutMs: 10 * 60_000
      });
      if (clone.exitCode !== 0) {
        throw new Error(`Repository context clone failed: ${redactRemoteUrl(clone.stderr || clone.stdout)}`);
      }
      return repoDir;
    }

    const setRemote = await runCommand({
      cwd: repoDir,
      command: `git remote set-url origin ${shellQuote(remoteUrl)}`,
      timeoutMs: 60_000
    });
    if (setRemote.exitCode !== 0) {
      throw new Error(`Repository context remote update failed: ${redactRemoteUrl(setRemote.stderr || setRemote.stdout)}`);
    }

    const fetch = await runCommand({
      cwd: repoDir,
      command: `git fetch --depth 1 origin ${shellQuote(repositoryConfig.default_branch)}`,
      timeoutMs: 10 * 60_000
    });
    if (fetch.exitCode !== 0) {
      throw new Error(`Repository context fetch failed: ${redactRemoteUrl(fetch.stderr || fetch.stdout)}`);
    }

    const checkout = await runCommand({
      cwd: repoDir,
      command: `git checkout -B repository-context ${shellQuote(`origin/${repositoryConfig.default_branch}`)}`,
      timeoutMs: 60_000
    });
    if (checkout.exitCode !== 0) {
      throw new Error(`Repository context checkout failed: ${redactRemoteUrl(checkout.stderr || checkout.stdout)}`);
    }

    return repoDir;
  }

  private async publishPrdIssueComment(
    task: Task,
    repositoryConfig: RepositoryConfig,
    prd: PrdDocument,
    requiresHumanReview: boolean
  ): Promise<void> {
    if (!this.config.github.token) {
      await this.event(task.id, "PRD_DRAFTED", "PRD issue comment skipped because GITHUB_TOKEN is not configured", "warn");
      return;
    }

    const github = new GitHubClient({ token: this.config.github.token });
    const locale = detectIssueLocale(task.issue);
    const body = createPrdIssueComment({
      task,
      prd,
      requiresHumanReview,
      mention: repositoryConfig.trigger.mention,
      locale
    });
    const url = await github.createIssueComment({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      issueNumber: task.issue.number,
      body
    });
    await this.event(task.id, "PRD_DRAFTED", "PRD commented on GitHub issue", "info", {
      commentUrl: url,
      requiresHumanReview
    });
  }

  private async prepareSandbox(task: Task, repositoryConfig: RepositoryConfig): Promise<Sandbox> {
    await this.updateStatus(task.id, "SANDBOX_PREPARING");
    const manager = new DockerSandboxManager({
      mode: this.config.sandbox.mode,
      rootDir: path.resolve(this.config.rootDir, this.config.sandbox.root_dir),
      dockerImage: this.config.sandbox.image,
      networkAllowlist: this.config.sandbox.network.allow,
      maxRuntimeMinutes: this.config.sandbox.limits.max_runtime_minutes
    });
    const sandbox = await manager.create({ taskId: task.id, issue: task.issue });
    await this.event(task.id, "SANDBOX_CREATED", `Sandbox created at ${sandbox.repoDir}`);
    const remoteUrl = createGitHubRemoteUrl(repositoryConfig.github_owner, repositoryConfig.github_repo, this.config.github.token);
    const results = await cloneRepository({
      sandbox,
      remoteUrl,
      baseBranch: repositoryConfig.default_branch,
      issueBranch: task.branchName ?? `agent/issue-${task.issue.number}`,
      timeoutMs: this.config.sandbox.limits.max_runtime_minutes * 60_000
    });

    for (const result of results) {
      await this.event(task.id, "COMMAND_FINISHED", `${redactRemoteUrl(result.command)} exited ${result.exitCode}`, result.exitCode === 0 ? "info" : "error");
    }

    if (results.some((result) => result.exitCode !== 0)) {
      throw new Error("Repository clone or issue branch creation failed");
    }

    await this.event(task.id, "REPO_CLONED", "Repository cloned and issue branch created");
    return sandbox;
  }

  private async prepareExistingPrSandbox(task: Task, repositoryConfig: RepositoryConfig): Promise<Sandbox> {
    await this.event(task.id, "PR_REVIEW_COMMENT_RECEIVED", "PR review feedback queued for same-branch iteration", "info", {
      prUrl: task.prUrl ?? null,
      branchName: task.branchName ?? null
    });
    const manager = new DockerSandboxManager({
      mode: this.config.sandbox.mode,
      rootDir: path.resolve(this.config.rootDir, this.config.sandbox.root_dir),
      dockerImage: this.config.sandbox.image,
      networkAllowlist: this.config.sandbox.network.allow,
      maxRuntimeMinutes: this.config.sandbox.limits.max_runtime_minutes
    });
    const sandbox = await manager.create({ taskId: `${task.id}-feedback-${Date.now()}`, issue: task.issue });
    const remoteUrl = createGitHubRemoteUrl(repositoryConfig.github_owner, repositoryConfig.github_repo, this.config.github.token);
    const results = await cloneRepositoryBranch({
      sandbox,
      remoteUrl,
      branch: task.branchName ?? `agent/issue-${task.issue.number}`,
      timeoutMs: this.config.sandbox.limits.max_runtime_minutes * 60_000
    });

    for (const result of results) {
      await this.event(task.id, "COMMAND_FINISHED", `${redactRemoteUrl(result.command)} exited ${result.exitCode}`, result.exitCode === 0 ? "info" : "error");
    }

    if (results.some((result) => result.exitCode !== 0)) {
      throw new Error("Existing PR branch clone failed");
    }

    await this.event(task.id, "REPO_CLONED", "Existing PR branch cloned for feedback iteration");
    return sandbox;
  }

  private async createContextPack(task: Task, sandbox: Sandbox, repositoryConfig: RepositoryConfig) {
    await this.updateStatus(task.id, "CODEBASE_INDEXING");
    const codeGraphIndex = await this.createCodeGraphIndex(task, sandbox, repositoryConfig);
    const codeGraphContext =
      codeGraphIndex?.status === "success" ? await this.createCodeGraphContext(task, sandbox, repositoryConfig) : undefined;
    const files = await indexFiles(sandbox.repoDir);
    const symbols = await indexSymbols(sandbox.repoDir, files);
    const projectContext = await loadProjectContext(sandbox.repoDir, repositoryConfig.project_skill_path);
    const knowledgeGraphContext = await this.loadUnderstandAnythingContext(task, repositoryConfig);
    const businessRules = [summarizeProjectContext(projectContext), formatKnowledgeGraphBusinessRule(knowledgeGraphContext)].filter(
      (entry): entry is string => Boolean(entry)
    );
    const memoryStore = new FileMemoryStore(this.config.memory.filePath);
    const memoryResults = await memoryStore.search(task.issue, 8);
    const memories = toContextMemories(memoryResults);
    await this.event(task.id, "CODEBASE_INDEXED", `Indexed ${files.length} files and ${symbols.length} symbols`);
    const navigationRoute = repositoryConfig.codebase_intelligence.navigation_graph.enabled
      ? await this.createNavigationRoute(task, sandbox, repositoryConfig, files, symbols, businessRules)
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
      knowledgeGraphContext,
      navigationRoute
    });
    await this.writeArtifact(task.id, "memory-context", "memory-context.json", JSON.stringify(memories, null, 2));
    await this.event(task.id, "MEMORY_RETRIEVED", `Retrieved ${memories.length} approved memory records`, "info", {
      memoryIds: memories.map((memory) => memory.id)
    });
    await this.writeArtifact(task.id, "context-pack", "context-pack.json", JSON.stringify(contextPack, null, 2));
    await this.event(task.id, "CONTEXT_PACK_CREATED", `ContextPack created with ${contextPack.relevantFiles.length} files`);
    return contextPack;
  }

  private async createCodeGraphIndex(task: Task, sandbox: Sandbox, repositoryConfig: RepositoryConfig): Promise<CodeGraphIndexResult | undefined> {
    const config = repositoryConfig.codebase_intelligence.codegraph;

    if (!config.enabled) {
      await this.event(task.id, "CODEBASE_INDEXED", "CodeGraph indexing is disabled for this repository", "debug");
      return undefined;
    }

    const result = await indexRepositoryWithCodeGraph({
      repoDir: sandbox.repoDir,
      packageName: config.package,
      initArgs: config.init_args,
      timeoutMs: config.timeout_ms,
      cacheDatabaseFile: this.codeGraphCacheDatabaseFile(repositoryConfig)
    });

    await this.writeArtifact(task.id, "repo-graph", "codegraph-index.json", JSON.stringify(result, null, 2));

    if (result.status === "success") {
      const action = result.operation === "initialized" ? "initialized" : "synced";
      await this.event(task.id, "CODEBASE_INDEXED", `CodeGraph index ${action}`, "info", {
        command: result.displayCommand,
        durationMs: result.durationMs,
        indexDir: result.indexDir,
        databaseFile: result.databaseFile,
        cacheDatabaseFile: result.cacheDatabaseFile ?? null,
        restoredFromCache: result.restoredFromCache,
        changeDetection: result.changeDetection
      });
      return result;
    }

    await this.event(task.id, "CODEBASE_INDEXED", "CodeGraph index initialization or sync failed", "error", {
      command: result.displayCommand,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(-4000),
      stdout: result.stdout.slice(-4000)
    });

    if (config.fail_on_error) {
      throw new Error(`CodeGraph initialization or sync failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`);
    }

    return result;
  }

  private async createCodeGraphContext(task: Task, sandbox: Sandbox, repositoryConfig: RepositoryConfig): Promise<CodeGraphContextResult> {
    const config = repositoryConfig.codebase_intelligence.codegraph;
    const result = await buildCodeGraphTaskContext({
      repoDir: sandbox.repoDir,
      task: [task.issue.title, task.issue.body, task.issue.labels.join(" ")].filter(Boolean).join("\n"),
      packageName: config.package,
      timeoutMs: config.timeout_ms,
      maxNodes: 30,
      maxCode: 10
    });

    await this.writeArtifact(task.id, "repo-graph", "codegraph-context.json", JSON.stringify(result, null, 2));

    if (result.status === "success") {
      const relatedFiles = Array.isArray(result.context?.relatedFiles) ? result.context.relatedFiles.length : 0;
      await this.event(task.id, "AGENTIC_SEARCH_FINISHED", `CodeGraph task context created with ${relatedFiles} related files`, "info", {
        command: result.displayCommand,
        durationMs: result.durationMs,
        relatedFiles
      });
      return result;
    }

    await this.event(task.id, "AGENTIC_SEARCH_FINISHED", "CodeGraph task context creation failed", "error", {
      command: result.displayCommand,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(-4000),
      stdout: result.stdout.slice(-4000)
    });

    if (config.fail_on_error) {
      throw new Error(`CodeGraph context failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`);
    }

    return result;
  }

  private async syncCodeGraphAfterImplementation(task: Task, sandbox: Sandbox, repositoryConfig: RepositoryConfig): Promise<void> {
    const config = repositoryConfig.codebase_intelligence.codegraph;

    if (!config.enabled) {
      return;
    }

    const result = await indexRepositoryWithCodeGraph({
      repoDir: sandbox.repoDir,
      packageName: config.package,
      initArgs: config.init_args,
      timeoutMs: config.timeout_ms
    });

    await this.writeArtifact(task.id, "repo-graph", "codegraph-working-tree-sync.json", JSON.stringify(result, null, 2));

    if (result.status === "success") {
      await this.event(task.id, "CODEBASE_INDEXED", "CodeGraph synced after implementation changes", "info", {
        command: result.displayCommand,
        durationMs: result.durationMs,
        databaseFile: result.databaseFile,
        changeDetection: result.changeDetection
      });
      return;
    }

    await this.event(task.id, "CODEBASE_INDEXED", "CodeGraph post-implementation sync failed", "error", {
      command: result.displayCommand,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(-4000),
      stdout: result.stdout.slice(-4000)
    });

    if (config.fail_on_error) {
      throw new Error(`CodeGraph post-implementation sync failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`);
    }
  }

  private codeGraphCacheDatabaseFile(repositoryConfig: RepositoryConfig): string {
    return path.join(this.config.rootDir, "data", "codegraph", repositoryStorageKey(repositoryConfig), "codegraph.db");
  }

  private async loadUnderstandAnythingContext(task: Task, repositoryConfig: RepositoryConfig): Promise<JsonObject | undefined> {
    const graphFile = path.join(
      this.config.rootDir,
      "data",
      "understand-anything",
      repositoryStorageKey(repositoryConfig),
      "repo",
      ".understand-anything",
      "knowledge-graph.json"
    );
    const content = await readFile(graphFile, "utf8").catch(() => "");

    if (!content) {
      await this.event(task.id, "CODEBASE_INDEXED", "Understand-Anything knowledge graph is not available for this repository", "debug", {
        graphFile
      });
      return undefined;
    }

    try {
      const parsed = JSON.parse(content) as unknown;
      const context = summarizeUnderstandAnythingGraph(parsed);
      await this.event(task.id, "CODEBASE_INDEXED", "Understand-Anything knowledge graph loaded for task context", "info", {
        graphFile,
        files: Array.isArray(context.files) ? context.files.length : 0
      });
      return context;
    } catch (error) {
      await this.event(task.id, "CODEBASE_INDEXED", "Understand-Anything knowledge graph could not be parsed", "warn", {
        graphFile,
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  private async createNavigationRoute(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
    files: Awaited<ReturnType<typeof indexFiles>>,
    symbols: Awaited<ReturnType<typeof indexSymbols>>,
    businessRules: string[]
  ) {
    const repoGraph = await buildRepoNavigationGraph({
      repoDir: sandbox.repoDir,
      files,
      symbols,
      businessRules,
      includeGitHistory: repositoryConfig.codebase_intelligence.navigation_graph.include_git_history
    });
    await this.writeArtifact(task.id, "repo-graph", "repo-navigation-graph.json", JSON.stringify(repoGraph, null, 2));
    await this.event(task.id, "REPO_NAVIGATION_GRAPH_CREATED", `Repo navigation graph created with ${repoGraph.nodes.length} nodes and ${repoGraph.edges.length} edges`);
    const navigationRoute = buildNavigationRoute({
      taskId: task.id,
      issue: task.issue,
      graph: repoGraph,
      files,
      symbols
    });
    await this.writeArtifact(task.id, "navigation-route", "navigation-route.json", JSON.stringify(navigationRoute, null, 2));
    await this.event(task.id, "NAVIGATION_ROUTE_CREATED", `Navigation route created with ${navigationRoute.mustRead.length} read targets and ${navigationRoute.tests.length} tests`);
    return navigationRoute;
  }

  private async createMinimalChangePlan(task: Task, runner: AgentRunner, agent: AgentDefinition): Promise<MinimalChangePlan> {
    const locale = detectIssueLocale(task.issue);
    const result = await runJsonAgent({
      runner,
      agent,
      userPrompt: ["Create a minimal change plan. Return only JSON.", languageInstruction(locale)].join("\n"),
      context: {
        prd: task.prd as unknown as JsonObject,
        contextPack: task.contextPack as unknown as JsonObject
      }
    });
    const plan = planSchema.parse(result);
    await this.writeArtifact(task.id, "brainstorm", "minimal-change-plan.json", JSON.stringify(plan, null, 2));
    await this.event(task.id, "PLAN_CREATED", `Minimal change plan created for ${plan.filesExpectedToChange.length} expected files`);
    return plan;
  }

  private async applyImplementation(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
    runner: AgentRunner,
    agent: AgentDefinition,
    reviewerFeedback = ""
  ): Promise<void> {
    const contextPack = task.contextPack ?? this.missing<ContextPack>("ContextPack");
    const feedbackSnippetPaths = await extractImplementationFeedbackPaths(sandbox.repoDir, reviewerFeedback);
    const snippets = await readContextFileSnippets(sandbox.repoDir, contextPack, {
      includePaths: uniquePaths([...feedbackSnippetPaths, ...selectImplementationSnippetPaths(task)]),
      maxCharsPerFile: 16_000,
      maxFiles: 12
    });
    const implementationContextPack = compactContextPackForImplementation(contextPack);
    let previousApplyError = "";
    let previousEditActions: JsonToolAction[] = [];
    const locale = detectIssueLocale(task.issue);

    const implementationToolNames = new Set(this.getImplementationTools(repositoryConfig).map((tool) => tool.name));
    const supportedToolList = [...implementationToolNames].join(", ");

    for (let attempt = 1; attempt <= MAX_IMPLEMENTATION_ATTEMPTS; attempt += 1) {
      const repairContext =
        attempt === 1
          ? undefined
          : await createImplementationRepairContext(sandbox.repoDir, previousEditActions.length > 0 ? previousEditActions : []);
      const firstAttemptPrompt = reviewerFeedback
        ? [
            "Implement the latest PR reviewer feedback on the existing PR branch. Return only JSON.",
            `Latest reviewer feedback:\n${reviewerFeedback}`,
            "Return one or more repository edit actions. Prefer repo.replace_text for existing files and repo.write_file for new files.",
            "repo.apply_patch is unavailable in this phase; for multi-location changes return multiple repo.replace_text actions.",
            "Do not rewrite a large existing file with repo.write_file to work around a narrow failed edit.",
            "Do not call read-only tools during implementation; use the provided fileSnippets and error feedback.",
            "Preferred targeted edit format: {\"summary\":\"...\",\"actions\":[{\"tool\":\"repo.replace_text\",\"input\":{\"path\":\"src/file.ts\",\"search\":\"exact existing text\",\"replace\":\"new text\"}}]}",
            "Preferred file creation format: {\"summary\":\"...\",\"actions\":[{\"tool\":\"repo.write_file\",\"input\":{\"path\":\"src/file.ts\",\"content\":\"complete file contents\"}}]}",
            "Use only the provided tool names and keep the existing PR branch focused on the same issue."
          ].join("\n")
        : [
            "Implement the minimal change plan. Return only JSON.",
            "Return one or more repository edit actions. Prefer repo.replace_text for existing files and repo.write_file for new files.",
            "Do not call read-only tools during implementation; use the provided fileSnippets and plan.",
            "Use repo.replace_text for targeted edits based on exact current snippets.",
            "Use repo.write_file only for new files or tiny full-file replacements where every existing export and behavior is intentionally preserved.",
            "repo.apply_patch is unavailable in this phase; for multi-location changes return multiple repo.replace_text actions.",
            "Use only the provided tool names and do not include unrelated changes."
          ].join("\n");
      const checkpoint = await createImplementationCheckpoint(sandbox.repoDir);
      try {
        await this.event(task.id, "AGENT_RUN_STARTED", `Implementation agent started attempt ${attempt}/${MAX_IMPLEMENTATION_ATTEMPTS}`, "info", {
          agentId: agent.id,
          agentRole: agent.role,
          phase: "implementation",
          attempt,
          maxAttempts: MAX_IMPLEMENTATION_ATTEMPTS
        });
        let result: JsonObject;
        try {
          result = await runJsonAgent({
            runner,
            agent,
            userPrompt:
              attempt === 1
                ? [firstAttemptPrompt, languageInstruction(locale)].join("\n")
                : [
                    "Repair the implementation so it applies cleanly. Return only JSON.",
                    `Previous tool/edit error:\n${previousApplyError}`,
                    "The failed edit attempt was restored to the checkpoint from before that attempt; fileSnippets reflect the current worktree.",
                    "The repair context contains exact current file snippets for the files touched by the failed edit.",
                    "For repo.replace_text, search must exactly match current file text.",
                    "If exact replacement is brittle, use smaller repo.replace_text actions with exact current snippets.",
                    "Use repo.write_file only for new files; do not rewrite large existing files during repair.",
                    `Return corrected repository edit action(s) only using: ${supportedToolList}. Do not call repo.read_file, repo.search, repo.apply_patch, or other tools.`,
                    "Preferred format: {\"summary\":\"...\",\"actions\":[{\"tool\":\"repo.replace_text\",\"input\":{\"path\":\"src/file.ts\",\"search\":\"exact existing text\",\"replace\":\"new text\"}}]}",
                    languageInstruction(locale)
                  ].join("\n"),
            context: {
              issue: task.issue as unknown as JsonObject,
              prd: task.prd as unknown as JsonObject,
              contextPack: implementationContextPack,
              minimalChangePlan: task.minimalChangePlan as unknown as JsonObject,
              reviewerFeedback,
              previousApplyError,
              previousEditFiles: repairContext?.editFiles ?? [],
              previousEditPreview: repairContext?.editPreview ?? "",
              fileSnippets: (repairContext?.fileSnippets ?? snippets) as JsonObject,
              availableTools: this.getImplementationTools(repositoryConfig) as unknown as JsonObject,
              policies: this.config.policies as unknown as JsonObject,
              repositoryPermissions: repositoryConfig.permissions as unknown as JsonObject
            }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.event(task.id, "AGENT_RUN_FINISHED", `Implementation agent failed attempt ${attempt}/${MAX_IMPLEMENTATION_ATTEMPTS}: ${message}`, "error", {
            agentId: agent.id,
            agentRole: agent.role,
            phase: "implementation",
            attempt,
            maxAttempts: MAX_IMPLEMENTATION_ATTEMPTS,
            error: message
          });
          if (attempt < MAX_IMPLEMENTATION_ATTEMPTS && agentRunFailureLooksRecoverable(message)) {
            previousApplyError = agentJsonFailureLooksRecoverable(message)
              ? `Implementation agent returned invalid JSON. Return valid JSON only. Parser error: ${message}`
              : `Implementation agent provider call failed transiently. Retry with the same task context. Error: ${message}`;
            previousEditActions = [];
            continue;
          }
          throw error;
        }
        await this.event(task.id, "AGENT_RUN_FINISHED", `Implementation agent returned JSON for attempt ${attempt}/${MAX_IMPLEMENTATION_ATTEMPTS}`, "info", {
          agentId: agent.id,
          agentRole: agent.role,
          phase: "implementation",
          attempt,
          maxAttempts: MAX_IMPLEMENTATION_ATTEMPTS
        });
        let implementation: ReturnType<typeof implementationSchema.parse>;
        try {
          implementation = implementationSchema.parse(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          previousApplyError = `Implementation JSON failed schema validation. Return JSON matching the implementation schema. Schema error: ${message}`;
          await this.writeArtifact(task.id, "tool-call", `implementation-attempt-${attempt}-invalid.json`, JSON.stringify(result, null, 2));
          await this.event(task.id, "TOOL_CALL_FINISHED", previousApplyError, "error");
          continue;
        }
        const actions = implementationToToolActions(implementation);
        await this.writeArtifact(task.id, "tool-call", `implementation-attempt-${attempt}.json`, JSON.stringify(implementation, null, 2));
        const candidateEditActions = selectImplementationEditActions(actions);
        const editActions = candidateEditActions.filter((action) => implementationToolNames.has(action.toolName));
        if (editActions.length === 0) {
          const attemptedTools = candidateEditActions.map((action) => action.toolName);
          previousApplyError =
            attemptedTools.length > 0
              ? `Implementation attempted unsupported edit tool(s): ${attemptedTools.join(", ")}. Use only: ${supportedToolList}.`
              : "Implementation attempt did not include a repository edit action; read-only actions are not a valid implementation.";
          await this.event(task.id, "TOOL_CALL_FINISHED", previousApplyError, "error");
          previousEditActions = candidateEditActions;
          continue;
        }
        const writeFileGuardError = await validateImplementationWriteFileActions(sandbox.repoDir, editActions);
        if (writeFileGuardError) {
          previousApplyError = writeFileGuardError;
          previousEditActions = editActions;
          await this.event(task.id, "TOOL_CALL_FINISHED", previousApplyError, "error");
          continue;
        }
        const toolResults = await this.executeToolActions(task, sandbox, repositoryConfig, editActions, attempt);
        const failedToolCall = toolResults.find((toolResult) => toolResult.status !== "success");

        if (!failedToolCall) {
          const diff = await getGitDiff(sandbox.repoDir);
          if (!diff) {
            previousApplyError = "Implementation tool actions succeeded but produced no diff";
            await this.event(task.id, "TOOL_CALL_FINISHED", previousApplyError, "error");
            continue;
          }
          await this.writeArtifact(task.id, "diff", "implementation.diff", diff);
          await this.event(task.id, "FILE_CHANGED", implementation.summary);
          return;
        }

        previousApplyError = summarizeToolFailure(failedToolCall);
        previousEditActions = editActions;
        await restoreImplementationCheckpoint(sandbox.repoDir, checkpoint);
        await this.event(task.id, "TOOL_CALL_FINISHED", "Restored failed implementation attempt to the pre-attempt checkpoint before retry", "warn", {
          attempt,
          failedTool: failedToolCall.toolName
        });
      } finally {
        await cleanupImplementationCheckpoint(checkpoint);
      }
    }

    throw new Error(`Implementation edits did not apply after ${MAX_IMPLEMENTATION_ATTEMPTS} attempts: ${previousApplyError}`);
  }

  private async runImplementationSelfCheckLoop(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
    runner: AgentRunner,
    implementationAgent: AgentDefinition,
    reviewAgent: AgentDefinition,
    initialFeedback = ""
  ): Promise<{ task: Task; passed: boolean; reason: string }> {
    let updated = task;
    let implementationFeedback = initialFeedback;
    const configuredMaxAttempts = Math.max(1, (this.config.sandbox.limits.max_quality_gate_retries ?? 0) + 1);
    const hardMaxAttempts = getSelfCheckHardMaxAttempts(configuredMaxAttempts);
    let maxAttempts = configuredMaxAttempts;
    let previousQualityGateResults: QualityGateResult[] | undefined;
    let previousReviewResult: ReviewResult | undefined;
    let previousSelfCheckFailureKind: "quality" | "review" | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (updated.status !== "IMPLEMENTING") {
        updated = await this.updateStatus(updated.id, "IMPLEMENTING");
      }

      await this.applyImplementation(updated, sandbox, repositoryConfig, runner, implementationAgent, implementationFeedback);
      await this.syncCodeGraphAfterImplementation(updated, sandbox, repositoryConfig);

      const qualityGateResults = await this.runQualityGates(updated, sandbox, repositoryConfig);
      updated = await this.updateStatus(updated.id, "QUALITY_GATES_RUNNING", { qualityGateResults });

      if (!allQualityGatesPassed(qualityGateResults)) {
        if (qualityGateFailureLooksEnvironmental(qualityGateResults)) {
          return { task: updated, passed: false, reason: "Quality gates failed because the verification environment is unavailable" };
        }

        const shouldExtend =
          attempt >= maxAttempts &&
          (shouldExtendQualityGateSelfCheck(previousQualityGateResults, qualityGateResults, attempt, hardMaxAttempts) ||
            shouldExtendSelfCheckAfterFailureKindChange(previousSelfCheckFailureKind, "quality", attempt, hardMaxAttempts));
        if (attempt >= maxAttempts && !shouldExtend) {
          return { task: updated, passed: false, reason: "Quality gates failed after automated repair attempts" };
        }

        if (shouldExtend) {
          maxAttempts += 1;
        }
        implementationFeedback = formatQualityGateRepairFeedback(qualityGateResults, attempt, maxAttempts);
        previousQualityGateResults = qualityGateResults;
        previousSelfCheckFailureKind = "quality";
        await this.event(updated.id, "SELF_CHECK_REPAIR_STARTED", `${shouldExtend ? "Quality gates still failed but diagnostics changed; extending automated repair" : "Quality gates failed; starting automated repair"} attempt ${attempt + 1}/${maxAttempts}`, "warn", {
          attempt: attempt + 1,
          maxAttempts,
          configuredMaxAttempts,
          extended: shouldExtend,
          failedGates: qualityGateResults.filter((result) => !result.passed).map((result) => result.kind)
        });
        continue;
      }

      const reviewResult = await this.review(updated, sandbox, runner, reviewAgent, initialFeedback);
      updated = await this.updateStatus(updated.id, "SUBAGENT_REVIEWING", { reviewResult });

      if (reviewAllowsPr(reviewResult)) {
        return { task: updated, passed: true, reason: "Self-check passed" };
      }

      const shouldExtend =
        attempt >= maxAttempts &&
        (shouldExtendReviewSelfCheck(previousReviewResult, reviewResult, attempt, hardMaxAttempts) ||
          shouldExtendSelfCheckAfterFailureKindChange(previousSelfCheckFailureKind, "review", attempt, hardMaxAttempts));
      if (attempt >= maxAttempts && !shouldExtend) {
        return { task: updated, passed: false, reason: "Review subagent blocked PR creation after automated repair attempts" };
      }

      if (shouldExtend) {
        maxAttempts += 1;
      }
      implementationFeedback = formatReviewRepairFeedback(reviewResult, attempt, maxAttempts);
      previousReviewResult = reviewResult;
      previousSelfCheckFailureKind = "review";
      await this.event(updated.id, "SELF_CHECK_REPAIR_STARTED", `${shouldExtend ? "Review findings changed; extending automated repair" : "Review subagent blocked changes; starting automated repair"} attempt ${attempt + 1}/${maxAttempts}`, "warn", {
        attempt: attempt + 1,
        maxAttempts,
        configuredMaxAttempts,
        extended: shouldExtend,
        blockingFindings: reviewResult.blockingFindings.length,
        scopeViolations: reviewResult.scopeViolations.length
      });
    }

    return { task: updated, passed: false, reason: "Self-check did not complete" };
  }

  private getImplementationTools(repositoryConfig: RepositoryConfig): ToolDefinition[] {
    const implementationToolNames = new Set(["repo.replace_text", "repo.write_file"]);
    return this.getAvailableTools(repositoryConfig).filter((tool) => implementationToolNames.has(tool.name));
  }

  private async executeToolActions(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
    actions: JsonToolAction[],
    attempt: number
  ): Promise<ToolCallResult[]> {
    const gateway = this.createToolGateway(repositoryConfig);
    const results: ToolCallResult[] = [];

    for (const action of actions) {
      await this.event(task.id, "TOOL_CALL_STARTED", `Tool ${action.toolName} started`, "info", {
        toolName: action.toolName,
        attempt
      });
      const result = await gateway.execute(
        {
          id: action.id,
          taskId: task.id,
          toolName: action.toolName,
          input: action.input
        },
        { taskId: task.id, repoDir: sandbox.repoDir }
      );
      results.push(result);

      for (const decision of result.policyDecisions) {
        await this.event(task.id, "POLICY_DECISION", `Policy ${decision.policyId} returned ${decision.action}`, decision.action === "block" ? "error" : "warn", {
          toolCallId: result.id,
          policyId: decision.policyId,
          action: decision.action,
          reasons: decision.reasons
        });
      }

      await this.event(task.id, "TOOL_CALL_FINISHED", `Tool ${action.toolName} finished with ${result.status}`, result.status === "success" ? "info" : "error", {
        toolCallId: result.id,
        toolName: result.toolName,
        status: result.status,
        durationMs: result.durationMs,
        error: result.error ?? null
      });

      if (result.status !== "success") {
        break;
      }
    }

    await this.writeArtifact(task.id, "tool-call", `tool-calls-attempt-${attempt}.json`, JSON.stringify(results, null, 2));
    return results;
  }

  private async runQualityGates(task: Task, sandbox: Sandbox, repositoryConfig: RepositoryConfig): Promise<QualityGateResult[]> {
    const gates = createQualityGateCommands({
      setup: repositoryConfig.quality_gates.setup,
      build: repositoryConfig.quality_gates.build,
      lint: repositoryConfig.quality_gates.lint,
      typecheck: repositoryConfig.quality_gates.typecheck,
      unitTest: repositoryConfig.quality_gates.unit_test
    });
    await this.event(task.id, "QUALITY_GATE_STARTED", `Running ${gates.length} quality gates`);
    const results = await runQualityGates(sandbox.repoDir, gates);
    if (
      (task.prd?.taskType === "frontend" || task.prd?.taskType === "fullstack") &&
      repositoryConfig.frontend.dev_command &&
      repositoryConfig.frontend.screenshot_urls.length > 0
    ) {
      const screenshotResult = await runFrontendScreenshotGate({
        cwd: sandbox.repoDir,
        devCommand: repositoryConfig.frontend.dev_command,
        targets: repositoryConfig.frontend.screenshot_urls.map((url) => ({ url })),
        artifactDir: path.join(sandbox.artifactDir, "screenshots"),
        chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH
      });
      results.push(screenshotResult.gate);
      for (const screenshot of screenshotResult.screenshots) {
        await this.tasks.addArtifact({
          id: createArtifactId(),
          taskId: task.id,
          type: "screenshot",
          path: screenshot.path,
          metadata: { url: screenshot.url, viewport: screenshot.viewport },
          createdAt: new Date().toISOString()
        });
      }
    }
    await this.writeArtifact(task.id, "test-report", "quality-gates.json", JSON.stringify(results, null, 2));
    await this.event(task.id, "QUALITY_GATE_FINISHED", `${results.filter((result) => result.passed).length}/${results.length} quality gates passed`);
    return results;
  }

  private async review(task: Task, sandbox: Sandbox, runner: AgentRunner, agent: AgentDefinition, reviewerFeedback = ""): Promise<ReviewResult> {
    const diff = await getGitDiff(sandbox.repoDir);
    const changedFiles = await listChangedFiles(sandbox.repoDir);
    const locale = detectIssueLocale(task.issue);
    const result = await runJsonAgent({
      runner,
      agent,
      userPrompt: [
        "Review the draft changes. Return only JSON with approved, findings, missingTests, scopeViolations, riskLevel, and prDescriptionNotes.",
        reviewerFeedback ? `This is a PR feedback iteration. Confirm the diff addresses this latest reviewer feedback:\n${reviewerFeedback}` : "",
        languageInstruction(locale)
      ]
        .filter(Boolean)
        .join("\n"),
      context: {
        issue: task.issue as unknown as JsonObject,
        prd: task.prd as unknown as JsonObject,
        contextPack: task.contextPack as unknown as JsonObject,
        minimalChangePlan: task.minimalChangePlan as unknown as JsonObject,
        qualityGateResults: (task.qualityGateResults ?? []) as unknown as JsonObject,
        reviewerFeedback,
        changedFiles,
        diff
      }
    });
    const review = reviewSchema.parse(result);
    await this.writeArtifact(task.id, "review", "review.json", JSON.stringify(review, null, 2));
    await this.event(task.id, "SUBAGENT_REVIEW_FINISHED", `Review approved=${review.approved}`);
    return review;
  }

  private async createDraftPr(task: Task, sandbox: Sandbox, repositoryConfig: RepositoryConfig): Promise<string> {
    if (!this.config.github.token) {
      throw new Error("GITHUB_TOKEN is required to push branch and create draft PR");
    }

    await this.updateStatus(task.id, "PR_CREATING");
    const agentBranch = task.branchName ?? `agent/issue-${task.issue.number}`;
    const baseSha = await getCurrentCommitSha(sandbox.repoDir);
    const installCommand = await detectInstallCommand(sandbox.repoDir);
    const artifacts = await this.tasks.listArtifacts(task.id);
    const screenshotArtifacts = await this.publishScreenshotArtifactsToBranch(task, sandbox, repositoryConfig, agentBranch, artifacts);
    const verification = createPrLocalVerificationPlan({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      baseBranch: repositoryConfig.default_branch,
      baseSha,
      agentBranch,
      cloneUrl: createGitHubRemoteUrl(repositoryConfig.github_owner, repositoryConfig.github_repo),
      installCommand,
      qualityGateResults: task.qualityGateResults ?? [],
      devCommand: repositoryConfig.frontend.dev_command,
      screenshotArtifacts,
      sandbox: {
        mode: sandbox.mode,
        image: this.config.sandbox.image,
        repoDir: sandbox.repoDir,
        artifactDir: sandbox.artifactDir
      }
    });
    await this.writeArtifact(task.id, "pr-verification", "pr-local-verification.json", JSON.stringify(verification, null, 2));
    await this.event(task.id, "PR_VERIFICATION_CREATED", "PR local verification handoff created");

    const commitResults = await commitAll(sandbox.repoDir, `Agent: ${task.issue.title}`);

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
      base: repositoryConfig.default_branch
    });
    await github.createIssueComment({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      issueNumber: task.issue.number,
      body: createPrReadyIssueComment({ task, verification, prUrl, locale })
    });
    const memoryProposal = createTaskMemoryProposal({
      task: { ...task, prUrl },
      artifacts: await this.tasks.listArtifacts(task.id)
    });
    await new FileMemoryStore(this.config.memory.filePath).propose(memoryProposal.records);
    await this.writeArtifact(task.id, "memory-proposal", "memory-proposal.json", JSON.stringify(memoryProposal, null, 2));
    await this.event(task.id, "MEMORY_PROPOSAL_CREATED", `Memory proposal created with ${memoryProposal.records.length} records`);
    await this.event(task.id, "PR_CREATED", `Draft PR created: ${prUrl}`);
    return prUrl;
  }

  private async updateExistingPullRequest(task: Task, sandbox: Sandbox, repositoryConfig: RepositoryConfig, reviewerFeedback: string): Promise<void> {
    if (!this.config.github.token) {
      throw new Error("GITHUB_TOKEN is required to update the pull request");
    }

    const pullNumber = parseGitHubIssueNumber(task.prUrl ?? "");
    if (!pullNumber) {
      throw new Error(`Cannot parse pull request number from ${task.prUrl ?? "missing PR URL"}`);
    }

    const agentBranch = task.branchName ?? `agent/issue-${task.issue.number}`;
    const baseSha = await getCurrentCommitSha(sandbox.repoDir);
    const artifacts = await this.tasks.listArtifacts(task.id);
    const screenshotArtifacts = await this.publishScreenshotArtifactsToBranch(task, sandbox, repositoryConfig, agentBranch, artifacts);
    const installCommand = await detectInstallCommand(sandbox.repoDir);
    const verification = createPrLocalVerificationPlan({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      baseBranch: repositoryConfig.default_branch,
      baseSha,
      agentBranch,
      cloneUrl: createGitHubRemoteUrl(repositoryConfig.github_owner, repositoryConfig.github_repo),
      installCommand,
      qualityGateResults: task.qualityGateResults ?? [],
      devCommand: repositoryConfig.frontend.dev_command,
      screenshotArtifacts,
      sandbox: {
        mode: sandbox.mode,
        image: this.config.sandbox.image,
        repoDir: sandbox.repoDir,
        artifactDir: sandbox.artifactDir
      }
    });

    await this.writeArtifact(task.id, "pr-verification", `pr-local-verification-${Date.now()}.json`, JSON.stringify(verification, null, 2));
    await this.updateStatus(task.id, "PR_CREATING");

    const commitResults = await commitAll(sandbox.repoDir, `Agent feedback: ${task.issue.title}`);

    if (commitResults.some((result) => result.exitCode !== 0)) {
      throw new Error("Feedback commit failed");
    }

    const pushResult = await pushBranch(sandbox.repoDir, agentBranch);

    if (pushResult.exitCode !== 0) {
      throw new Error(`Feedback push failed: ${pushResult.stderr || pushResult.stdout}`);
    }

    const github = new GitHubClient({ token: this.config.github.token });
    const locale = detectIssueLocale(task.issue);
    const body = createAgentPrBody({ task, verification, locale, updateReason: reviewerFeedback });
    assertAgentPrBodyComplete({ task, verification, locale, updateReason: reviewerFeedback, body });
    await github.updatePullRequest({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      pullNumber,
      title: `${locale === "zh" ? "机器人" : "Agent"}: ${task.issue.title}`,
      body
    });
    await github.createIssueComment({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      issueNumber: pullNumber,
      body: createPrFeedbackUpdateComment({ task, verification, updateReason: reviewerFeedback, locale })
    });
    await this.event(task.id, "PR_UPDATED", `Draft PR updated after reviewer feedback: ${task.prUrl}`);
  }

  private async publishScreenshotArtifactsToBranch(
    task: Task,
    sandbox: Sandbox,
    repositoryConfig: RepositoryConfig,
    agentBranch: string,
    artifacts: Artifact[]
  ): Promise<Array<Pick<Artifact, "path" | "url" | "metadata">>> {
    const screenshots = artifacts.filter((artifact) => artifact.type === "screenshot" && artifact.path);
    const targetDir = path.join(sandbox.repoDir, ".agent", "screenshots", `issue-${task.issue.number}`);

    if (screenshots.length === 0) {
      return [];
    }

    await mkdir(targetDir, { recursive: true });

    return Promise.all(
      screenshots.map(async (artifact, index) => {
        const source = artifact.path ?? "";
        const extension = path.extname(source) || ".png";
        const viewport = typeof artifact.metadata?.viewport === "string" ? artifact.metadata.viewport : `shot-${index + 1}`;
        const filename = `${String(index + 1).padStart(2, "0")}-${safePathSegment(viewport)}${extension}`;
        const relativePath = path.posix.join(".agent", "screenshots", `issue-${task.issue.number}`, filename);
        const target = path.join(targetDir, filename);
        await copyFile(source, target);

        return {
          path: relativePath,
          url: rawGitHubUrl(repositoryConfig.github_owner, repositoryConfig.github_repo, agentBranch, relativePath),
          metadata: artifact.metadata
        };
      })
    );
  }

  private latestReviewerFeedback(task: Task): string {
    const latest = task.issue.comments.at(-1);
    return latest ? `${latest.author} at ${latest.createdAt}:\n${latest.body}` : "";
  }

  private createToolGateway(repositoryConfig: RepositoryConfig): ToolGateway {
    const registry = createBuiltInToolRegistry();
    return new ToolGateway({
      registry,
      policies: [
        ...this.config.policies.map(
          (policy): PolicyDefinition => ({
            id: policy.id,
            description: policy.description,
            toolNames: policy.tool_names.length > 0 ? policy.tool_names : undefined,
            permissions: policy.permissions.length > 0 ? policy.permissions : undefined,
            matchPaths: policy.match_paths.length > 0 ? policy.match_paths : undefined,
            matchCommands: policy.match_commands.length > 0 ? policy.match_commands : undefined,
            action: policy.action
          })
        ),
        ...createRepositoryPermissionPolicies(repositoryConfig, registry.list())
      ]
    });
  }

  private getAvailableTools(repositoryConfig: RepositoryConfig): ToolDefinition[] {
    return createBuiltInToolRegistry().list().filter((tool) => repositoryAllowsTool(repositoryConfig, tool));
  }

  private requiredRepository(task: Task): RepositoryConfig {
    const repository = findRepository(this.config, task.issue.owner, task.issue.repo);

    if (!repository) {
      throw new Error(`Repository ${task.issue.owner}/${task.issue.repo} is not configured`);
    }

    return repository;
  }

  private async requiredTask(taskId: string): Promise<Task> {
    const task = await this.tasks.getTask(taskId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return task;
  }

  private async updateStatus(taskId: string, status: Task["status"], patch: Partial<Task> = {}): Promise<Task> {
    const current = await this.requiredTask(taskId);
    const next = transitionTask(current, status);
    return this.tasks.updateTask(taskId, { ...patch, status: next.status, updatedAt: next.updatedAt });
  }

  private async event(
    taskId: string,
    type: Parameters<typeof createTaskEvent>[0]["type"],
    message: string,
    level: Parameters<typeof createTaskEvent>[0]["level"] = "info",
    metadata?: JsonObject
  ): Promise<void> {
    await this.tasks.appendEvent(createTaskEvent({ taskId, type, message, level, metadata }));
  }

  private async writeArtifact(taskId: string, type: Artifact["type"], fileName: string, content: string): Promise<void> {
    await writeTaskArtifact({
      rootDir: this.config.rootDir,
      tasks: this.tasks,
      taskId,
      type,
      fileName,
      content
    });
  }

  private missing<T>(name: string): T {
    throw new Error(`${name} is required`);
  }
}

export function selectImplementationSnippetPaths(task: Pick<Task, "contextPack" | "minimalChangePlan">): string[] {
  const plan = task.minimalChangePlan;
  const paths = [
    ...(plan?.filesExpectedToChange ?? []),
    ...(plan?.filesToRead ?? []),
    ...(plan?.testsToAddOrUpdate ?? []).map(extractPlanPath),
    ...(task.contextPack?.tests ?? [])
  ]
    .map(normalizePlanPath)
    .filter(Boolean);

  return paths.filter((value, index) => paths.indexOf(value) === index);
}

export function selectImplementationEditActions(actions: JsonToolAction[]): JsonToolAction[] {
  const implementationToolNames = new Set(["repo.replace_text", "repo.write_file", "repo.apply_patch"]);
  return actions.filter((action) => implementationToolNames.has(action.toolName));
}

export function selectImplementationPatchActions(actions: JsonToolAction[]): JsonToolAction[] {
  return actions.filter((action) => action.toolName === "repo.apply_patch");
}

export function selectImplementationPatchPaths(actions: JsonToolAction[]): string[] {
  const paths = actions.flatMap((action) => {
    const diff = extractPatchDiff(action);
    if (diff) {
      return extractDiffPaths(diff);
    }

    const targetPath = action.input.path;
    return typeof targetPath === "string" ? [targetPath] : [];
  });

  return paths.filter((value, index) => value.length > 0 && paths.indexOf(value) === index);
}

export function formatQualityGateRepairFeedback(results: QualityGateResult[], attempt: number, maxAttempts: number): string {
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
        `  output:\n${truncateForFeedback(result.output)}`
      ].join("\n")
    )
  ].join("\n");
}

export function formatReviewRepairFeedback(review: ReviewResult, attempt: number, maxAttempts: number): string {
  const findings = [
    ...review.blockingFindings.map((finding) => `- BLOCKING: ${finding.title}${finding.file ? ` (${finding.file})` : ""}\n${finding.body}`),
    ...review.scopeViolations.map((violation) => `- SCOPE: ${violation}`),
    ...review.missingTests.map((missingTest) => `- MISSING TEST: ${missingTest}`)
  ];
  return [
    `Review subagent blocked the change after implementation attempt ${attempt}/${maxAttempts}.`,
    "Repair the repository changes so the review subagent can approve the PR. Keep the same issue scope.",
    `Risk level: ${review.riskLevel}`,
    "Findings:",
    findings.length > 0 ? findings.join("\n") : "- No detailed finding was provided; inspect the diff and make it safer."
  ].join("\n");
}

export function getSelfCheckHardMaxAttempts(configuredMaxAttempts: number): number {
  return Math.min(14, Math.max(1, configuredMaxAttempts) + 6);
}

export function shouldExtendQualityGateSelfCheck(
  previousResults: QualityGateResult[] | undefined,
  currentResults: QualityGateResult[],
  attempt: number,
  hardMaxAttempts: number
): boolean {
  return attempt < hardMaxAttempts && qualityGateFailuresChanged(previousResults, currentResults);
}

export function qualityGateFailuresChanged(previousResults: QualityGateResult[] | undefined, currentResults: QualityGateResult[]): boolean {
  if (!previousResults) {
    return false;
  }

  const previousFailed = previousResults.filter((result) => !result.passed);
  const currentFailed = currentResults.filter((result) => !result.passed);
  if (previousFailed.length === 0 || currentFailed.length === 0) {
    return previousFailed.length !== currentFailed.length;
  }

  if (previousResults.filter((result) => result.passed).length !== currentResults.filter((result) => result.passed).length) {
    return true;
  }

  return qualityGateFailureSignature(previousFailed) !== qualityGateFailureSignature(currentFailed);
}

export function shouldExtendReviewSelfCheck(
  previousReview: ReviewResult | undefined,
  currentReview: ReviewResult,
  attempt: number,
  hardMaxAttempts: number
): boolean {
  return attempt < hardMaxAttempts && reviewFailuresChanged(previousReview, currentReview);
}

export function shouldExtendSelfCheckAfterFailureKindChange(
  previousKind: "quality" | "review" | undefined,
  currentKind: "quality" | "review",
  attempt: number,
  hardMaxAttempts: number
): boolean {
  return attempt < hardMaxAttempts && previousKind !== undefined && previousKind !== currentKind;
}

export function reviewFailuresChanged(previousReview: ReviewResult | undefined, currentReview: ReviewResult): boolean {
  if (!previousReview) {
    return false;
  }

  return reviewFailureSignature(previousReview) !== reviewFailureSignature(currentReview);
}

export function qualityGateFailureLooksEnvironmental(results: QualityGateResult[]): boolean {
  const failedResults = results.filter((result) => !result.passed);
  const failedOutput = failedResults.map((result) => `${result.command}\n${result.output}`).join("\n").toLowerCase();
  const generalEnvironmentMarkers = [
    "cannot connect to the docker daemon",
    "docker daemon is not running",
    "docker: command not found",
    "no such file or directory: docker",
    "orbstack is not running"
  ];
  const setupEnvironmentMarkers = [
    "ssl is not enabled on the server",
    "failed to open database",
    "failed to connect to",
    "connection refused"
  ];

  return (
    generalEnvironmentMarkers.some((marker) => failedOutput.includes(marker)) ||
    failedResults.some(
      (result) => result.kind === "setup" && setupEnvironmentMarkers.some((marker) => `${result.command}\n${result.output}`.toLowerCase().includes(marker))
    )
  );
}

function qualityGateFailureSignature(results: QualityGateResult[]): string {
  return results
    .map((result) => [result.kind, result.command, result.exitCode ?? "unknown", diagnosticOutputSignature(result.output)].join("|"))
    .sort()
    .join("\n");
}

function diagnosticOutputSignature(output: string): string {
  const diagnosticLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /error|fail|failed|cannot|undefined|missing|expected|received|exception|panic|fatal|assert/i.test(line));

  const lines = diagnosticLines.length > 0 ? diagnosticLines : output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-30).join("\n").slice(-4000);
}

function reviewFailureSignature(review: ReviewResult): string {
  return [
    ...review.blockingFindings.map((finding) => `blocking:${finding.title}:${finding.file ?? ""}:${finding.body}`),
    ...review.scopeViolations.map((violation) => `scope:${violation}`),
    ...review.missingTests.map((missingTest) => `missing-test:${missingTest}`)
  ]
    .sort()
    .join("\n");
}

export async function validateImplementationWriteFileActions(repoDir: string, actions: JsonToolAction[]): Promise<string | undefined> {
  for (const action of actions) {
    if (action.toolName !== "repo.write_file") {
      continue;
    }

    const inputPath = action.input.path;
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      continue;
    }

    const targetPath = path.resolve(repoDir, inputPath);
    const relativePath = path.relative(repoDir, targetPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return `repo.write_file cannot write outside the repository: ${inputPath}`;
    }

    let targetStat;
    try {
      targetStat = await stat(targetPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    if (!targetStat.isFile()) {
      return `repo.write_file cannot replace non-file path ${inputPath}. Use a repository edit action for a concrete file.`;
    }

    const currentContent = await readFile(targetPath, "utf8");
    const currentLineCount = currentContent.split(/\r?\n/).length;
    if (targetStat.size > MAX_EXISTING_WRITE_FILE_BYTES || currentLineCount > MAX_EXISTING_WRITE_FILE_LINES) {
      return [
        `repo.write_file cannot overwrite existing large file ${inputPath} (${targetStat.size} bytes, ${currentLineCount} lines).`,
        "Use repo.replace_text with exact current snippets for existing files, or repo.write_file only for new files."
      ].join(" ");
    }
  }

  return undefined;
}

export async function resetImplementationAttempt(repoDir: string): Promise<void> {
  const reset = await runCommand({ cwd: repoDir, command: "git reset --hard HEAD", timeoutMs: 60_000 });
  const clean = await runCommand({ cwd: repoDir, command: "git clean -fd", timeoutMs: 60_000 });
  const failed = [reset, clean].find((result) => result.exitCode !== 0);

  if (failed) {
    throw new Error(`Failed to reset implementation attempt: ${failed.command}\n${failed.stderr || failed.stdout}`);
  }
}

export type ImplementationCheckpoint = {
  rootDir: string;
  patchPath: string;
  untrackedDir: string;
  untrackedFiles: string[];
};

export async function createImplementationCheckpoint(repoDir: string): Promise<ImplementationCheckpoint> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "agent-implementation-checkpoint-"));
  const patchPath = path.join(rootDir, "tracked.patch");
  const untrackedDir = path.join(rootDir, "untracked");
  await mkdir(untrackedDir, { recursive: true });

  const diff = await runCommand({
    cwd: repoDir,
    command: `git diff --binary HEAD -- > ${shellQuote(patchPath)}`,
    timeoutMs: 60_000
  });
  if (diff.exitCode !== 0) {
    await rm(rootDir, { recursive: true, force: true });
    throw new Error(`Failed to create implementation checkpoint diff: ${diff.stderr || diff.stdout}`);
  }

  const untracked = await runCommand({
    cwd: repoDir,
    command: "git ls-files --others --exclude-standard -z",
    timeoutMs: 60_000
  });
  if (untracked.exitCode !== 0) {
    await rm(rootDir, { recursive: true, force: true });
    throw new Error(`Failed to list untracked files for implementation checkpoint: ${untracked.stderr || untracked.stdout}`);
  }

  const untrackedFiles = untracked.stdout.split("\0").map(normalizeRepairPath).filter(Boolean);
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

export async function restoreImplementationCheckpoint(repoDir: string, checkpoint: ImplementationCheckpoint): Promise<void> {
  await resetImplementationAttempt(repoDir);

  const patchStat = await stat(checkpoint.patchPath).catch(() => undefined);
  if (patchStat && patchStat.size > 0) {
    const apply = await runCommand({
      cwd: repoDir,
      command: `git apply --binary --whitespace=nowarn ${shellQuote(checkpoint.patchPath)}`,
      timeoutMs: 60_000
    });
    if (apply.exitCode !== 0) {
      throw new Error(`Failed to restore implementation checkpoint patch: ${apply.stderr || apply.stdout}`);
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

export async function cleanupImplementationCheckpoint(checkpoint: ImplementationCheckpoint): Promise<void> {
  await rm(checkpoint.rootDir, { recursive: true, force: true });
}

function truncateForFeedback(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 3_000 ? `${trimmed.slice(-3_000)}\n[truncated]` : trimmed || "(no output)";
}

export async function extractImplementationFeedbackPaths(repoDir: string, feedback: string): Promise<string[]> {
  if (!feedback.trim()) {
    return [];
  }

  const rawPaths = new Set<string>();
  const pathPattern = /(?:^|[\s"'`(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:go|ts|tsx|js|jsx|mjs|cjs|json|sql|css|scss|md|yml|yaml))(?:[:)"'`\s]|$)/gm;
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

async function repositoryFileExists(repoDir: string, filePath: string): Promise<boolean> {
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

async function createImplementationRepairContext(
  repoDir: string,
  actions: JsonToolAction[]
): Promise<{ editFiles: string[]; editPreview: string; fileSnippets: Record<string, string> }> {
  const editFiles = selectImplementationPatchPaths(actions).slice(0, 8);
  return {
    editFiles,
    editPreview: createEditPreview(actions, 12_000),
    fileSnippets: await readFreshFileSnippets(repoDir, editFiles, 24_000, 8)
  };
}

async function readFreshFileSnippets(repoDir: string, paths: string[], maxCharsPerFile: number, maxFiles: number): Promise<Record<string, string>> {
  const snippets: Record<string, string> = {};

  for (const filePath of paths.slice(0, maxFiles)) {
    const normalized = normalizeRepairPath(filePath);
    if (!normalized) {
      continue;
    }

    const absolutePath = path.resolve(repoDir, normalized);
    const repoRoot = path.resolve(repoDir);
    if (!absolutePath.startsWith(`${repoRoot}${path.sep}`)) {
      continue;
    }

    const content = await readFile(absolutePath, "utf8").catch(() => "");
    snippets[normalized] = createContextSnippet(content, maxCharsPerFile);
  }

  return snippets;
}

function createEditPreview(actions: JsonToolAction[], maxChars: number): string {
  const preview = actions
    .map(describeEditAction)
    .filter(Boolean)
    .join("\n\n--- next edit action ---\n\n");
  return preview.length > maxChars ? `${preview.slice(0, maxChars)}\n... (truncated)` : preview;
}

function describeEditAction(action: JsonToolAction): string {
  const diff = extractPatchDiff(action);
  if (diff) {
    return diff;
  }

  return JSON.stringify(action, (_key, value) => (typeof value === "string" && value.length > 4_000 ? `${value.slice(0, 4_000)}\n... (truncated)` : value), 2);
}

function extractPatchDiff(action: JsonToolAction): string {
  const input = action.input;
  const unifiedDiff = input.unifiedDiff;
  if (typeof unifiedDiff === "string") {
    return unifiedDiff;
  }

  const patch = input.patch;
  return typeof patch === "string" ? patch : "";
}

function normalizeRepairPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) {
    return "";
  }
  return normalized;
}

export function compactContextPackForImplementation(contextPack: ContextPack): JsonObject {
  const codeGraphContext = compactCodeGraphContext(contextPack.codeGraphContext);
  const knowledgeGraphContext = compactKnowledgeGraphContext(contextPack.knowledgeGraphContext);
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
      confidence: memory.confidence
    })),
    ...(codeGraphContext ? { codeGraphContext } : {}),
    ...(knowledgeGraphContext ? { knowledgeGraphContext } : {}),
    relevantFiles: contextPack.relevantFiles.map((file) => ({
      path: file.path,
      reason: file.reason,
      readMode: file.readMode
    })),
    symbols: contextPack.symbols.slice(0, 40),
    tests: contextPack.tests,
    openQuestions: contextPack.openQuestions
  };
}

function compactKnowledgeGraphContext(value: JsonValue | undefined): JsonObject | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }

  return {
    provider: "Understand-Anything",
    ...(isJsonObject(value.graph) ? { graph: value.graph } : {}),
    ...(Array.isArray(value.files) ? { files: value.files.slice(0, 30) as JsonValue[] } : {}),
    ...(Array.isArray(value.highlights) ? { highlights: value.highlights.slice(0, 20) as JsonValue[] } : {})
  };
}

function compactCodeGraphContext(value: JsonValue | undefined): JsonObject | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }

  return {
    ...(typeof value.query === "string" ? { query: value.query } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(Array.isArray(value.entryPoints) ? { entryPoints: value.entryPoints.slice(0, 8) as JsonValue[] } : {}),
    ...(Array.isArray(value.relatedFiles) ? { relatedFiles: value.relatedFiles.slice(0, 12) as JsonValue[] } : {}),
    ...(isJsonObject(value.stats) ? { stats: value.stats } : {})
  };
}

function extractPlanPath(value: string): string {
  return value.split(/\s|\(/)[0] ?? "";
}

function normalizePlanPath(value: string): string {
  return value.trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function uniquePaths(paths: string[]): string[] {
  return paths.filter((value, index) => value.length > 0 && paths.indexOf(value) === index);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentJsonFailureLooksRecoverable(message: string): boolean {
  return /json|property name|unexpected token|unexpected end|bad control character|unterminated string/i.test(message);
}

function agentRunFailureLooksRecoverable(message: string): boolean {
  return (
    agentJsonFailureLooksRecoverable(message) ||
    /network request failed|fetch failed|headers timeout|timed out|timeout error|econnreset|etimedout|und_err_headers_timeout/i.test(message)
  );
}

function parseGitHubIssueNumber(url: string): number | undefined {
  const match = /\/(?:pull|issues)\/(\d+)(?:$|[?#])/.exec(url);
  return match?.[1] ? Number(match[1]) : undefined;
}

function rawGitHubUrl(owner: string, repo: string, branch: string, relativePath: string): string {
  return encodeURI(`https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${branch}/${relativePath}`);
}

function repositoryStorageKey(repositoryConfig: Pick<RepositoryConfig, "github_owner" | "github_repo">): string {
  return `${repositoryConfig.github_owner}--${repositoryConfig.github_repo}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safePathSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "screenshot";
}

function summarizeUnderstandAnythingGraph(value: unknown): JsonObject {
  const graph = isUnknownRecord(value) ? value : {};
  const project = isUnknownRecord(graph.project) ? graph.project : {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const highlights = nodes.map(summarizeKnowledgeGraphNode).filter(isJsonObject).slice(0, 80);
  const files = highlights.map((node) => (typeof node.path === "string" ? node.path : "")).filter(uniqueString).slice(0, 80);

  return {
    provider: "Understand-Anything",
    graph: {
      projectName: typeof project.name === "string" ? project.name : undefined,
      analyzedAt: typeof project.analyzedAt === "string" ? project.analyzedAt : undefined,
      nodes: nodes.length,
      edges: edges.length
    },
    files,
    highlights
  } as JsonObject;
}

function summarizeKnowledgeGraphNode(value: unknown): JsonObject | undefined {
  if (!isUnknownRecord(value)) {
    return undefined;
  }

  const pathValue = typeof value.path === "string" ? value.path : inferPathFromNodeId(value.id);
  const label = [value.label, value.name, value.title].find((entry): entry is string => typeof entry === "string");
  const kind = [value.kind, value.type, value.category].find((entry): entry is string => typeof entry === "string");
  const description = [value.description, value.summary].find((entry): entry is string => typeof entry === "string");

  if (!pathValue && !label && !kind) {
    return undefined;
  }

  return {
    ...(pathValue ? { path: normalizeGraphPath(pathValue) } : {}),
    ...(label ? { label } : {}),
    ...(kind ? { kind } : {}),
    ...(description ? { description: description.slice(0, 500) } : {})
  };
}

function inferPathFromNodeId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = /(?:^|:)((?:apps|packages|src|frontend|backend|internal|cmd|lib|components|pages|app)\/[^#?]+)/.exec(value);
  return match?.[1];
}

function normalizeGraphPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function formatKnowledgeGraphBusinessRule(context: JsonObject | undefined): string | undefined {
  if (!context) {
    return undefined;
  }

  return [
    "# Repository Knowledge Graph",
    "Understand-Anything graph is available for this repository.",
    `Files highlighted: ${Array.isArray(context.files) ? context.files.slice(0, 30).join(", ") : "none"}`
  ].join("\n");
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueString(value: string, index: number, array: string[]): boolean {
  return value.length > 0 && array.indexOf(value) === index;
}
