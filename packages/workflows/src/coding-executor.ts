import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDefinition } from "@agent/agent-runtime";
import type { AppConfig, ImplementationExecutorConfig } from "@agent/config";
import { getGitDiff, runCommand, type CommandResult } from "@agent/sandbox";
import type { JsonObject, MinimalChangePlan, PrdDocument, QualityGateResult, Task } from "@agent/shared";

export type NormalizedImplementationExecutorConfig = Required<ImplementationExecutorConfig>;

export type CodingExecutorPromptInput = {
  task: Task;
  prd: PrdDocument;
  minimalChangePlan: MinimalChangePlan;
  implementationContext: JsonObject;
  fileSnippets: JsonObject;
  reviewerFeedback?: string;
  qualityGateResults?: QualityGateResult[];
};

export type CodingExecutorRunInput = {
  config: AppConfig;
  executor: NormalizedImplementationExecutorConfig;
  agent: AgentDefinition;
  task: Task;
  repoDir: string;
  artifactDir: string;
  prompt: string;
  attempt: number;
};

export type CodingExecutorRunResult = {
  commandResult: CommandResult;
  promptPath: string;
  openCodeConfigPath?: string;
  logPath: string;
  diff: string;
};

export function normalizeImplementationExecutorConfig(
  value: ImplementationExecutorConfig | undefined
): NormalizedImplementationExecutorConfig {
  return {
    mode: value?.mode ?? "cli",
    name: value?.name ?? "codezero-coding-cli",
    command:
      value?.command ??
      'npx -y opencode-ai@latest run --agent build --model "$CODEZERO_OPENCODE_MODEL" --format json --dangerously-skip-permissions --file "$CODEZERO_PROMPT_FILE" "Implement the CodeZero request in the attached prompt file."',
    timeout_ms: value?.timeout_ms ?? 60 * 60_000,
    fallback_to_legacy_json_actions: value?.fallback_to_legacy_json_actions ?? true,
    env: value?.env ?? {}
  };
}

export function buildCodingExecutorEnv(input: { config: AppConfig; agent: AgentDefinition; executor: NormalizedImplementationExecutorConfig }): NodeJS.ProcessEnv {
  const provider = input.config.agents.providers[input.agent.providerId];
  const providerApiKey = provider ? process.env[provider.api_key_env] : undefined;
  const providerEnv = provider
    ? {
        OPENAI_API_KEY: providerApiKey,
        OPENAI_BASE_URL: provider.base_url,
        OPENAI_MODEL: provider.model,
        LLM_API_KEY: providerApiKey,
        LLM_BASE_URL: provider.base_url,
        LLM_MODEL: provider.model,
        CODEZERO_OPENCODE_PROVIDER: "codezero",
        CODEZERO_OPENCODE_MODEL: toCodeZeroOpenCodeModel(provider.model),
        CODEZERO_MODEL_PROVIDER: input.agent.providerId,
        CODEZERO_MODEL: provider.model
      }
    : {};

  return {
    ...providerEnv,
    ...input.executor.env
  };
}

export function buildCodingExecutorPrompt(input: CodingExecutorPromptInput): string {
  return [
    "# CodeZero Implementation Request",
    "",
    "You are CodeZero's internal implementation executor running inside an isolated Git worktree.",
    "Modify the repository files directly. Do not commit, push, create pull requests, or change branches.",
    "CodeZero will run the final quality gates, review the diff, publish screenshots, and create or update the GitHub PR.",
    "Keep the diff focused on the approved PRD and latest feedback. Do not include unrelated refactors.",
    "",
    "## Issue",
    `- Repository: ${input.task.issue.owner}/${input.task.issue.repo}`,
    `- Issue: #${input.task.issue.number} ${input.task.issue.title}`,
    `- URL: ${input.task.issue.url}`,
    "",
    input.task.issue.body.trim() || "(No issue body provided.)",
    "",
    "## Approved PRD",
    JSON.stringify(input.prd, null, 2),
    "",
    "## Implementation Plan",
    JSON.stringify(input.minimalChangePlan, null, 2),
    "",
    "## Repository Context",
    JSON.stringify(input.implementationContext, null, 2),
    "",
    "## Current File Snippets",
    JSON.stringify(input.fileSnippets, null, 2),
    "",
    input.reviewerFeedback?.trim()
      ? ["## Latest Feedback Or Self-Check Repair Context", input.reviewerFeedback.trim(), ""].join("\n")
      : "",
    input.qualityGateResults?.length
      ? ["## Latest Quality Gate Results", JSON.stringify(input.qualityGateResults, null, 2), ""].join("\n")
      : "",
    "## Completion Contract",
    "- Leave the working tree with the required code changes.",
    "- Add or update tests when the PRD or failure output requires it.",
    "- You may run targeted local commands if helpful, but CodeZero will run the authoritative self-checks after you finish.",
    "- Stop after the implementation is complete; do not ask the user for follow-up unless the repository is genuinely blocked."
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runCodingCliExecutor(input: CodingExecutorRunInput): Promise<CodingExecutorRunResult> {
  const executorDir = path.join(input.artifactDir, "coding-executor");
  await mkdir(executorDir, { recursive: true });
  const promptPath = path.join(executorDir, `prompt-attempt-${input.attempt}.md`);
  const openCodeConfigPath = path.join(executorDir, `opencode-attempt-${input.attempt}.json`);
  const logPath = path.join(executorDir, `run-attempt-${input.attempt}.json`);
  await writeFile(promptPath, input.prompt, "utf8");
  const openCodeConfig = buildOpenCodeProviderConfig(input.config, input.agent);

  if (openCodeConfig) {
    await writeFile(openCodeConfigPath, `${JSON.stringify(openCodeConfig, null, 2)}\n`, "utf8");
  }

  const commandResult = await runCommand({
    cwd: input.repoDir,
    command: input.executor.command,
    timeoutMs: input.executor.timeout_ms,
    env: {
      ...buildCodingExecutorEnv({ config: input.config, agent: input.agent, executor: input.executor }),
      CODEZERO_PROMPT_FILE: promptPath,
      CODEZERO_TASK_ID: input.task.id,
      CODEZERO_REPO_DIR: input.repoDir,
      CODEZERO_ARTIFACT_DIR: input.artifactDir,
      CODEZERO_ISSUE_URL: input.task.issue.url,
      CODEZERO_EXECUTOR_NAME: input.executor.name,
      ...(openCodeConfig ? { OPENCODE_CONFIG: openCodeConfigPath, CODEZERO_OPENCODE_CONFIG_FILE: openCodeConfigPath } : {})
    }
  });
  const diff = await getGitDiff(input.repoDir);

  await writeFile(
    logPath,
    `${JSON.stringify(
      {
        executor: input.executor.name,
        mode: input.executor.mode,
        openCodeConfigPath: openCodeConfig ? openCodeConfigPath : undefined,
        exitCode: commandResult.exitCode,
        durationMs: commandResult.durationMs,
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
        diffSummary: summarizeDiffForLog(diff)
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    commandResult,
    promptPath,
    openCodeConfigPath: openCodeConfig ? openCodeConfigPath : undefined,
    logPath,
    diff
  };
}

function buildOpenCodeProviderConfig(config: AppConfig, agent: AgentDefinition): JsonObject | undefined {
  const provider = config.agents.providers[agent.providerId];

  if (!provider) {
    return undefined;
  }

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      codezero: {
        npm: "@ai-sdk/openai-compatible",
        name: "CodeZero Runtime Provider",
        options: {
          baseURL: provider.base_url,
          apiKey: "{env:OPENAI_API_KEY}"
        },
        models: {
          [provider.model]: {
            name: provider.model
          }
        }
      }
    },
    model: toCodeZeroOpenCodeModel(provider.model)
  };
}

function summarizeDiffForLog(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("diff --git ") || line.startsWith("+++") || line.startsWith("---"))
    .slice(0, 80)
    .join("\n");
}

function toCodeZeroOpenCodeModel(model: string): string {
  return `codezero/${model}`;
}
