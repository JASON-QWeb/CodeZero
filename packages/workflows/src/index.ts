import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentRunner, OpenAICompatibleProvider, runJsonAgent, type AgentDefinition } from "@agent/agent-runtime";
import { buildContextPack, indexFiles, indexSymbols, readContextFileSnippets } from "@agent/codebase-intelligence";
import { findRepository, type AppConfig, type RepositoryConfig } from "@agent/config";
import { createGitHubRemoteUrl, GitHubClient, redactRemoteUrl } from "@agent/github";
import { allQualityGatesPassed, reviewAllowsPr, shouldRequirePrdReview, transitionTask } from "@agent/orchestrator";
import { createTaskEvent, type TaskRepository } from "@agent/persistence";
import { loadProjectContext, summarizeProjectContext } from "@agent/project-context";
import {
  applyUnifiedDiff,
  cloneRepository,
  commitAll,
  DockerSandboxManager,
  getGitDiff,
  listChangedFiles,
  pushBranch,
  type Sandbox
} from "@agent/sandbox";
import type { Artifact, JsonObject, MinimalChangePlan, PrdDocument, QualityGateResult, ReviewResult, Task } from "@agent/shared";
import { loadPlatformSkills } from "@agent/skills";
import { createQualityGateCommands, runFrontendScreenshotGate, runQualityGates } from "@agent/verification";
import { z } from "zod";

const prdSchema = z.object({
  title: z.string(),
  background: z.string(),
  goals: z.array(z.string()).default([]),
  nonGoals: z.array(z.string()).default([]),
  userStories: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  taskType: z.enum(["frontend", "backend", "fullstack", "docs", "unknown"]).default("unknown"),
  complexity: z.object({
    score: z.number().min(0).max(100),
    requiresHumanReview: z.boolean(),
    reasons: z.array(z.string()).default([])
  })
});

const planSchema = z.object({
  goal: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
  filesToRead: z.array(z.string()).default([]),
  filesExpectedToChange: z.array(z.string()).default([]),
  testsToAddOrUpdate: z.array(z.string()).default([]),
  commandsToRun: z.array(z.string()).default([]),
  explicitNonGoals: z.array(z.string()).default([]),
  riskNotes: z.array(z.string()).default([])
});

const implementationSchema = z.object({
  summary: z.string(),
  unifiedDiff: z.string().min(1)
});

const reviewSchema = z.object({
  approved: z.boolean(),
  blockingFindings: z.array(z.object({ title: z.string(), body: z.string(), blocking: z.boolean(), file: z.string().optional() })).default([]),
  nonBlockingFindings: z.array(z.object({ title: z.string(), body: z.string(), blocking: z.boolean(), file: z.string().optional() })).default([]),
  missingTests: z.array(z.string()).default([]),
  scopeViolations: z.array(z.string()).default([]),
  riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
  prDescriptionNotes: z.array(z.string()).default([])
});

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
      const runner = await this.createAgentRunner();
      const agents = await this.createAgents();

      const prd = task.prd ?? (await this.draftPrd(task, runner, agents.prd));
      let updated = task.prd ? task : await this.updateStatus(task.id, "PRD_DRAFTED", { prd });

      if (updated.status !== "PRD_APPROVED" && shouldRequirePrdReview(prd.complexity)) {
        updated = await this.updateStatus(updated.id, "PRD_REVIEW_REQUIRED");
        await this.event(updated.id, "HUMAN_REVIEW_REQUIRED", "PRD requires human approval before implementation");
        return { taskId: updated.id, status: updated.status };
      }

      const sandbox = await this.prepareSandbox(updated, repositoryConfig);
      updated = await this.updateStatus(updated.id, "ISSUE_BRANCH_CREATED", { sandbox });

      const contextPack = await this.createContextPack(updated, sandbox);
      updated = await this.updateStatus(updated.id, "CONTEXT_PACK_CREATED", { contextPack });

      const plan = await this.createMinimalChangePlan(updated, runner, agents.implementation);
      updated = await this.updateStatus(updated.id, "IMPLEMENTING", { minimalChangePlan: plan });

      await this.applyImplementation(updated, sandbox, runner, agents.implementation);

      const qualityGateResults = await this.runQualityGates(updated, sandbox, repositoryConfig);
      updated = await this.updateStatus(updated.id, "QUALITY_GATES_RUNNING", { qualityGateResults });

      if (!allQualityGatesPassed(qualityGateResults)) {
        updated = await this.updateStatus(updated.id, "BLOCKED");
        await this.event(updated.id, "TASK_BLOCKED", "Quality gates failed", "warn");
        return { taskId: updated.id, status: updated.status };
      }

      const reviewResult = await this.review(updated, sandbox, runner, agents.review);
      updated = await this.updateStatus(updated.id, "SUBAGENT_REVIEWING", { reviewResult });

      if (!reviewAllowsPr(reviewResult)) {
        updated = await this.updateStatus(updated.id, "BLOCKED");
        await this.event(updated.id, "TASK_BLOCKED", "Review subagent blocked PR creation", "warn");
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

  private async draftPrd(task: Task, runner: AgentRunner, agent: AgentDefinition): Promise<PrdDocument> {
    await this.updateStatus(task.id, "CONTEXT_COLLECTING");
    await this.updateStatus(task.id, "BRAINSTORMING");
    const platformSkills = await loadPlatformSkills(this.config.rootDir);
    const result = await runJsonAgent({
      runner,
      agent,
      userPrompt: "Generate the PRD JSON. Return only JSON matching the required schema.",
      context: {
        issue: task.issue as unknown as JsonObject,
        platformSkills: platformSkills.map((skill) => ({ id: skill.id, content: skill.content }))
      }
    });
    const prd = prdSchema.parse(result);
    await this.writeArtifact(task.id, "prd", "prd.json", JSON.stringify(prd, null, 2));
    await this.event(task.id, "PRD_DRAFTED", `PRD drafted with complexity ${prd.complexity.score}`);
    return prd;
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

  private async createContextPack(task: Task, sandbox: Sandbox) {
    await this.updateStatus(task.id, "CODEBASE_INDEXING");
    const files = await indexFiles(sandbox.repoDir);
    const symbols = await indexSymbols(sandbox.repoDir, files);
    const projectContext = await loadProjectContext(sandbox.repoDir);
    await this.event(task.id, "CODEBASE_INDEXED", `Indexed ${files.length} files and ${symbols.length} symbols`);
    await this.updateStatus(task.id, "AGENTIC_SEARCHING");
    const contextPack = await buildContextPack({
      taskId: task.id,
      issue: task.issue,
      repoDir: sandbox.repoDir,
      files,
      symbols,
      businessRules: [summarizeProjectContext(projectContext)]
    });
    await this.writeArtifact(task.id, "context-pack", "context-pack.json", JSON.stringify(contextPack, null, 2));
    await this.event(task.id, "CONTEXT_PACK_CREATED", `ContextPack created with ${contextPack.relevantFiles.length} files`);
    return contextPack;
  }

  private async createMinimalChangePlan(task: Task, runner: AgentRunner, agent: AgentDefinition): Promise<MinimalChangePlan> {
    const result = await runJsonAgent({
      runner,
      agent,
      userPrompt: "Create a minimal change plan. Return only JSON.",
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

  private async applyImplementation(task: Task, sandbox: Sandbox, runner: AgentRunner, agent: AgentDefinition): Promise<void> {
    const snippets = await readContextFileSnippets(sandbox.repoDir, task.contextPack ?? this.missing("ContextPack"));
    let previousApplyError = "";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await runJsonAgent({
        runner,
        agent,
        userPrompt:
          attempt === 1
            ? "Implement the minimal change plan. Return JSON with summary and unifiedDiff. Do not include unrelated changes."
            : `Repair the unified diff so it applies cleanly. Previous git apply error:\n${previousApplyError}\nReturn only JSON with summary and unifiedDiff.`,
        context: {
          prd: task.prd as unknown as JsonObject,
          contextPack: task.contextPack as unknown as JsonObject,
          minimalChangePlan: task.minimalChangePlan as unknown as JsonObject,
          fileSnippets: snippets as JsonObject
        }
      });
      const implementation = implementationSchema.parse(result);
      const applyResult = await applyUnifiedDiff(sandbox.repoDir, implementation.unifiedDiff);
      await this.event(task.id, "COMMAND_FINISHED", `git apply attempt ${attempt} exited ${applyResult.exitCode}`, applyResult.exitCode === 0 ? "info" : "error");

      if (applyResult.exitCode === 0) {
        const diff = await getGitDiff(sandbox.repoDir);
        if (!diff) {
          throw new Error("Implementation produced no diff");
        }
        await this.writeArtifact(task.id, "diff", "implementation.diff", diff);
        await this.event(task.id, "FILE_CHANGED", implementation.summary);
        return;
      }

      previousApplyError = applyResult.stderr || applyResult.stdout;
    }

    throw new Error(`Implementation diff did not apply after 3 attempts: ${previousApplyError}`);
  }

  private async runQualityGates(task: Task, sandbox: Sandbox, repositoryConfig: RepositoryConfig): Promise<QualityGateResult[]> {
    const gates = createQualityGateCommands({
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
          id: `artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

  private async review(task: Task, sandbox: Sandbox, runner: AgentRunner, agent: AgentDefinition): Promise<ReviewResult> {
    const diff = await getGitDiff(sandbox.repoDir);
    const changedFiles = await listChangedFiles(sandbox.repoDir);
    const result = await runJsonAgent({
      runner,
      agent,
      userPrompt: "Review the draft changes. Return only JSON with approved, findings, missingTests, scopeViolations, riskLevel, and prDescriptionNotes.",
      context: {
        prd: task.prd as unknown as JsonObject,
        contextPack: task.contextPack as unknown as JsonObject,
        minimalChangePlan: task.minimalChangePlan as unknown as JsonObject,
        qualityGateResults: (task.qualityGateResults ?? []) as unknown as JsonObject,
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
    const commitResults = await commitAll(sandbox.repoDir, `Agent: ${task.issue.title}`);

    if (commitResults.some((result) => result.exitCode !== 0)) {
      throw new Error("Commit failed");
    }

    const pushResult = await pushBranch(sandbox.repoDir, task.branchName ?? `agent/issue-${task.issue.number}`);

    if (pushResult.exitCode !== 0) {
      throw new Error(`Push failed: ${pushResult.stderr || pushResult.stdout}`);
    }

    const github = new GitHubClient({ token: this.config.github.token });
    const prUrl = await github.createDraftPullRequest({
      owner: repositoryConfig.github_owner,
      repo: repositoryConfig.github_repo,
      title: `Agent: ${task.issue.title}`,
      body: this.createPrBody(task),
      head: task.branchName ?? `agent/issue-${task.issue.number}`,
      base: repositoryConfig.default_branch
    });
    await this.event(task.id, "PR_CREATED", `Draft PR created: ${prUrl}`);
    return prUrl;
  }

  private async createAgentRunner(): Promise<AgentRunner> {
    const providers = new Map(
      Object.entries(this.config.agents.providers).map(([id, provider]) => {
        const apiKey = process.env[provider.api_key_env] ?? "";

        if (!apiKey) {
          throw new Error(`${provider.api_key_env} is required for provider ${id}`);
        }

        if (provider.model.includes("${") || provider.base_url.includes("${")) {
          throw new Error(`Provider ${id} has unresolved environment placeholders`);
        }

        return [
          id,
          new OpenAICompatibleProvider({
            id,
            baseUrl: provider.base_url,
            apiKey,
            model: provider.model,
            temperature: provider.temperature,
            maxTokens: provider.max_tokens,
            supportsTools: provider.supports_tools,
            supportsStructuredOutput: provider.supports_structured_output,
            timeoutMs: provider.timeout_ms
          })
        ] as const;
      })
    );
    return new AgentRunner(providers);
  }

  private async createAgents(): Promise<{ prd: AgentDefinition; implementation: AgentDefinition; review: AgentDefinition }> {
    return {
      prd: await this.createAgent("prd", "prd"),
      implementation: await this.createAgent("implementation", "main-implementation"),
      review: await this.createAgent("review", "review")
    };
  }

  private async createAgent(configKey: string, role: AgentDefinition["role"]): Promise<AgentDefinition> {
    const config = this.config.agents.agents[configKey];

    if (!config) {
      throw new Error(`Missing agent config: ${configKey}`);
    }

    const promptPath = path.resolve(this.config.rootDir, config.system_prompt);
    const systemPrompt = await import("node:fs/promises").then((fs) => fs.readFile(promptPath, "utf8"));

    return {
      id: configKey,
      role,
      providerId: config.provider,
      systemPrompt,
      skillRefs: config.skills,
      tools: [],
      guardrails: []
    };
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

  private async event(taskId: string, type: Parameters<typeof createTaskEvent>[0]["type"], message: string, level: Parameters<typeof createTaskEvent>[0]["level"] = "info"): Promise<void> {
    await this.tasks.appendEvent(createTaskEvent({ taskId, type, message, level }));
  }

  private async writeArtifact(taskId: string, type: Artifact["type"], fileName: string, content: string): Promise<void> {
    const artifactDir = path.resolve(this.config.rootDir, "artifacts", taskId);
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, fileName);
    await writeFile(artifactPath, content);
    await this.tasks.addArtifact({
      id: `artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      taskId,
      type,
      path: artifactPath,
      createdAt: new Date().toISOString()
    });
  }

  private createPrBody(task: Task): string {
    return [
      `Closes ${task.issue.url}`,
      "",
      "## Summary",
      task.prd?.goals.map((goal) => `- ${goal}`).join("\n") || "- See PRD artifact.",
      "",
      "## Quality Gates",
      ...(task.qualityGateResults ?? []).map((result) => `- ${result.kind}: ${result.passed ? "passed" : "failed"} (${result.command})`),
      "",
      "## Review Subagent",
      `- approved: ${task.reviewResult?.approved ?? false}`,
      `- risk: ${task.reviewResult?.riskLevel ?? "unknown"}`,
      ...(task.reviewResult?.prDescriptionNotes ?? []).map((note) => `- ${note}`)
    ].join("\n");
  }

  private missing<T>(name: string): T {
    throw new Error(`${name} is required`);
  }
}
