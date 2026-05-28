import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig, RepositoryConfig } from "@agent/config";
import { createTask } from "@agent/orchestrator";
import type { TaskRepository } from "@agent/persistence";
import { runCommand } from "@agent/sandbox";
import type { Artifact, ContextPack, IssueContext, PrdDocument, QualityGateResult, Task, TaskEvent } from "@agent/shared";
import {
  compactContextPackForImplementation,
  buildCodingExecutorEnv,
  buildCodingExecutorPrompt,
  cleanupImplementationCheckpoint,
  createArtifactId,
  createImplementationCheckpoint,
  createPrdIssueComment,
  createWorkflowAgent,
  createWorkflowAgentRunner,
  extractImplementationFeedbackPaths,
  formatQualityGateRepairFeedback,
  formatReviewRepairFeedback,
  getSelfCheckHardMaxAttempts,
  implementationSchema,
  implementationToToolActions,
  IssueWorkflowRunner,
  normalizeImplementationExecutorConfig,
  qualityGateFailuresChanged,
  qualityGateFailureLooksEnvironmental,
  resetImplementationAttempt,
  runCodingCliExecutor,
  restoreImplementationCheckpoint,
  selectImplementationEditActions,
  selectImplementationPatchActions,
  selectImplementationPatchPaths,
  selectImplementationSnippetPaths,
  selectProviderForComplexity,
  shouldExtendQualityGateSelfCheck,
  shouldExtendSelfCheckAfterFailureKindChange,
  summarizeToolFailure,
  validateImplementationWriteFileActions,
  writeTaskArtifact
} from "@agent/workflows";

describe("workflow modules", () => {
  it("selects providers by task complexity with a conservative fallback", () => {
    const providerByComplexity = { low: "small", medium: "balanced", high: "large" };

    expect(selectProviderForComplexity("default", providerByComplexity, undefined)).toBe("default");
    expect(selectProviderForComplexity("default", providerByComplexity, 35)).toBe("small");
    expect(selectProviderForComplexity("default", providerByComplexity, 70)).toBe("balanced");
    expect(selectProviderForComplexity("default", providerByComplexity, 71)).toBe("large");
    expect(selectProviderForComplexity("default", {}, 99)).toBe("default");
  });

  it("normalizes implementation responses into tool actions", () => {
    expect(
      implementationSchema.parse({
        summary: "tool calls alias",
        toolCalls: [{ tool: "replace_text", input: { file_path: "src/app.ts", oldText: "old", new_text: "new" } }]
      }).actions
    ).toHaveLength(1);

    expect(implementationSchema.parse({ summary: "diff alias", diff: "diff --git a/a b/a\n" }).unifiedDiff).toBe("diff --git a/a b/a\n");

    expect(implementationToToolActions({ summary: "compat", unifiedDiff: "diff --git a/a b/a\n" })).toEqual([
      {
        toolName: "repo.apply_patch",
        input: { unifiedDiff: "diff --git a/a b/a\n" }
      }
    ]);

    expect(
      implementationToToolActions({
        summary: "tool alias",
        actions: [{ id: "search", tool: "repo.search", input: { query: "refund" } }]
      })
    ).toEqual([{ id: "search", toolName: "repo.search", input: { query: "refund" } }]);

    expect(
      implementationToToolActions({
        summary: "edit aliases",
        actions: [
          {
            tool: "replace_text",
            input: {
              file_path: "src/app.ts",
              oldText: "old",
              new_text: "new"
            }
          },
          {
            tool: "write_file",
            input: {
              filePath: "src/new.ts",
              contents: "export {};\n"
            }
          },
          {
            tool: "apply_patch",
            input: {
              unified_diff: "diff --git a/a b/a\n"
            }
          }
        ]
      })
    ).toEqual([
      {
        toolName: "repo.replace_text",
        input: {
          file_path: "src/app.ts",
          oldText: "old",
          new_text: "new",
          path: "src/app.ts",
          search: "old",
          replace: "new"
        }
      },
      {
        toolName: "repo.write_file",
        input: {
          filePath: "src/new.ts",
          contents: "export {};\n",
          path: "src/new.ts",
          content: "export {};\n"
        }
      },
      {
        toolName: "repo.apply_patch",
        input: {
          unified_diff: "diff --git a/a b/a\n",
          unifiedDiff: "diff --git a/a b/a\n"
        }
      }
    ]);
  });

  it("prepares a hidden CLI coding executor with provider env and prompt context", async () => {
    const previousApiKey = process.env.TEST_API_KEY;
    process.env.TEST_API_KEY = "secret";
    const executor = normalizeImplementationExecutorConfig(undefined);
    const agent = {
      id: "implementation",
      role: "main-implementation" as const,
      providerId: "default",
      systemPrompt: "Implement.",
      skillRefs: [],
      tools: [],
      guardrails: []
    };

    try {
      const env = buildCodingExecutorEnv({ config: createAppConfig("/tmp/project"), agent, executor });
      const prompt = buildCodingExecutorPrompt({
        task: { ...createTask(issue), prd: highComplexityPrd, minimalChangePlan: minimalPlan(), contextPack: compactableContextPack() },
        prd: highComplexityPrd,
        minimalChangePlan: minimalPlan(),
        implementationContext: compactContextPackForImplementation(compactableContextPack()),
        fileSnippets: { "src/change.ts": "old\n" }
      });

      expect(executor.mode).toBe("cli");
      expect(executor.command).toContain("opencode-ai");
      expect(env.OPENAI_API_KEY).toBe("secret");
      expect(env.OPENAI_BASE_URL).toBe("https://api.example.test");
      expect(env.CODEZERO_OPENCODE_MODEL).toBe("openai/model-default");
      expect(prompt).toContain("CodeZero Implementation Request");
      expect(prompt).not.toContain("OpenCode");
      expect(prompt).toContain("Leave the working tree with the required code changes");
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.TEST_API_KEY;
      } else {
        process.env.TEST_API_KEY = previousApiKey;
      }
    }
  });

  it("runs a CLI coding executor in the sandbox and captures the resulting diff", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-coding-executor-"));
    const artifactDir = path.join(repoDir, "artifacts");
    await runCommand({ cwd: repoDir, command: "git init" });
    await runCommand({ cwd: repoDir, command: "git config user.email test@example.com && git config user.name Test" });
    await writeFile(path.join(repoDir, "app.txt"), "old\n");
    await runCommand({ cwd: repoDir, command: "git add app.txt && git commit -m init" });
    const previousApiKey = process.env.TEST_API_KEY;
    process.env.TEST_API_KEY = "secret";
    const executor = normalizeImplementationExecutorConfig({
      mode: "cli",
      name: "test-cli",
      command:
        "node -e \"const fs=require('fs'); if(!process.env.OPENAI_API_KEY || !process.env.CODEZERO_PROMPT_FILE) process.exit(7); fs.writeFileSync('app.txt', 'new\\\\n')\"",
      timeout_ms: 30_000,
      fallback_to_legacy_json_actions: false,
      env: {}
    });
    const agent = {
      id: "implementation",
      role: "main-implementation" as const,
      providerId: "default",
      systemPrompt: "Implement.",
      skillRefs: [],
      tools: [],
      guardrails: []
    };

    try {
      const result = await runCodingCliExecutor({
        config: createAppConfig(repoDir),
        executor,
        agent,
        task: { ...createTask(issue), prd: highComplexityPrd, minimalChangePlan: minimalPlan(), contextPack: compactableContextPack() },
        repoDir,
        artifactDir,
        prompt: "Change app.txt",
        attempt: 1
      });

      expect(result.commandResult.exitCode).toBe(0);
      expect(result.diff).toContain("-old");
      expect(result.diff).toContain("+new");
      await expect(readFile(result.promptPath, "utf8")).resolves.toBe("Change app.txt");
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.TEST_API_KEY;
      } else {
        process.env.TEST_API_KEY = previousApiKey;
      }
    }
  });

  it("summarizes failed tool calls with useful diagnostics", () => {
    const summary = summarizeToolFailure({
      id: "tool-1",
      toolName: "shell.run",
      status: "failed",
      error: "Command failed",
      durationMs: 10,
      policyDecisions: [],
      output: { stdout: "stdout text", stderr: "stderr text" }
    });

    expect(summary).toContain("shell.run");
    expect(summary).toContain("Command failed");
    expect(summary).toContain("stderr text");
    expect(summary).toContain("stdout text");
  });

  it("keeps only patch actions for implementation execution", () => {
    expect(
      selectImplementationPatchActions([
        { toolName: "repo.read_file", input: { path: "src/app.ts" } },
        { toolName: "repo.apply_patch", input: { unifiedDiff: "diff --git a/src/app.ts b/src/app.ts\n" } }
      ])
    ).toEqual([{ toolName: "repo.apply_patch", input: { unifiedDiff: "diff --git a/src/app.ts b/src/app.ts\n" } }]);
  });

  it("keeps only repository edit actions for implementation execution", () => {
    expect(
      selectImplementationEditActions([
        { toolName: "repo.read_file", input: { path: "src/app.ts" } },
        { toolName: "repo.replace_text", input: { path: "src/app.ts", search: "old", replace: "new" } },
        { toolName: "repo.write_file", input: { path: "src/new.ts", content: "export {};\n" } },
        { toolName: "repo.apply_patch", input: { unifiedDiff: "diff --git a/src/app.ts b/src/app.ts\n" } }
      ])
    ).toEqual([
      { toolName: "repo.replace_text", input: { path: "src/app.ts", search: "old", replace: "new" } },
      { toolName: "repo.write_file", input: { path: "src/new.ts", content: "export {};\n" } },
      { toolName: "repo.apply_patch", input: { unifiedDiff: "diff --git a/src/app.ts b/src/app.ts\n" } }
    ]);
  });

  it("extracts failed patch paths for focused implementation repair", () => {
    expect(
      selectImplementationPatchPaths([
        {
          toolName: "repo.apply_patch",
          input: {
            unifiedDiff: [
              "diff --git a/src/app.ts b/src/app.ts",
              "--- a/src/app.ts",
              "+++ b/src/app.ts",
              "@@ -1 +1 @@",
              "-old",
              "+new",
              ""
            ].join("\n")
          }
        },
        {
          toolName: "repo.apply_patch",
          input: {
            patch: [
              "diff --git a/tests/app.test.ts b/tests/app.test.ts",
              "--- a/tests/app.test.ts",
              "+++ b/tests/app.test.ts",
              "@@ -1 +1 @@",
              "-old",
              "+new",
              ""
            ].join("\n")
          }
        }
      ])
    ).toEqual(["src/app.ts", "tests/app.test.ts"]);
  });

  it("extracts direct edit paths for focused implementation repair", () => {
    expect(
      selectImplementationPatchPaths([
        { toolName: "repo.replace_text", input: { path: "src/app.ts", search: "old", replace: "new" } },
        { toolName: "repo.write_file", input: { path: "tests/app.test.ts", content: "test('ok', () => {});\n" } }
      ])
    ).toEqual(["src/app.ts", "tests/app.test.ts"]);
  });

  it("blocks repo.write_file from overwriting existing large files", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-write-file-guard-"));
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src/app.ts"), "export const value = 1;\n".repeat(121));

    await expect(
      validateImplementationWriteFileActions(repoDir, [{ toolName: "repo.write_file", input: { path: "src/app.ts", content: "replacement\n" } }])
    ).resolves.toContain("repo.write_file cannot overwrite existing large file src/app.ts");

    await expect(
      validateImplementationWriteFileActions(repoDir, [{ toolName: "repo.write_file", input: { path: "src/new.ts", content: "export {};\n" } }])
    ).resolves.toBeUndefined();
  });

  it("rolls back partial implementation edits before a retry", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-workflow-reset-"));
    await runCommand({ cwd: repoDir, command: "git init" });
    await runCommand({ cwd: repoDir, command: "git config user.email test@example.com && git config user.name Test" });
    await writeFile(path.join(repoDir, "app.ts"), "old\n");
    await runCommand({ cwd: repoDir, command: "git add app.ts && git commit -m init" });

    await writeFile(path.join(repoDir, "app.ts"), "partial\n");
    await writeFile(path.join(repoDir, "new-file.ts"), "new\n");

    await resetImplementationAttempt(repoDir);

    const status = await runCommand({ cwd: repoDir, command: "git status --short" });
    await expect(readFile(path.join(repoDir, "app.ts"), "utf8")).resolves.toBe("old\n");
    expect(status.stdout.trim()).toBe("");
  });

  it("restores a failed retry to the checkpoint without losing previous edits", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-workflow-checkpoint-"));
    await runCommand({ cwd: repoDir, command: "git init" });
    await runCommand({ cwd: repoDir, command: "git config user.email test@example.com && git config user.name Test" });
    await writeFile(path.join(repoDir, "app.ts"), "old\n");
    await runCommand({ cwd: repoDir, command: "git add app.ts && git commit -m init" });

    await writeFile(path.join(repoDir, "app.ts"), "implemented\n");
    await writeFile(path.join(repoDir, "new-file.ts"), "created\n");

    const checkpoint = await createImplementationCheckpoint(repoDir);
    try {
      await writeFile(path.join(repoDir, "app.ts"), "partial broken\n");
      await writeFile(path.join(repoDir, "new-file.ts"), "broken\n");
      await writeFile(path.join(repoDir, "scratch.ts"), "bad\n");

      await restoreImplementationCheckpoint(repoDir, checkpoint);
    } finally {
      await cleanupImplementationCheckpoint(checkpoint);
    }

    const status = await runCommand({ cwd: repoDir, command: "git status --short" });
    await expect(readFile(path.join(repoDir, "app.ts"), "utf8")).resolves.toBe("implemented\n");
    await expect(readFile(path.join(repoDir, "new-file.ts"), "utf8")).resolves.toBe("created\n");
    await expect(readFile(path.join(repoDir, "scratch.ts"), "utf8")).rejects.toThrow();
    expect(status.stdout).toContain(" M app.ts");
    expect(status.stdout).toContain("?? new-file.ts");
    expect(status.stdout).not.toContain("scratch.ts");
  });

  it("formats self-check repair feedback for the implementation agent", () => {
    const feedback = formatQualityGateRepairFeedback(
      [
        {
          kind: "unit_test",
          command: "pnpm test",
          passed: false,
          exitCode: 1,
          durationMs: 10,
          output: "Expected async sync status to be success"
        }
      ],
      1,
      4
    );

    expect(feedback).toContain("Automated self-check failed");
    expect(feedback).toContain("unit_test");
    expect(feedback).toContain("Expected async sync status");
    expect(feedback).toContain("do not invent helper functions");
  });

  it("formats review repair feedback for the implementation agent", () => {
    const feedback = formatReviewRepairFeedback(
      {
        approved: false,
        blockingFindings: [{ title: "Missing retry", body: "The failed state has no retry path.", blocking: true, file: "src/sync.ts" }],
        nonBlockingFindings: [],
        missingTests: ["Add failed sync coverage"],
        scopeViolations: [],
        riskLevel: "medium",
        prDescriptionNotes: []
      },
      2,
      4
    );

    expect(feedback).toContain("Review subagent blocked");
    expect(feedback).toContain("Missing retry");
    expect(feedback).toContain("Add failed sync coverage");
  });

  it("distinguishes missing Docker from code-level quality gate failures", () => {
    expect(
      qualityGateFailureLooksEnvironmental([
        {
          kind: "setup",
          command: "docker compose up -d",
          passed: false,
          exitCode: 1,
          durationMs: 10,
          output: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"
        }
      ])
    ).toBe(true);

    expect(
      qualityGateFailureLooksEnvironmental([
        {
          kind: "unit_test",
          command: "pnpm test",
          passed: false,
          exitCode: 1,
          durationMs: 10,
          output: "AssertionError: expected false to be true"
        }
      ])
    ).toBe(false);

    expect(
      qualityGateFailureLooksEnvironmental([
        {
          kind: "setup",
          command: "./scripts/local.sh migrate",
          passed: false,
          exitCode: 1,
          durationMs: 10,
          output: "create migrate instance: failed to open database: pq: SSL is not enabled on the server"
        }
      ])
    ).toBe(true);
  });

  it("extends self-check repair when quality diagnostics keep changing", () => {
    const firstFailure: QualityGateResult[] = [
      {
        kind: "build",
        command: "go test ./...",
        passed: false,
        exitCode: 1,
        durationMs: 10,
        output: "undefined: fakeGitHubClient"
      }
    ];
    const nextFailure: QualityGateResult[] = [
      {
        kind: "build",
        command: "go test ./...",
        passed: false,
        exitCode: 1,
        durationMs: 10,
        output: "*fakeGitHubClient does not implement service.GitHubContentClient (missing method DeleteFile)"
      }
    ];

    expect(getSelfCheckHardMaxAttempts(4)).toBe(10);
    expect(qualityGateFailuresChanged(firstFailure, nextFailure)).toBe(true);
    expect(shouldExtendQualityGateSelfCheck(firstFailure, nextFailure, 4, 7)).toBe(true);
    expect(shouldExtendQualityGateSelfCheck(nextFailure, nextFailure, 7, 7)).toBe(false);
    expect(shouldExtendSelfCheckAfterFailureKindChange("review", "quality", 7, 10)).toBe(true);
    expect(shouldExtendSelfCheckAfterFailureKindChange("quality", "quality", 7, 10)).toBe(false);
    expect(shouldExtendSelfCheckAfterFailureKindChange("review", "quality", 10, 10)).toBe(false);
  });

  it("extracts quality-gate failure files for focused repair snippets", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-feedback-paths-"));
    await mkdir(path.join(repoDir, "backend/internal/handler"), { recursive: true });
    await mkdir(path.join(repoDir, "backend/internal/testutil"), { recursive: true });
    await writeFile(path.join(repoDir, "backend/internal/handler/main_test.go"), "package handler\n");
    await writeFile(path.join(repoDir, "backend/internal/testutil/postgres.go"), "package testutil\n");

    await expect(
      extractImplementationFeedbackPaths(
        repoDir,
        [
          "internal/handler/main_test.go:12:11: undefined: testutil.SetupTestDB",
          "frontend/src/missing.ts:1:1: ignored because it does not exist"
        ].join("\n")
      )
    ).resolves.toEqual(["backend/internal/handler/main_test.go", "backend/internal/testutil/postgres.go"]);
  });

  it("formats PRD comments for GitHub issue review", () => {
    const body = createPrdIssueComment({
      task: createTask(issue),
      prd: highComplexityPrd,
      requiresHumanReview: true,
      mention: "@codeZero",
      locale: "zh"
    });

    expect(body).toContain("## CodeZero PRD");
    expect(body).toContain("@codeZero approve prd");
    expect(body).toContain("验收标准");
  });

  it("compacts implementation context and prioritizes plan files", () => {
    const contextPack = compactableContextPack();
    const task = {
      contextPack,
      minimalChangePlan: {
        goal: "Change sync",
        acceptanceCriteria: [],
        filesToRead: ["src/read.ts", "src/change.ts"],
        filesExpectedToChange: ["src/change.ts"],
        testsToAddOrUpdate: ["src/change.test.ts (add coverage)"],
        commandsToRun: [],
        explicitNonGoals: [],
        riskNotes: []
      }
    } satisfies Pick<Task, "contextPack" | "minimalChangePlan">;

    expect(selectImplementationSnippetPaths(task)).toEqual(["src/change.ts", "src/read.ts", "src/change.test.ts", "src/existing.test.ts"]);

    const compact = compactContextPackForImplementation(contextPack);
    expect(JSON.stringify(compact)).not.toContain("large code block");
    expect(compact.codeGraphContext).toEqual({
      summary: "Relevant graph",
      relatedFiles: ["src/change.ts"],
      stats: { nodeCount: 1 }
    });
    expect(compact.knowledgeGraphContext).toEqual({
      provider: "Understand-Anything",
      graph: { nodes: 2, edges: 1 },
      files: ["src/change.ts"],
      highlights: [{ path: "src/change.ts", label: "Change" }]
    });
  });

  it("writes task artifacts through the shared artifact helper", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "agent-workflow-artifacts-"));
    const artifacts: Artifact[] = [];

    const artifact = await writeTaskArtifact({
      rootDir,
      tasks: {
        addArtifact: async (entry) => {
          artifacts.push(entry);
        }
      } as never,
      taskId: "task-1",
      type: "prd",
      fileName: "prd.json",
      content: "{\"title\":\"Demo\"}\n"
    });

    await expect(readFile(path.join(rootDir, "artifacts", "task-1", "prd.json"), "utf8")).resolves.toContain("Demo");
    expect(artifact.id).toMatch(/^artifact-/);
    expect(createArtifactId()).toMatch(/^artifact-/);
    expect(artifacts).toEqual([artifact]);
  });

  it("creates workflow agent definitions from prompt files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "agent-workflow-agent-"));
    await mkdir(path.join(rootDir, "prompts"), { recursive: true });
    await writeFile(path.join(rootDir, "prompts", "impl.md"), "You implement safely.\n");
    const config = createAppConfig(rootDir);

    const agent = await createWorkflowAgent(config, "implementation", "main-implementation", 72);

    expect(agent.providerId).toBe("large");
    expect(agent.systemPrompt).toContain("implement safely");
    expect(agent.tools).toEqual(["repo.read_file"]);
    expect(agent.guardrails).toEqual(["block-dangerous-shell"]);
  });

  it("validates workflow provider configuration before creating a runner", async () => {
    const config = createAppConfig("/tmp/project");

    await expect(createWorkflowAgentRunner(config, {})).rejects.toThrow("TEST_API_KEY is required");
    await expect(createWorkflowAgentRunner(config, { TEST_API_KEY: "secret" })).resolves.toBeDefined();
  });

  it("marks tasks failed when the issue repository is not configured", async () => {
    const task = createTask(issue);
    const tasks = new InMemoryTaskRepository(task);
    const runner = new IssueWorkflowRunner(createAppConfig("/tmp/project"), tasks);

    const result = await runner.run(task.id);

    expect(result.status).toBe("FAILED");
    expect((await tasks.getTask(task.id))?.status).toBe("FAILED");
    expect(tasks.events.map((event) => event.type)).toContain("TASK_FAILED");
  });

  it("stops before sandbox creation when a PRD needs human review", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "agent-workflow-review-"));
    await mkdir(path.join(rootDir, "prompts"), { recursive: true });
    await writeFile(path.join(rootDir, "prompts", "prd.md"), "Draft PRDs.\n");
    await writeFile(path.join(rootDir, "prompts", "impl.md"), "Implement.\n");
    await writeFile(path.join(rootDir, "prompts", "review.md"), "Review.\n");
    const task = {
      ...createTask(issue),
      prd: highComplexityPrd,
      status: "PRD_DRAFTED"
    } satisfies Task;
    const tasks = new InMemoryTaskRepository(task);
    const previousApiKey = process.env.TEST_API_KEY;
    process.env.TEST_API_KEY = "secret";

    try {
      const runner = new IssueWorkflowRunner(createAppConfig(rootDir, [repositoryConfig()]), tasks);
      const result = await runner.run(task.id);

      expect(result.status).toBe("PRD_REVIEW_REQUIRED");
      expect((await tasks.getTask(task.id))?.status).toBe("PRD_REVIEW_REQUIRED");
      expect(tasks.events.map((event) => event.type)).toContain("HUMAN_REVIEW_REQUIRED");
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.TEST_API_KEY;
      } else {
        process.env.TEST_API_KEY = previousApiKey;
      }
    }
  });
});

const issue: IssueContext = {
  provider: "github",
  owner: "acme",
  repo: "shop",
  number: 12,
  url: "https://github.com/acme/shop/issues/12",
  title: "Add refund audit note",
  body: "",
  labels: [],
  comments: [],
  baseBranch: "main"
};

const highComplexityPrd: PrdDocument = {
  title: "Add refund audit note",
  background: "The issue needs implementation.",
  goals: ["Add audit note"],
  nonGoals: [],
  userStories: [],
  acceptanceCriteria: ["Audit note is present"],
  risks: [],
  unknowns: [],
  taskType: "backend",
  complexity: {
    score: 80,
    requiresHumanReview: false,
    reasons: ["large change"]
  }
};

function minimalPlan() {
  return {
    goal: "Update behavior",
    acceptanceCriteria: ["The behavior is updated"],
    filesToRead: ["src/change.ts"],
    filesExpectedToChange: ["src/change.ts"],
    testsToAddOrUpdate: ["src/change.test.ts"],
    commandsToRun: ["npm test"],
    explicitNonGoals: [],
    riskNotes: []
  };
}

function compactableContextPack(): ContextPack {
  return {
    id: "ctx-1",
    taskId: "task-1",
    taskSummary: "Demo task",
    businessRules: ["Rule"],
    memories: [],
    codeGraphContext: {
      summary: "Relevant graph",
      relatedFiles: ["src/change.ts"],
      stats: { nodeCount: 1 },
      codeBlocks: [{ content: "large code block" }]
    },
    knowledgeGraphContext: {
      provider: "Understand-Anything",
      graph: { nodes: 2, edges: 1 },
      files: ["src/change.ts"],
      highlights: [{ path: "src/change.ts", label: "Change" }]
    },
    relevantFiles: [
      { path: "src/change.ts", reason: "plan", evidence: [], readMode: "full" },
      { path: "src/read.ts", reason: "plan", evidence: [], readMode: "full" }
    ],
    symbols: Array.from({ length: 50 }, (_, index) => `symbol-${index}`),
    tests: ["src/existing.test.ts"],
    similarChanges: [],
    nonRelevantAreas: [],
    openQuestions: [],
    tokenBudget: 1000,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function createAppConfig(rootDir: string, repositories: RepositoryConfig[] = []): AppConfig {
  return {
    rootDir,
    agents: {
      providers: {
        default: {
          type: "openai-compatible",
          base_url: "https://api.example.test",
          api_key_env: "TEST_API_KEY",
          model: "model-default",
          supports_tools: true,
          supports_structured_output: true
        },
        large: {
          type: "openai-compatible",
          base_url: "https://api.example.test",
          api_key_env: "TEST_API_KEY",
          model: "model-large",
          supports_tools: true,
          supports_structured_output: true
        }
      },
      agents: {
        prd: {
          provider: "default",
          provider_by_complexity: {},
          system_prompt: "prompts/prd.md",
          skills: ["prd"]
        },
        implementation: {
          provider: "default",
          provider_by_complexity: { high: "large" },
          system_prompt: "prompts/impl.md",
          skills: ["implementation"]
        },
        review: {
          provider: "default",
          provider_by_complexity: {},
          system_prompt: "prompts/review.md",
          skills: ["review"]
        }
      }
    },
    repositories,
    sandbox: {
      mode: "worktree",
      image: "agent-sandbox-node:latest",
      root_dir: "./sandboxes",
      network: { allow: [] },
      limits: {
        max_runtime_minutes: 90,
        max_diff_files: 30,
        max_diff_lines: 1200,
        max_quality_gate_retries: 3
      }
    },
    policies: [
      {
        id: "block-dangerous-shell",
        tool_names: [],
        permissions: [],
        match_paths: [],
        match_commands: ["rm -rf"],
        action: "block"
      }
    ],
    tools: [
      {
        name: "repo.read_file",
        description: "Read",
        permission: "read",
        policy_refs: []
      }
    ],
    storage: {
      driver: "file",
      filePath: path.join(rootDir, "data", "tasks.json")
    },
    memory: {
      filePath: path.join(rootDir, "data", "memory.json")
    },
    github: {}
  };
}

function repositoryConfig(): RepositoryConfig {
  return {
    id: "shop",
    github_owner: "acme",
    github_repo: "shop",
    default_branch: "main",
    project_skill_path: ".agent",
    trigger: {
      mode: "manual",
      mention: "@agent-prd",
      auto_events: [],
      label_allowlist: [],
      label_blocklist: [],
      actor_allowlist: []
    },
    codebase_intelligence: {
      codegraph: {
        enabled: false,
        package: "@colbymchenry/codegraph@0.9.3",
        init_args: ["--index"],
        timeout_ms: 600_000,
        fail_on_error: true
      },
      navigation_graph: {
        enabled: false,
        include_git_history: false,
        include_codeowners: false,
        max_depth: 1
      }
    },
    queue: {
      max_concurrent_issues: 1
    },
    permissions: {
      allowed_tools: [],
      blocked_tools: [],
      allowed_permissions: [],
      blocked_permissions: []
    },
    quality_gates: {},
    frontend: {
      screenshot_urls: []
    },
    pr: {
      default_draft: true
    }
  };
}

class InMemoryTaskRepository implements TaskRepository {
  readonly events: TaskEvent[] = [];
  readonly artifacts: Artifact[] = [];

  constructor(private task: Task) {}

  async createTask(task: Task): Promise<Task> {
    this.task = task;
    return this.task;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    if (id !== this.task.id) {
      throw new Error(`Task not found: ${id}`);
    }

    this.task = { ...this.task, ...patch, id: this.task.id, createdAt: this.task.createdAt, updatedAt: new Date().toISOString() };
    return this.task;
  }

  async getTask(id: string): Promise<Task | undefined> {
    return id === this.task.id ? this.task : undefined;
  }

  async listTasks(): Promise<Task[]> {
    return [this.task];
  }

  async appendEvent(event: TaskEvent): Promise<void> {
    this.events.push(event);
  }

  async listEvents(taskId: string): Promise<TaskEvent[]> {
    return this.events.filter((event) => event.taskId === taskId);
  }

  async addArtifact(artifact: Artifact): Promise<void> {
    this.artifacts.push(artifact);
  }

  async listArtifacts(taskId: string): Promise<Artifact[]> {
    return this.artifacts.filter((artifact) => artifact.taskId === taskId);
  }
}
