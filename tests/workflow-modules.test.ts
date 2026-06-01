import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig, RepositoryConfig } from "@agent/config";
import { createTask } from "@agent/orchestrator";
import type { TaskRepository } from "@agent/persistence";
import { runCommand } from "@agent/sandbox";
import { createIssueWorkflowGraphRunner } from "@agent/workflow-graph";
import type {
  Artifact,
  ContextPack,
  IssueContext,
  PlanningDocument,
  PrdDocument,
  QualityGateResult,
  Task,
  TaskEvent,
} from "@agent/shared";
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
  IssueWorkflowRunner,
  normalizeCodingExecutorProgressLine,
  normalizeImplementationExecutorConfig,
  qualityGateFailuresChanged,
  qualityGateFailureLooksEnvironmental,
  resetImplementationAttempt,
  runCodingCliExecutor,
  restoreImplementationCheckpoint,
  selectImplementationSnippetPaths,
  selectProviderForComplexity,
  shouldExtendQualityGateSelfCheck,
  shouldExtendSelfCheckAfterFailureKindChange,
  planningDocumentSchema,
  writeTaskArtifact,
} from "@agent/workflows";

describe("workflow modules", () => {
  it("normalizes planning JSON variants from fast models", () => {
    const planningDocument = planningDocumentSchema.parse({
      title: "Make GitHub upload asynchronous",
      background: "The upload flow currently blocks the request.",
      goals: "Move the blocking GitHub upload work behind a background task.",
      acceptanceCriteria: "The UI can observe async upload status.",
      risks: "Avoid duplicate upload jobs.",
      unknowns: "",
      complexity: {
        score: 45,
        requiresHumanReview: false,
        reasons: "Touches backend and UI status handling.",
      },
      implementationPlan: {
        filesExpectedToChange: "backend/internal/service/github_sync_service.go",
        riskNotes: "Keep upload retries idempotent.",
      },
    });

    expect(planningDocument.goals).toEqual([
      "Move the blocking GitHub upload work behind a background task.",
    ]);
    expect(planningDocument.implementationPlan.goal).toBe(
      "Move the blocking GitHub upload work behind a background task.",
    );
    expect(planningDocument.implementationPlan.filesExpectedToChange).toEqual([
      "backend/internal/service/github_sync_service.go",
    ]);
    expect(planningDocument.implementationPlan.riskNotes).toEqual([
      "Keep upload retries idempotent.",
    ]);
  });

  it("selects providers by task complexity with a conservative fallback", () => {
    const providerByComplexity = {
      low: "small",
      medium: "balanced",
      high: "large",
    };

    expect(
      selectProviderForComplexity("default", providerByComplexity, undefined),
    ).toBe("default");
    expect(
      selectProviderForComplexity("default", providerByComplexity, 35),
    ).toBe("small");
    expect(
      selectProviderForComplexity("default", providerByComplexity, 70),
    ).toBe("balanced");
    expect(
      selectProviderForComplexity("default", providerByComplexity, 71),
    ).toBe("large");
    expect(selectProviderForComplexity("default", {}, 99)).toBe("default");
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
      guardrails: [],
    };

    try {
      const env = buildCodingExecutorEnv({
        config: createAppConfig("/tmp/project"),
        agent,
        executor,
      });
      const prompt = buildCodingExecutorPrompt({
        task: {
          ...createTask(issue),
          planningDocument: highComplexityPlanningDocument(),
          contextPack: compactableContextPack(),
        },
        planningDocument: highComplexityPlanningDocument(),
        implementationContext: compactContextPackForImplementation(
          compactableContextPack(),
        ),
        fileSnippets: { "src/change.ts": "old\n" },
      });

      expect(executor.mode).toBe("cli");
      expect(executor.command).toContain("OPENCODE_BIN");
      expect(executor.command).toContain("opencode");
      expect(executor.command).toContain("--variant");
      expect(executor.command).toContain("--dangerously-skip-permissions");
      expect(executor.command).toContain('--file="$CODEZERO_PROMPT_FILE"');
      expect(executor.command).toContain(
        '--dangerously-skip-permissions "Implement the CodeZero request in the attached prompt file." --file="$CODEZERO_PROMPT_FILE"',
      );
      expect(env.OPENAI_API_KEY).toBe("secret");
      expect(env.OPENAI_BASE_URL).toBe("https://api.example.test");
      expect(env.CODEZERO_OPENCODE_PROVIDER).toBe("codezero");
      expect(env.CODEZERO_OPENCODE_MODEL).toBe("codezero/model-default");
      expect(prompt).toContain("CodeZero Implementation Request");
      expect(prompt).not.toContain("OpenCode");
      expect(prompt).toContain(
        "Leave the working tree with the required code changes",
      );
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.TEST_API_KEY;
      } else {
        process.env.TEST_API_KEY = previousApiKey;
      }
    }
  });

  it("allows providers to choose a native coding executor model", () => {
    const config = createAppConfig("/tmp/project");
    const defaultProvider = config.agents.providers.default;

    if (!defaultProvider) {
      throw new Error("missing default provider");
    }

    config.agents.providers.default = {
      ...defaultProvider,
      coding_executor: {
        mode: "native",
        provider_id: "anthropic",
        model: "claude-sonnet-4-5",
        env: { ANTHROPIC_API_KEY: "secret" },
        options: {},
        model_options: {},
      },
    };
    const executor = normalizeImplementationExecutorConfig(undefined);
    const agent = {
      id: "implementation",
      role: "main-implementation" as const,
      providerId: "default",
      systemPrompt: "Implement.",
      skillRefs: [],
      tools: [],
      guardrails: [],
    };

    const env = buildCodingExecutorEnv({ config, agent, executor });

    expect(env.CODEZERO_OPENCODE_PROVIDER).toBe("anthropic");
    expect(env.CODEZERO_OPENCODE_MODEL).toBe("anthropic/claude-sonnet-4-5");
    expect(env.CODEZERO_OPENCODE_MODE).toBe("native");
    expect(env.ANTHROPIC_API_KEY).toBe("secret");
  });

  it("normalizes OpenCode stream output without exposing hidden reasoning text", () => {
    expect(
      normalizeCodingExecutorProgressLine(
        JSON.stringify({
          type: "tool",
          tool: "edit",
          path: "src/app.ts",
          message: "editing file",
        }),
      ),
    ).toMatchObject({
      message: "OpenCode tool: edit src/app.ts",
      metadata: {
        eventType: "tool",
        filePath: "src/app.ts",
        toolName: "edit",
      },
    });

    expect(
      normalizeCodingExecutorProgressLine(
        JSON.stringify({ type: "reasoning", text: "private chain of thought" }),
      ),
    ).toMatchObject({
      message: "OpenCode is planning the next implementation step",
    });
    expect(
      normalizeCodingExecutorProgressLine(
        'npm warn Unknown env config "recursive"',
        "stderr",
      ),
    ).toBeUndefined();
    expect(
      normalizeCodingExecutorProgressLine("Error: model failed", "stderr"),
    ).toMatchObject({
      level: "error",
      message: "OpenCode stderr: Error: model failed",
    });
  });

  it("runs a CLI coding executor in the sandbox and captures the resulting diff", async () => {
    const repoDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-coding-executor-"),
    );
    const artifactDir = path.join(repoDir, "artifacts");
    await runCommand({ cwd: repoDir, command: "git init" });
    await runCommand({
      cwd: repoDir,
      command:
        "git config user.email test@example.com && git config user.name Test",
    });
    await writeFile(path.join(repoDir, "app.txt"), "old\n");
    await runCommand({
      cwd: repoDir,
      command: "git add app.txt && git commit -m init",
    });
    await writeFile(path.join(repoDir, ".git", "opencode"), "stale-project");
    const previousApiKey = process.env.TEST_API_KEY;
    process.env.TEST_API_KEY = "secret";
    const executor = normalizeImplementationExecutorConfig({
      mode: "cli",
      name: "test-cli",
      command:
        "node -e \"const fs=require('fs'); if(!process.env.OPENAI_API_KEY || !process.env.CODEZERO_PROMPT_FILE || !process.env.OPENCODE_CONFIG || !process.env.HOME.includes('coding-executor') || !process.env.XDG_DATA_HOME || !process.env.XDG_CONFIG_HOME || fs.existsSync('.git/opencode')) process.exit(7); fs.writeFileSync('app.txt', 'new\\\\n')\"",
      timeout_ms: 30_000,
      env: {},
    });
    const agent = {
      id: "implementation",
      role: "main-implementation" as const,
      providerId: "default",
      systemPrompt: "Implement.",
      skillRefs: [],
      tools: [],
      guardrails: [],
    };

    try {
      const baseRepository = repositoryConfig();
      const codeGraphRepository: RepositoryConfig = {
        ...baseRepository,
        codebase_intelligence: {
          ...baseRepository.codebase_intelligence,
          codegraph: {
            ...baseRepository.codebase_intelligence.codegraph,
            enabled: true,
          },
        },
      };
      const result = await runCodingCliExecutor({
        config: createAppConfig(repoDir, [codeGraphRepository]),
        executor,
        agent,
        task: {
          ...createTask(issue),
          planningDocument: highComplexityPlanningDocument(),
          contextPack: compactableContextPack(),
        },
        repoDir,
        artifactDir,
        prompt: "Change app.txt",
        attempt: 1,
      });

      expect(result.commandResult.exitCode).toBe(0);
      expect(result.diff).toContain("-old");
      expect(result.diff).toContain("+new");
      await expect(readFile(result.promptPath, "utf8")).resolves.toBe(
        "Change app.txt",
      );
      expect(result.openCodeConfigPath).toBeDefined();
      const openCodeConfig = JSON.parse(
        await readFile(result.openCodeConfigPath ?? "", "utf8"),
      ) as {
        model: string;
        provider: {
          codezero: {
            options: { apiKey: string; baseURL: string };
            models: Record<string, unknown>;
          };
        };
        mcp: {
          codegraph: {
            type: string;
            command: string[];
            environment: Record<string, string>;
            enabled: boolean;
            timeout: number;
          };
        };
      };
      expect(openCodeConfig.model).toBe("codezero/model-default");
      expect(openCodeConfig.provider.codezero.options.baseURL).toBe(
        "https://api.example.test",
      );
      expect(openCodeConfig.provider.codezero.options.apiKey).toBe(
        "{env:OPENAI_API_KEY}",
      );
      expect(
        openCodeConfig.provider.codezero.models["model-default"],
      ).toBeDefined();
      expect(openCodeConfig.mcp.codegraph).toEqual({
        type: "local",
        command: [
          "npx",
          "-y",
          "@colbymchenry/codegraph@0.9.3",
          "serve",
          "--mcp",
          "--path",
          repoDir,
        ],
        environment: {
          CODEGRAPH_FORCE_WATCH: "1",
        },
        enabled: true,
        timeout: 30_000,
      });
      expect(JSON.stringify(openCodeConfig)).not.toContain("secret");
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.TEST_API_KEY;
      } else {
        process.env.TEST_API_KEY = previousApiKey;
      }
    }
  });

  it("passes screenshot artifacts and supporting snippets into review context", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-review-context-"));
    await mkdir(path.join(repoDir, "styles", "sections"), { recursive: true });
    await writeFile(
      path.join(repoDir, "index.html"),
      '<section id="projects"><p>Old copy</p></section>\n',
    );
    await writeFile(
      path.join(repoDir, "styles", "sections", "projects.css"),
      ".project-kicker { color: var(--accent); }\n",
    );
    await runCommand({ cwd: repoDir, command: "git init" });
    await runCommand({
      cwd: repoDir,
      command:
        "git config user.email test@example.com && git config user.name Test",
    });
    await runCommand({
      cwd: repoDir,
      command: "git add . && git commit -m init",
    });
    await writeFile(
      path.join(repoDir, "index.html"),
      '<section id="projects"><p><span class="project-kicker">*</span> Verified delivery evidence</p></section>\n',
    );

    const task = {
      ...createTask(issue),
      planningDocument: {
        ...highComplexityPlanningDocument(),
        implementationPlan: {
          ...minimalPlan(),
          filesToRead: ["styles/sections/projects.css"],
          filesExpectedToChange: ["index.html"],
          testsToAddOrUpdate: [],
        },
      },
      contextPack: compactableContextPack(),
      qualityGateResults: [
        {
          kind: "frontend_screenshot",
          command: "npm run dev",
          passed: true,
          exitCode: 0,
          durationMs: 100,
          output: "captured",
        },
      ] satisfies QualityGateResult[],
    };
    const tasks = new InMemoryTaskRepository(task);
    await tasks.addArtifact({
      id: "artifact-1",
      taskId: task.id,
      type: "screenshot",
      path: path.join(repoDir, "artifacts", "desktop.png"),
      metadata: { url: "http://127.0.0.1:5500/", viewport: "desktop" },
      createdAt: new Date().toISOString(),
    });
    let capturedContext: Record<string, unknown> | undefined;
    const runner = {
      run: async (input: { context: Record<string, unknown> }) => {
        capturedContext = input.context;
        return {
          content: JSON.stringify({
            approved: true,
            blockingFindings: [],
            nonBlockingFindings: [],
            missingTests: [],
            scopeViolations: [],
            riskLevel: "low",
            prDescriptionNotes: ["Screenshots provided"],
          }),
          raw: {},
        };
      },
    };
    const agent = {
      id: "review",
      role: "review" as const,
      providerId: "default",
      systemPrompt: "Review.",
      skillRefs: [],
      tools: [],
      guardrails: [],
    };
    const workflow = new IssueWorkflowRunner(createAppConfig(repoDir), tasks);

    await (
      workflow as unknown as {
        review: (
          task: Task,
          sandbox: {
            repoDir: string;
            artifactDir: string;
            logDir: string;
            mode: "worktree";
          },
          runner: typeof runner,
          agent: typeof agent,
        ) => Promise<unknown>;
      }
    ).review(
      task,
      {
        repoDir,
        artifactDir: path.join(repoDir, "artifacts"),
        logDir: path.join(repoDir, "logs"),
        mode: "worktree",
      },
      runner,
      agent,
    );

    expect(capturedContext?.screenshotArtifacts).toEqual([
      {
        id: "artifact-1",
        path: path.join(repoDir, "artifacts", "desktop.png"),
        url: undefined,
        metadata: { url: "http://127.0.0.1:5500/", viewport: "desktop" },
      },
    ]);
    expect(
      (capturedContext?.fileSnippets as Record<string, string>)["index.html"],
    ).toContain("Verified delivery evidence");
    expect(
      (capturedContext?.fileSnippets as Record<string, string>)[
        "styles/sections/projects.css"
      ],
    ).toContain(".project-kicker");
  });

  it("writes a custom coding provider config without storing API keys", async () => {
    const repoDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-custom-coding-provider-"),
    );
    const artifactDir = path.join(repoDir, "artifacts");
    await runCommand({ cwd: repoDir, command: "git init" });
    await runCommand({
      cwd: repoDir,
      command:
        "git config user.email test@example.com && git config user.name Test",
    });
    await writeFile(path.join(repoDir, "app.txt"), "old\n");
    await runCommand({
      cwd: repoDir,
      command: "git add app.txt && git commit -m init",
    });
    const config = createAppConfig(repoDir);
    const defaultProvider = config.agents.providers.default;

    if (!defaultProvider) {
      throw new Error("missing default provider");
    }

    config.agents.providers.default = {
      ...defaultProvider,
      coding_executor: {
        mode: "custom",
        provider_id: "openrouter",
        model: "anthropic/claude-sonnet-4-5",
        npm: "@ai-sdk/openai-compatible",
        name: "OpenRouter",
        options: {
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: "{env:OPENROUTER_API_KEY}",
        },
        model_options: {
          limit: {
            context: 200000,
            output: 64000,
          },
        },
        env: { OPENROUTER_API_KEY: "secret-openrouter-key" },
      },
    };
    const executor = normalizeImplementationExecutorConfig({
      mode: "cli",
      name: "test-cli",
      command:
        "node -e \"const fs=require('fs'); if(process.env.CODEZERO_OPENCODE_MODEL !== 'openrouter/anthropic/claude-sonnet-4-5' || process.env.OPENROUTER_API_KEY !== 'secret-openrouter-key') process.exit(7); fs.writeFileSync('app.txt', 'new\\\\n')\"",
      timeout_ms: 30_000,
      env: {},
    });
    const agent = {
      id: "implementation",
      role: "main-implementation" as const,
      providerId: "default",
      systemPrompt: "Implement.",
      skillRefs: [],
      tools: [],
      guardrails: [],
    };

    const result = await runCodingCliExecutor({
      config,
      executor,
      agent,
      task: {
        ...createTask(issue),
        planningDocument: highComplexityPlanningDocument(),
        contextPack: compactableContextPack(),
      },
      repoDir,
      artifactDir,
      prompt: "Change app.txt",
      attempt: 1,
    });

    expect(result.commandResult.exitCode).toBe(0);
    const openCodeConfig = JSON.parse(
      await readFile(result.openCodeConfigPath ?? "", "utf8"),
    ) as {
      model: string;
      provider: {
        openrouter: {
          options: { apiKey: string; baseURL: string };
          models: Record<
            string,
            { limit?: { context: number; output: number } }
          >;
        };
      };
    };
    expect(openCodeConfig.model).toBe("openrouter/anthropic/claude-sonnet-4-5");
    expect(openCodeConfig.provider.openrouter.options.baseURL).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(openCodeConfig.provider.openrouter.options.apiKey).toBe(
      "{env:OPENROUTER_API_KEY}",
    );
    expect(
      openCodeConfig.provider.openrouter.models["anthropic/claude-sonnet-4-5"]
        ?.limit?.context,
    ).toBe(200000);
    expect(JSON.stringify(openCodeConfig)).not.toContain(
      "secret-openrouter-key",
    );
  });

  it("rolls back partial implementation edits before a retry", async () => {
    const repoDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-workflow-reset-"),
    );
    await runCommand({ cwd: repoDir, command: "git init" });
    await runCommand({
      cwd: repoDir,
      command:
        "git config user.email test@example.com && git config user.name Test",
    });
    await writeFile(path.join(repoDir, "app.ts"), "old\n");
    await runCommand({
      cwd: repoDir,
      command: "git add app.ts && git commit -m init",
    });

    await writeFile(path.join(repoDir, "app.ts"), "partial\n");
    await writeFile(path.join(repoDir, "new-file.ts"), "new\n");

    await resetImplementationAttempt(repoDir);

    const status = await runCommand({
      cwd: repoDir,
      command: "git status --short",
    });
    await expect(readFile(path.join(repoDir, "app.ts"), "utf8")).resolves.toBe(
      "old\n",
    );
    expect(status.stdout.trim()).toBe("");
  });

  it("restores a failed retry to the checkpoint without losing previous edits", async () => {
    const repoDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-workflow-checkpoint-"),
    );
    await runCommand({ cwd: repoDir, command: "git init" });
    await runCommand({
      cwd: repoDir,
      command:
        "git config user.email test@example.com && git config user.name Test",
    });
    await writeFile(path.join(repoDir, "app.ts"), "old\n");
    await runCommand({
      cwd: repoDir,
      command: "git add app.ts && git commit -m init",
    });

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

    const status = await runCommand({
      cwd: repoDir,
      command: "git status --short",
    });
    await expect(readFile(path.join(repoDir, "app.ts"), "utf8")).resolves.toBe(
      "implemented\n",
    );
    await expect(
      readFile(path.join(repoDir, "new-file.ts"), "utf8"),
    ).resolves.toBe("created\n");
    await expect(
      readFile(path.join(repoDir, "scratch.ts"), "utf8"),
    ).rejects.toThrow();
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
          output: "Expected async sync status to be success",
        },
      ],
      1,
      4,
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
        blockingFindings: [
          {
            title: "Missing retry",
            body: "The failed state has no retry path.",
            blocking: true,
            file: "src/sync.ts",
          },
        ],
        nonBlockingFindings: [],
        missingTests: ["Add failed sync coverage"],
        scopeViolations: [],
        riskLevel: "medium",
        prDescriptionNotes: [],
      },
      2,
      4,
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
          output:
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        },
      ]),
    ).toBe(true);

    expect(
      qualityGateFailureLooksEnvironmental([
        {
          kind: "unit_test",
          command: "pnpm test",
          passed: false,
          exitCode: 1,
          durationMs: 10,
          output: "AssertionError: expected false to be true",
        },
      ]),
    ).toBe(false);

    expect(
      qualityGateFailureLooksEnvironmental([
        {
          kind: "setup",
          command: "./scripts/local.sh migrate",
          passed: false,
          exitCode: 1,
          durationMs: 10,
          output:
            "create migrate instance: failed to open database: pq: SSL is not enabled on the server",
        },
      ]),
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
        output: "undefined: fakeGitHubClient",
      },
    ];
    const nextFailure: QualityGateResult[] = [
      {
        kind: "build",
        command: "go test ./...",
        passed: false,
        exitCode: 1,
        durationMs: 10,
        output:
          "*fakeGitHubClient does not implement service.GitHubContentClient (missing method DeleteFile)",
      },
    ];

    expect(getSelfCheckHardMaxAttempts(4)).toBe(10);
    expect(qualityGateFailuresChanged(firstFailure, nextFailure)).toBe(true);
    expect(
      shouldExtendQualityGateSelfCheck(firstFailure, nextFailure, 4, 7),
    ).toBe(true);
    expect(
      shouldExtendQualityGateSelfCheck(nextFailure, nextFailure, 7, 7),
    ).toBe(false);
    expect(
      shouldExtendSelfCheckAfterFailureKindChange("review", "quality", 7, 10),
    ).toBe(true);
    expect(
      shouldExtendSelfCheckAfterFailureKindChange("quality", "quality", 7, 10),
    ).toBe(false);
    expect(
      shouldExtendSelfCheckAfterFailureKindChange("review", "quality", 10, 10),
    ).toBe(false);
  });

  it("extracts quality-gate failure files for focused repair snippets", async () => {
    const repoDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-feedback-paths-"),
    );
    await mkdir(path.join(repoDir, "backend/internal/handler"), {
      recursive: true,
    });
    await mkdir(path.join(repoDir, "backend/internal/testutil"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoDir, "backend/internal/handler/main_test.go"),
      "package handler\n",
    );
    await writeFile(
      path.join(repoDir, "backend/internal/testutil/postgres.go"),
      "package testutil\n",
    );

    await expect(
      extractImplementationFeedbackPaths(
        repoDir,
        [
          "internal/handler/main_test.go:12:11: undefined: testutil.SetupTestDB",
          "frontend/src/missing.ts:1:1: ignored because it does not exist",
        ].join("\n"),
      ),
    ).resolves.toEqual([
      "backend/internal/handler/main_test.go",
      "backend/internal/testutil/postgres.go",
    ]);
  });

  it("formats PRD comments for GitHub issue review", () => {
    const body = createPrdIssueComment({
      task: createTask(issue),
      planningDocument: highComplexityPlanningDocument(),
      requiresHumanReview: true,
      mention: "@codeZero",
      locale: "zh",
    });

    expect(body).toContain("## CodeZero PRD");
    expect(body).toContain("@codeZero approve prd");
    expect(body).toContain("验收标准");
    expect(body).toContain("PRD 执行计划");
    expect(body).toContain("src/change.ts");
  });

  it("compacts implementation context and prioritizes plan files", () => {
    const contextPack = compactableContextPack();
    const task = {
      contextPack,
      planningDocument: {
        ...highComplexityPlanningDocument(),
        implementationPlan: {
          goal: "Change sync",
          acceptanceCriteria: [],
          filesToRead: ["src/read.ts", "src/change.ts"],
          filesExpectedToChange: ["src/change.ts"],
          testsToAddOrUpdate: ["src/change.test.ts (add coverage)"],
          commandsToRun: [],
          explicitNonGoals: [],
          riskNotes: [],
        },
      },
    } satisfies Pick<Task, "contextPack" | "planningDocument">;

    expect(selectImplementationSnippetPaths(task)).toEqual([
      "src/change.ts",
      "src/read.ts",
      "src/change.test.ts",
      "src/existing.test.ts",
    ]);

    const compact = compactContextPackForImplementation(contextPack);
    expect(JSON.stringify(compact)).not.toContain("large code block");
    expect(compact.codeGraphContext).toEqual({
      summary: "Relevant graph",
      relatedFiles: ["src/change.ts"],
      stats: { nodeCount: 1 },
    });
    expect(JSON.stringify(compact)).not.toContain("Understand-Anything");
  });

  it("writes task artifacts through the shared artifact helper", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-workflow-artifacts-"),
    );
    const artifacts: Artifact[] = [];

    const artifact = await writeTaskArtifact({
      rootDir,
      tasks: {
        addArtifact: async (entry) => {
          artifacts.push(entry);
        },
      } as never,
      taskId: "task-1",
      type: "prd",
      fileName: "prd.json",
      content: '{"title":"Demo"}\n',
    });
    const second = await writeTaskArtifact({
      rootDir,
      tasks: {
        addArtifact: async (entry) => {
          artifacts.push(entry);
        },
      } as never,
      taskId: "task-1",
      type: "prd",
      fileName: "prd.json",
      content: '{"title":"Second"}\n',
    });

    await expect(
      readFile(path.join(rootDir, "artifacts", "task-1", "prd.json"), "utf8"),
    ).resolves.toContain("Demo");
    await expect(readFile(second.path, "utf8")).resolves.toContain("Second");
    expect(artifact.id).toMatch(/^artifact-/);
    expect(second.path).not.toBe(artifact.path);
    expect(path.basename(second.path)).toMatch(/^prd\.\d+-\d+-[a-f0-9]+\.json$/);
    expect(createArtifactId()).toMatch(/^artifact-/);
    expect(artifacts).toEqual([artifact, second]);
  });

  it("creates workflow agent definitions from prompt files", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-workflow-agent-"),
    );
    await mkdir(path.join(rootDir, "prompts"), { recursive: true });
    await writeFile(
      path.join(rootDir, "prompts", "impl.md"),
      "You implement safely.\n",
    );
    const config = createAppConfig(rootDir);

    const agent = await createWorkflowAgent(
      config,
      "implementation",
      "main-implementation",
      72,
    );

    expect(agent.providerId).toBe("large");
    expect(agent.systemPrompt).toContain("implement safely");
    expect(agent.tools).toEqual(["repo.read_file"]);
    expect(agent.guardrails).toEqual(["block-dangerous-shell"]);
  });

  it("validates workflow provider configuration before creating a runner", async () => {
    const config = createAppConfig("/tmp/project");

    await expect(createWorkflowAgentRunner(config, {})).rejects.toThrow(
      "TEST_API_KEY is required",
    );
    await expect(
      createWorkflowAgentRunner(config, { TEST_API_KEY: "secret" }),
    ).resolves.toBeDefined();
  });

  it("marks tasks failed when the issue repository is not configured", async () => {
    const task = createTask(issue);
    const tasks = new InMemoryTaskRepository(task);
    const runner = new IssueWorkflowRunner(
      createAppConfig("/tmp/project"),
      tasks,
    );

    const result = await runner.run(task.id);

    expect(result.status).toBe("FAILED");
    expect((await tasks.getTask(task.id))?.status).toBe("FAILED");
    expect(tasks.events.map((event) => event.type)).toContain("TASK_FAILED");
  });

  it("keeps a persistent sandbox while waiting for planning approval", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-workflow-review-"),
    );
    await mkdir(path.join(rootDir, "prompts"), { recursive: true });
    await writeFile(path.join(rootDir, "prompts", "prd.md"), "Draft PRDs.\n");
    await writeFile(path.join(rootDir, "prompts", "impl.md"), "Implement.\n");
    await writeFile(path.join(rootDir, "prompts", "review.md"), "Review.\n");
    const repoDir = path.join(
      rootDir,
      "sandboxes",
      "task-acme-shop-12",
      "repo",
    );
    const artifactDir = path.join(
      rootDir,
      "sandboxes",
      "task-acme-shop-12",
      "artifacts",
    );
    const logDir = path.join(rootDir, "sandboxes", "task-acme-shop-12", "logs");
    await mkdir(repoDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await mkdir(logDir, { recursive: true });
    await runCommand({ cwd: repoDir, command: "git init" });
    await runCommand({
      cwd: repoDir,
      command:
        "git config user.email test@example.com && git config user.name Test",
    });
    await writeFile(path.join(repoDir, "README.md"), "demo\n");
    await runCommand({
      cwd: repoDir,
      command:
        "git add README.md && git commit -m init && git checkout -b agent/issue-12",
    });
    const task = {
      ...createTask(issue),
      planningDocument: highComplexityPlanningDocument(),
      contextPack: compactableContextPack(),
      sandbox: {
        repoDir,
        artifactDir,
        logDir,
        mode: "worktree" as const,
      },
      status: "PRD_DRAFTED",
    } satisfies Task;
    const tasks = new InMemoryTaskRepository(task);
    const previousApiKey = process.env.TEST_API_KEY;
    process.env.TEST_API_KEY = "secret";

    try {
      const runner = new IssueWorkflowRunner(
        createAppConfig(rootDir, [repositoryConfig()]),
        tasks,
      );
      const result = await runner.run(task.id);

      expect(result.status).toBe("PRD_REVIEW_REQUIRED");
      const updated = await tasks.getTask(task.id);
      expect(updated?.status).toBe("PRD_REVIEW_REQUIRED");
      expect(updated?.sandbox?.repoDir).toBe(repoDir);
      expect(tasks.events.map((event) => event.type)).toContain(
        "HUMAN_REVIEW_REQUIRED",
      );
      expect(
        tasks.events.some((event) =>
          event.message.includes("Reusing persistent task sandbox"),
        ),
      ).toBe(true);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.TEST_API_KEY;
      } else {
        process.env.TEST_API_KEY = previousApiKey;
      }
    }
  });

  it("pauses the graph with a PRD approval interrupt", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-workflow-graph-approval-"),
    );
    const repoDir = path.join(
      rootDir,
      "sandboxes",
      "task-acme-shop-12",
      "repo",
    );
    const artifactDir = path.join(
      rootDir,
      "sandboxes",
      "task-acme-shop-12",
      "artifacts",
    );
    const logDir = path.join(rootDir, "sandboxes", "task-acme-shop-12", "logs");
    await mkdir(repoDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await mkdir(logDir, { recursive: true });
    await runCommand({ cwd: repoDir, command: "git init" });
    await writeFile(path.join(repoDir, "README.md"), "demo\n");
    const task = {
      ...createTask(issue),
      planningDocument: highComplexityPlanningDocument(),
      contextPack: compactableContextPack(),
      sandbox: {
        repoDir,
        artifactDir,
        logDir,
        mode: "worktree" as const,
      },
      status: "PRD_DRAFTED",
    } satisfies Task;
    const tasks = new InMemoryTaskRepository(task);
    const runner = createIssueWorkflowGraphRunner(
      createAppConfig(rootDir, [repositoryConfig()]),
      tasks,
    );

    const result = await runner.run(task.id);
    const updated = await tasks.getTask(task.id);

    expect(result.status).toBe("PRD_REVIEW_REQUIRED");
    expect(updated?.status).toBe("PRD_REVIEW_REQUIRED");
    expect(tasks.events.map((event) => event.type)).toContain(
      "HUMAN_REVIEW_REQUIRED",
    );
    expect(
      tasks.events.some(
        (event) =>
          event.type === "AGENT_RUN_FINISHED" &&
          Array.isArray(event.metadata?.interrupts),
      ),
    ).toBe(true);
  });

  it("reuses the task sandbox for PR feedback instead of creating feedback sandboxes", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-workflow-feedback-"),
    );
    const repoDir = path.join(
      rootDir,
      "sandboxes",
      "task-acme-shop-12",
      "repo",
    );
    const artifactDir = path.join(
      rootDir,
      "sandboxes",
      "task-acme-shop-12",
      "artifacts",
    );
    const logDir = path.join(rootDir, "sandboxes", "task-acme-shop-12", "logs");
    await mkdir(repoDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await mkdir(logDir, { recursive: true });
    await runCommand({ cwd: repoDir, command: "git init" });
    await runCommand({
      cwd: repoDir,
      command:
        "git config user.email test@example.com && git config user.name Test",
    });
    await writeFile(path.join(repoDir, "README.md"), "demo\n");
    await runCommand({
      cwd: repoDir,
      command:
        "git add README.md && git commit -m init && git checkout -b agent/issue-12",
    });
    const task = {
      ...createTask(issue),
      planningDocument: highComplexityPlanningDocument(),
      branchName: "agent/issue-12",
      prUrl: "https://github.com/acme/shop/pull/12",
      status: "HUMAN_REVIEW",
      sandbox: {
        repoDir,
        artifactDir,
        logDir,
        mode: "worktree" as const,
      },
    } satisfies Task;
    const tasks = new InMemoryTaskRepository(task);
    const runner = new IssueWorkflowRunner(
      createAppConfig(rootDir, [repositoryConfig()]),
      tasks,
    );
    const privateRunner = runner as unknown as {
      prepareExistingPrSandbox(
        task: Task,
        repositoryConfig: RepositoryConfig,
      ): Promise<{ repoDir: string; artifactDir: string; logDir: string }>;
    };

    const sandbox = await privateRunner.prepareExistingPrSandbox(
      task,
      repositoryConfig(),
    );

    expect(sandbox.repoDir).toBe(repoDir);
    expect(sandbox.artifactDir).toBe(artifactDir);
    expect(
      tasks.events.some((event) =>
        event.message.includes("Persistent PR sandbox reused"),
      ),
    ).toBe(true);
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
  baseBranch: "main",
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
    reasons: ["large change"],
  },
};

function highComplexityPlanningDocument(): PlanningDocument {
  return {
    ...highComplexityPrd,
    implementationPlan: minimalPlan(),
  };
}

function minimalPlan() {
  return {
    goal: "Update behavior",
    acceptanceCriteria: ["The behavior is updated"],
    filesToRead: ["src/change.ts"],
    filesExpectedToChange: ["src/change.ts"],
    testsToAddOrUpdate: ["src/change.test.ts"],
    commandsToRun: ["npm test"],
    explicitNonGoals: [],
    riskNotes: [],
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
      codeBlocks: [{ content: "large code block" }],
    },
    relevantFiles: [
      { path: "src/change.ts", reason: "plan", evidence: [], readMode: "full" },
      { path: "src/read.ts", reason: "plan", evidence: [], readMode: "full" },
    ],
    symbols: Array.from({ length: 50 }, (_, index) => `symbol-${index}`),
    tests: ["src/existing.test.ts"],
    similarChanges: [],
    nonRelevantAreas: [],
    openQuestions: [],
    tokenBudget: 1000,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function createAppConfig(
  rootDir: string,
  repositories: RepositoryConfig[] = [],
): AppConfig {
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
          supports_structured_output: true,
        },
        large: {
          type: "openai-compatible",
          base_url: "https://api.example.test",
          api_key_env: "TEST_API_KEY",
          model: "model-large",
          supports_tools: true,
          supports_structured_output: true,
        },
      },
      agents: {
        prd: {
          provider: "default",
          provider_by_complexity: {},
          system_prompt: "prompts/prd.md",
          skills: ["prd"],
        },
        implementation: {
          provider: "default",
          provider_by_complexity: { high: "large" },
          system_prompt: "prompts/impl.md",
          skills: ["implementation"],
        },
        review: {
          provider: "default",
          provider_by_complexity: {},
          system_prompt: "prompts/review.md",
          skills: ["review"],
        },
      },
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
        max_quality_gate_retries: 3,
      },
    },
    policies: [
      {
        id: "block-dangerous-shell",
        tool_names: [],
        permissions: [],
        match_paths: [],
        match_commands: ["rm -rf"],
        action: "block",
      },
    ],
    tools: [
      {
        name: "repo.read_file",
        description: "Read",
        permission: "read",
        policy_refs: [],
      },
    ],
    storage: {
      driver: "file",
      filePath: path.join(rootDir, "data", "tasks.json"),
    },
    memory: {
      filePath: path.join(rootDir, "data", "memory.json"),
    },
    github: {},
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
      actor_allowlist: [],
    },
    codebase_intelligence: {
      codegraph: {
        enabled: false,
        package: "@colbymchenry/codegraph@0.9.3",
        init_args: ["--index"],
        timeout_ms: 600_000,
        fail_on_error: true,
      },
      navigation_graph: {
        enabled: false,
        include_git_history: false,
        include_codeowners: false,
        max_depth: 1,
      },
    },
    queue: {
      max_concurrent_issues: 1,
    },
    permissions: {
      allowed_tools: [],
      blocked_tools: [],
      allowed_permissions: [],
      blocked_permissions: [],
    },
    quality_gates: {},
    frontend: {
      screenshot_urls: [],
    },
    pr: {
      default_draft: true,
    },
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

    this.task = {
      ...this.task,
      ...patch,
      id: this.task.id,
      createdAt: this.task.createdAt,
      updatedAt: new Date().toISOString(),
    };
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
