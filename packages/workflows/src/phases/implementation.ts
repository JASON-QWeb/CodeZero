import os from "node:os";
import path from "node:path";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { runJsonAgent, type AgentDefinition } from "@agent/model-runtime";
import { readContextFileSnippets } from "@agent/codebase-intelligence";
import { allQualityGatesPassed, reviewAllowsPr } from "@agent/orchestrator";
import {
  enforceDiffLimits,
  getGitDiff,
  listChangedFiles,
  runCommand,
  type Sandbox,
} from "@agent/sandbox";
import type {
  ContextPack,
  JsonObject,
  JsonValue,
  PlanningDocument,
  QualityGateResult,
  ReviewResult,
  Task,
} from "@agent/shared";
import { shellQuote } from "@agent/shared";
import {
  createQualityGateCommands,
  runFrontendScreenshotGate,
  runQualityGates as runVerificationQualityGates,
} from "@agent/verification";
import { createArtifactId } from "../artifacts.js";
import {
  buildCodingExecutorPrompt,
  normalizeImplementationExecutorConfig,
  runCodingCliExecutor,
  type NormalizedImplementationExecutorConfig,
} from "../coding-executor.js";
import {
  detectIssueLocale,
  languageInstruction,
} from "../pr-local-verification.js";
import { reviewSchema } from "../schemas.js";
import { collectScreenshotArtifactsForPr } from "./github-utils.js";
import type {
  ImplementationHost,
  ImplementationReviewInput,
  ImplementationSelfCheckInput,
  ImplementationSelfCheckResult,
  QualityGateRunnerInput,
  QualityGateRunnerResult,
  ReviewRunnerResult,
} from "./types.js";

export async function applyImplementation(
  host: ImplementationHost,
  task: Task,
  sandbox: Sandbox,
  agent: AgentDefinition,
  reviewerFeedback = "",
): Promise<void> {
  const executor = normalizeImplementationExecutorConfig(
    host.config.sandbox.implementation_executor,
  );

  try {
    await applyImplementationWithCodingExecutor(
      host,
      task,
      sandbox,
      agent,
      executor,
      reviewerFeedback,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await host.event(
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

export async function applyImplementationWithCodingExecutor(
  host: ImplementationHost,
  task: Task,
  sandbox: Sandbox,
  agent: AgentDefinition,
  executor: NormalizedImplementationExecutorConfig,
  reviewerFeedback = "",
): Promise<void> {
  const contextPack = task.contextPack ?? missing<ContextPack>("ContextPack");
  const planningDocument =
    task.planningDocument ?? missing<PlanningDocument>("PlanningDocument");
  const feedbackSnippetPaths = await extractImplementationFeedbackPaths(
    sandbox.repoDir,
    reviewerFeedback,
  );
  const snippets = await readContextFileSnippets(sandbox.repoDir, contextPack, {
    includePaths: uniquePaths([
      ...feedbackSnippetPaths,
      ...selectImplementationSnippetPaths(task),
    ]),
    maxCharsPerFile: 16_000,
    maxFiles: 12,
  });
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
    await host.event(
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
        config: host.config,
        executor,
        agent,
        task,
        sandbox,
        repoDir: sandbox.repoDir,
        artifactDir: sandbox.artifactDir,
        prompt,
        attempt: Date.now(),
        onProgress: async (progress) => {
          await host.event(
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

    await enforceDiffLimits(sandbox.repoDir, {
      maxFiles: host.config.sandbox.limits.max_diff_files,
      maxLines: host.config.sandbox.limits.max_diff_lines,
    });
    await host.writeArtifact(
      task.id,
      "tool-call",
      path.basename(result.logPath),
      await readFile(result.logPath, "utf8"),
    );
    await host.writeArtifact(
      task.id,
      "diff",
      "implementation.diff",
      result.diff,
    );
    const changedFiles = await listChangedFiles(sandbox.repoDir);
    await host.event(
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
    await host.event(
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

export async function runImplementationSelfCheckLoop(
  host: ImplementationHost,
  input: ImplementationSelfCheckInput,
): Promise<ImplementationSelfCheckResult> {
  let updated = input.task;
  let implementationFeedback = input.initialFeedback ?? "";
  const configuredMaxAttempts = Math.max(
    1,
    (host.config.sandbox.limits.max_quality_gate_retries ?? 0) + 1,
  );
  const hardMaxAttempts = getSelfCheckHardMaxAttempts(configuredMaxAttempts);
  let maxAttempts = configuredMaxAttempts;
  let previousQualityGateResults: QualityGateResult[] | undefined;
  let previousReviewResult: ReviewResult | undefined;
  let previousSelfCheckFailureKind: "quality" | "review" | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (updated.status !== "IMPLEMENTING") {
      updated = await host.updateStatus(updated.id, "IMPLEMENTING");
    }

    await applyImplementation(
      host,
      updated,
      input.sandbox,
      input.implementationAgent,
      implementationFeedback,
    );
    await host.syncCodeGraphAfterImplementation(
      updated,
      input.sandbox,
      input.repositoryConfig,
    );

    const qualityGateResults = await runQualityGates(host, {
      task: updated,
      sandbox: input.sandbox,
      repositoryConfig: input.repositoryConfig,
    });
    updated = await host.updateStatus(updated.id, "QUALITY_GATES_RUNNING", {
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
      await host.event(
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

    const reviewResult = await review(host, {
      task: updated,
      sandbox: input.sandbox,
      runner: input.runner,
      agent: input.reviewAgent,
      reviewerFeedback: input.initialFeedback,
    });
    updated = await host.updateStatus(updated.id, "SUBAGENT_REVIEWING", {
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
    await host.event(
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

export async function runQualityGates(
  host: ImplementationHost,
  input: QualityGateRunnerInput,
): Promise<QualityGateRunnerResult> {
  const gates = createQualityGateCommands({
    setup: input.repositoryConfig.quality_gates.setup,
    build: input.repositoryConfig.quality_gates.build,
    lint: input.repositoryConfig.quality_gates.lint,
    typecheck: input.repositoryConfig.quality_gates.typecheck,
    unitTest: input.repositoryConfig.quality_gates.unit_test,
  });
  await host.event(
    input.task.id,
    "QUALITY_GATE_STARTED",
    `Running ${gates.length} quality gates`,
  );
  const results = await runVerificationQualityGates(
    input.sandbox.repoDir,
    gates,
  );
  const taskType = input.task.planningDocument?.taskType;
  if (
    (taskType === "frontend" || taskType === "fullstack") &&
    input.repositoryConfig.frontend.dev_command &&
    input.repositoryConfig.frontend.screenshot_urls.length > 0
  ) {
    const screenshotResult = await runFrontendScreenshotGate({
      cwd: input.sandbox.repoDir,
      devCommand: input.repositoryConfig.frontend.dev_command,
      targets: input.repositoryConfig.frontend.screenshot_urls.map((url) => ({
        url,
      })),
      artifactDir: path.join(input.sandbox.artifactDir, "screenshots"),
      chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH,
    });
    results.push(screenshotResult.gate);
    for (const screenshot of screenshotResult.screenshots) {
      await host.tasks.addArtifact({
        id: createArtifactId(),
        taskId: input.task.id,
        type: "screenshot",
        path: screenshot.path,
        metadata: { url: screenshot.url, viewport: screenshot.viewport },
        createdAt: new Date().toISOString(),
      });
    }
  }
  await host.writeArtifact(
    input.task.id,
    "test-report",
    "quality-gates.json",
    JSON.stringify(results, null, 2),
  );
  await host.event(
    input.task.id,
    "QUALITY_GATE_FINISHED",
    `${results.filter((result) => result.passed).length}/${results.length} quality gates passed`,
  );
  return results;
}

export async function review(
  host: ImplementationHost,
  input: ImplementationReviewInput,
): Promise<ReviewRunnerResult> {
  const diff = await getGitDiff(input.sandbox.repoDir);
  const changedFiles = await listChangedFiles(input.sandbox.repoDir);
  const planningDocument =
    input.task.planningDocument ??
    missing<PlanningDocument>("PlanningDocument");
  const artifacts = await host.tasks.listArtifacts(input.task.id);
  const screenshotArtifacts = collectScreenshotArtifactsForPr(artifacts);
  const fileSnippets = input.task.contextPack
    ? await readContextFileSnippets(
        input.sandbox.repoDir,
        input.task.contextPack,
        {
          includePaths: uniquePaths([
            ...changedFiles,
            ...selectImplementationSnippetPaths(input.task),
          ]),
          maxCharsPerFile: 16_000,
          maxFiles: 12,
        },
      )
    : {};
  const locale = detectIssueLocale(input.task.issue);
  const result = await runJsonAgent({
    runner: input.runner,
    agent: input.agent,
    userPrompt: [
      "Review the draft changes. Return only JSON with approved, findings, missingTests, scopeViolations, riskLevel, and prDescriptionNotes.",
      "Screenshot artifacts captured by CodeZero's frontend_screenshot quality gate are valid visual evidence; do not block only because screenshots are not manually attached when screenshotArtifacts is non-empty.",
      "Use fileSnippets to verify whether referenced CSS classes, design tokens, or helper APIs already exist before reporting them as newly introduced or unknown.",
      input.reviewerFeedback
        ? `This is a PR feedback iteration. Confirm the diff addresses this latest reviewer feedback:\n${input.reviewerFeedback}`
        : "",
      languageInstruction(locale),
    ]
      .filter(Boolean)
      .join("\n"),
    context: {
      issue: input.task.issue as unknown as JsonObject,
      planningDocument: planningDocument as unknown as JsonObject,
      contextPack: input.task.contextPack as unknown as JsonObject,
      qualityGateResults: (input.task.qualityGateResults ??
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
      reviewerFeedback: input.reviewerFeedback ?? "",
      changedFiles,
      diff,
    },
  });
  const reviewResult = reviewSchema.parse(result);
  await host.writeArtifact(
    input.task.id,
    "review",
    "review.json",
    JSON.stringify(reviewResult, null, 2),
  );
  await host.event(
    input.task.id,
    "SUBAGENT_REVIEW_FINISHED",
    `Review approved=${reviewResult.approved}`,
  );
  return reviewResult;
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

function missing<T>(name: string): T {
  throw new Error(`${name} is required`);
}
