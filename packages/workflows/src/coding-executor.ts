import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  findRepository,
  type AppConfig,
  type ImplementationExecutorConfig,
} from "@agent/config";
import {
  buildOpenCodeProviderConfig,
  resolveCodingExecutorProvider,
  type AgentDefinition,
} from "@agent/model-runtime";
import {
  getGitDiff,
  runCommand,
  runSandboxCommand,
  type CommandOutputChunk,
  type CommandResult,
  type Sandbox,
} from "@agent/sandbox";
import type {
  JsonObject,
  PlanningDocument,
  QualityGateResult,
  Task,
  TaskEvent,
} from "@agent/shared";

export type NormalizedImplementationExecutorConfig =
  Required<ImplementationExecutorConfig>;

export type CodingExecutorPromptInput = {
  task: Task;
  planningDocument: PlanningDocument;
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
  sandbox?: Sandbox;
  repoDir: string;
  artifactDir: string;
  prompt: string;
  attempt: number;
  onProgress?: (event: CodingExecutorProgressEvent) => void | Promise<void>;
};

export type CodingExecutorProgressEvent = {
  message: string;
  level?: TaskEvent["level"];
  metadata?: JsonObject;
};

export type CodingExecutorRunResult = {
  commandResult: CommandResult;
  promptPath: string;
  openCodeConfigPath?: string;
  logPath: string;
  diff: string;
};

export function normalizeImplementationExecutorConfig(
  value: ImplementationExecutorConfig | undefined,
): NormalizedImplementationExecutorConfig {
  return {
    mode: value?.mode ?? "cli",
    name: value?.name ?? "codezero-coding-cli",
    command:
      value?.command ??
      'OPENCODE_BIN="${OPENCODE_BIN:-opencode}"; "$OPENCODE_BIN" run --agent build --model "$CODEZERO_OPENCODE_MODEL" --variant "${CODEZERO_OPENCODE_VARIANT:-minimal}" --format json --dangerously-skip-permissions "Implement the CodeZero request in the attached prompt file." --file="$CODEZERO_PROMPT_FILE"',
    timeout_ms: value?.timeout_ms ?? 60 * 60_000,
    env: value?.env ?? {},
  };
}

export function buildCodingExecutorEnv(input: {
  config: AppConfig;
  agent: AgentDefinition;
  executor: NormalizedImplementationExecutorConfig;
}): NodeJS.ProcessEnv {
  const providerId = input.agent.providerId;
  const provider = input.config.agents.providers[providerId];
  const providerApiKey = provider
    ? process.env[provider.api_key_env]
    : undefined;
  const codingProvider = provider
    ? resolveCodingExecutorProvider(providerId, provider)
    : undefined;
  const providerEnv = provider
    ? {
        ...buildNativeProviderExecutorEnv(provider, providerApiKey),
        [provider.api_key_env]: providerApiKey,
        OPENAI_API_KEY: providerApiKey,
        OPENAI_BASE_URL: provider.base_url,
        OPENAI_MODEL: provider.model,
        LLM_API_KEY: providerApiKey,
        LLM_BASE_URL: provider.base_url,
        LLM_MODEL: provider.model,
        CODEZERO_OPENCODE_PROVIDER: codingProvider?.providerId,
        CODEZERO_OPENCODE_MODEL: codingProvider?.modelRef,
        CODEZERO_OPENCODE_MODE: codingProvider?.mode,
        CODEZERO_MODEL_PROVIDER: providerId,
        CODEZERO_MODEL: provider.model,
      }
    : {};

  return {
    ...providerEnv,
    ...(codingProvider?.env ?? {}),
    ...input.executor.env,
  };
}

type AgentProviderRuntimeConfig = AppConfig["agents"]["providers"][string];

function buildNativeProviderExecutorEnv(
  provider: AgentProviderRuntimeConfig,
  apiKey: string | undefined,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    nativeProviderApiKeyEnvNames(provider.type).map((key) => [key, apiKey]),
  );
}

function nativeProviderApiKeyEnvNames(
  providerType: AgentProviderRuntimeConfig["type"],
): string[] {
  switch (providerType) {
    case "anthropic":
      return ["ANTHROPIC_API_KEY"];
    case "google":
      return ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"];
    case "xai":
      return ["XAI_API_KEY"];
    case "mistral":
      return ["MISTRAL_API_KEY"];
    case "groq":
      return ["GROQ_API_KEY"];
    case "openai-compatible":
      return [];
  }
}

export function buildCodingExecutorPrompt(
  input: CodingExecutorPromptInput,
): string {
  return [
    "# CodeZero Implementation Request",
    "",
    "You are the OpenCode implementation executor running inside an isolated Git worktree.",
    "Modify the repository files directly. Do not commit, push, create pull requests, or change branches.",
    "CodeZero will run the final quality gates, review the diff, record screenshot artifacts, and create or update the GitHub PR.",
    "Keep the diff focused on the approved PRD/Plan document and latest feedback. Do not include unrelated refactors.",
    "",
    "## Issue",
    `- Repository: ${input.task.issue.owner}/${input.task.issue.repo}`,
    `- Issue: #${input.task.issue.number} ${input.task.issue.title}`,
    `- URL: ${input.task.issue.url}`,
    "",
    input.task.issue.body.trim() || "(No issue body provided.)",
    "",
    "## Approved PRD/Plan Document",
    JSON.stringify(input.planningDocument, null, 2),
    "",
    "## Acceptance Criteria",
    formatList(input.planningDocument.acceptanceCriteria),
    "",
    "## Implementation Plan",
    JSON.stringify(input.planningDocument.implementationPlan, null, 2),
    "",
    "## Repository Rules And Skills",
    formatRepositoryRulesAndSkills(input.implementationContext),
    "",
    "## Repository Context",
    JSON.stringify(input.implementationContext, null, 2),
    "",
    "## CodeGraph Guidance",
    "When CodeGraph MCP tools are available, use them for code discovery before broad filesystem search. They read the sandbox's prebuilt `.codegraph` index and stay current while you edit.",
    formatCodeGraphContext(input.implementationContext),
    "",
    "## Current File Snippets",
    JSON.stringify(input.fileSnippets, null, 2),
    "",
    input.reviewerFeedback?.trim()
      ? [
          "## Latest Feedback Or Self-Check Repair Context",
          input.reviewerFeedback.trim(),
          "",
        ].join("\n")
      : "",
    input.qualityGateResults?.length
      ? [
          "## Latest Quality Gate Results",
          JSON.stringify(input.qualityGateResults, null, 2),
          "",
        ].join("\n")
      : "",
    "## Completion Contract",
    "- Leave the working tree with the required code changes.",
    "- Add or update tests when the PRD or failure output requires it.",
    "- You may run targeted local commands if helpful, but CodeZero will run the authoritative self-checks after you finish.",
    "- Do not commit, push, create pull requests, approve PRDs, or change workflow status.",
    "- Stop after the implementation is complete; do not ask the user for follow-up unless the repository is genuinely blocked.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatList(items: string[]): string {
  return items.length > 0
    ? items.map((item) => `- ${item}`).join("\n")
    : "- No explicit acceptance criteria were provided.";
}

function formatRepositoryRulesAndSkills(context: JsonObject): string {
  const businessRules = Array.isArray(context.businessRules)
    ? context.businessRules.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  if (businessRules.length === 0) {
    return "No repository-specific rules or skills were found.";
  }

  return businessRules.join("\n\n");
}

function formatCodeGraphContext(context: JsonObject): string {
  const codeGraphContext = context.codeGraphContext;

  if (!isJsonObject(codeGraphContext)) {
    return "No compact CodeGraph context is available in the prompt. Prefer the CodeGraph MCP when it is configured.";
  }

  return [
    "",
    "Compact CodeGraph context:",
    JSON.stringify(codeGraphContext, null, 2),
  ].join("\n");
}

export async function runCodingCliExecutor(
  input: CodingExecutorRunInput,
): Promise<CodingExecutorRunResult> {
  const executorDir = path.join(input.artifactDir, "coding-executor");
  await mkdir(executorDir, { recursive: true });
  const promptPath = path.join(
    executorDir,
    `prompt-attempt-${input.attempt}.md`,
  );
  const openCodeConfigPath = path.join(
    executorDir,
    `opencode-attempt-${input.attempt}.json`,
  );
  const logPath = path.join(executorDir, `run-attempt-${input.attempt}.json`);
  const openCodeHome = path.join(executorDir, `home-attempt-${input.attempt}`);
  const openCodeDataHome = path.join(openCodeHome, ".local", "share");
  const openCodeConfigHome = path.join(openCodeHome, ".config");
  await mkdir(openCodeDataHome, { recursive: true });
  await mkdir(openCodeConfigHome, { recursive: true });
  await writeFile(promptPath, input.prompt, "utf8");
  const openCodeConfig = buildOpenCodeExecutorConfig({
    config: input.config,
    agent: input.agent,
    task: input.task,
    repoDir: input.repoDir,
  });

  if (openCodeConfig) {
    await writeFile(
      openCodeConfigPath,
      `${JSON.stringify(openCodeConfig, null, 2)}\n`,
      "utf8",
    );
  }
  await resetOpenCodeProjectMarker(input.repoDir);

  const progressReporter = createCodingExecutorProgressReporter(
    input.onProgress,
  );
  const executorEnv = {
      ...buildCodingExecutorEnv({
        config: input.config,
        agent: input.agent,
        executor: input.executor,
      }),
      CODEZERO_PROMPT_FILE: sandboxPath(input.sandbox, promptPath),
      CODEZERO_TASK_ID: input.task.id,
      CODEZERO_REPO_DIR: sandboxPath(input.sandbox, input.repoDir),
      CODEZERO_ARTIFACT_DIR: sandboxPath(input.sandbox, input.artifactDir),
      CODEZERO_ISSUE_URL: input.task.issue.url,
      CODEZERO_EXECUTOR_NAME: input.executor.name,
      HOME: sandboxPath(input.sandbox, openCodeHome),
      XDG_DATA_HOME: sandboxPath(input.sandbox, openCodeDataHome),
      XDG_CONFIG_HOME: sandboxPath(input.sandbox, openCodeConfigHome),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      ...(openCodeConfig
        ? {
            OPENCODE_CONFIG: sandboxPath(input.sandbox, openCodeConfigPath),
            CODEZERO_OPENCODE_CONFIG_FILE: sandboxPath(
              input.sandbox,
              openCodeConfigPath,
            ),
          }
        : {}),
  };
  const commandResult = input.sandbox
    ? await runSandboxCommand({
        sandbox: input.sandbox,
        command: input.executor.command,
        timeoutMs: input.executor.timeout_ms,
        env: executorEnv,
        onOutput: (chunk) => progressReporter.accept(chunk),
      })
    : await runCommand({
        cwd: input.repoDir,
        command: input.executor.command,
        timeoutMs: input.executor.timeout_ms,
        env: executorEnv,
        onOutput: (chunk) => progressReporter.accept(chunk),
      });
  await progressReporter.flush();
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
        diffSummary: summarizeDiffForLog(diff),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    commandResult,
    promptPath,
    openCodeConfigPath: openCodeConfig ? openCodeConfigPath : undefined,
    logPath,
    diff,
  };
}

function sandboxPath(sandbox: Sandbox | undefined, filePath: string): string {
  if (!sandbox || sandbox.mode !== "docker") {
    return filePath;
  }

  if (filePath === sandbox.repoDir || filePath.startsWith(`${sandbox.repoDir}${path.sep}`)) {
    return path.posix.join(
      "/workspace/repo",
      path.relative(sandbox.repoDir, filePath).split(path.sep).join("/"),
    );
  }

  if (filePath === sandbox.artifactDir || filePath.startsWith(`${sandbox.artifactDir}${path.sep}`)) {
    return path.posix.join(
      "/workspace/artifacts",
      path.relative(sandbox.artifactDir, filePath).split(path.sep).join("/"),
    );
  }

  if (filePath === sandbox.logDir || filePath.startsWith(`${sandbox.logDir}${path.sep}`)) {
    return path.posix.join(
      "/workspace/logs",
      path.relative(sandbox.logDir, filePath).split(path.sep).join("/"),
    );
  }

  return filePath;
}

async function resetOpenCodeProjectMarker(repoDir: string): Promise<void> {
  await rm(path.join(repoDir, ".git", "opencode"), { force: true }).catch(
    () => undefined,
  );
}

function createCodingExecutorProgressReporter(
  onProgress: CodingExecutorRunInput["onProgress"],
) {
  const buffers: Record<CommandOutputChunk["stream"], string> = {
    stdout: "",
    stderr: "",
  };
  const pending: Promise<void>[] = [];
  const recentMessages = new Map<string, number>();

  const emit = (event: CodingExecutorProgressEvent) => {
    if (!onProgress) {
      return;
    }

    const now = Date.now();
    const key = `${event.level ?? "info"}:${event.message}`;
    const previous = recentMessages.get(key);
    if (previous && now - previous < 2_500) {
      return;
    }
    recentMessages.set(key, now);
    pending.push(Promise.resolve(onProgress(event)).catch(() => undefined));
  };

  const consumeLine = (stream: CommandOutputChunk["stream"], line: string) => {
    const event = normalizeCodingExecutorProgressLine(line, stream);
    if (event) {
      emit(event);
    }
  };

  return {
    accept(chunk: CommandOutputChunk) {
      buffers[chunk.stream] += chunk.text;
      const lines = buffers[chunk.stream].split(/\r?\n/);
      buffers[chunk.stream] = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(chunk.stream, line);
      }
    },
    async flush() {
      for (const stream of ["stdout", "stderr"] as const) {
        if (buffers[stream].trim()) {
          consumeLine(stream, buffers[stream]);
        }
        buffers[stream] = "";
      }
      await Promise.all(pending);
    },
  };
}

function buildOpenCodeExecutorConfig(input: {
  config: AppConfig;
  agent: AgentDefinition;
  task: Task;
  repoDir: string;
}): JsonObject | undefined {
  return addCodeGraphMcpConfig(
    buildOpenCodeProviderConfig(input.config, input.agent),
    input,
  );
}

function addCodeGraphMcpConfig(
  config: JsonObject | undefined,
  input: {
    config: AppConfig;
    task: Task;
    repoDir: string;
  },
): JsonObject | undefined {
  const repository = findRepository(
    input.config,
    input.task.issue.owner,
    input.task.issue.repo,
  );
  const codeGraph = repository?.codebase_intelligence.codegraph;

  if (!codeGraph?.enabled) {
    return config;
  }

  const base = config ?? {};
  const existingMcp = isJsonObject(base.mcp) ? base.mcp : {};

  return {
    ...base,
    mcp: {
      ...existingMcp,
      codegraph: {
        type: "local",
        command: [
          "npx",
          "-y",
          codeGraph.package,
          "serve",
          "--mcp",
          "--path",
          input.repoDir,
        ],
        environment: {
          CODEGRAPH_FORCE_WATCH: "1",
        },
        enabled: true,
        timeout: Math.min(codeGraph.timeout_ms, 30_000),
      },
    },
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeCodingExecutorProgressLine(
  line: string,
  stream: CommandOutputChunk["stream"] = "stdout",
): CodingExecutorProgressEvent | undefined {
  const clean = stripAnsi(line).trim();
  if (!clean || isIgnorableExecutorLine(clean)) {
    return undefined;
  }

  if (stream === "stderr") {
    return {
      message: `OpenCode stderr: ${truncateProgressText(clean, 600)}`,
      level: /error|failed|fatal|exception/i.test(clean) ? "error" : "warn",
      metadata: {
        source: "opencode",
        stream,
      },
    };
  }

  const parsed = parseJsonLine(clean);
  if (!isRecord(parsed)) {
    return {
      message: `OpenCode output: ${truncateProgressText(clean, 600)}`,
      level: "info",
      metadata: {
        source: "opencode",
        stream,
      },
    };
  }

  const eventType = findStringValue(parsed, ["type", "event", "kind", "name"]);
  const lowerEventType = eventType.toLowerCase();
  if (/thinking|reasoning|chain/i.test(eventType)) {
    return {
      message: "OpenCode is planning the next implementation step",
      level: "debug",
      metadata: {
        source: "opencode",
        stream,
        eventType,
      },
    };
  }

  const filePath = findStringValue(parsed, [
    "path",
    "file",
    "filePath",
    "filename",
  ]);
  const command = findStringValue(parsed, ["command", "cmd"]);
  const toolName = findStringValue(parsed, ["tool", "toolName", "tool_name"]);
  const text = findStringValue(parsed, [
    "message",
    "text",
    "content",
    "delta",
    "summary",
    "title",
    "output",
  ]);
  const metadata = compactProgressMetadata({
    source: "opencode",
    stream,
    eventType,
    filePath,
    command,
    toolName,
  });

  if (filePath && /file|edit|patch|write|diff/.test(lowerEventType)) {
    return {
      message: `OpenCode file activity: ${filePath}`,
      level: "info",
      metadata,
    };
  }

  if (command) {
    return {
      message: `OpenCode command: ${truncateProgressText(command, 300)}`,
      level: "info",
      metadata,
    };
  }

  if (toolName) {
    return {
      message: `OpenCode tool: ${toolName}${filePath ? ` ${filePath}` : ""}`,
      level: "info",
      metadata,
    };
  }

  if (text) {
    return {
      message: `OpenCode: ${truncateProgressText(text, 600)}`,
      level: "info",
      metadata,
    };
  }

  if (eventType) {
    return {
      message: `OpenCode event: ${eventType}`,
      level: "debug",
      metadata,
    };
  }

  return undefined;
}

function parseJsonLine(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stripAnsi(value: string): string {
  return value.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
    "",
  );
}

function isIgnorableExecutorLine(value: string): boolean {
  return /^npm warn Unknown env config/.test(value);
}

function findStringValue(value: unknown, keys: string[], depth = 0): string {
  if (depth > 4 || !isRecord(value)) {
    return "";
  }

  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }
  }

  for (const entry of Object.values(value)) {
    if (isRecord(entry)) {
      const nested = findStringValue(entry, keys, depth + 1);
      if (nested) {
        return nested;
      }
    }
    if (Array.isArray(entry)) {
      for (const item of entry) {
        const nested = findStringValue(item, keys, depth + 1);
        if (nested) {
          return nested;
        }
      }
    }
  }

  return "";
}

function compactProgressMetadata(input: Record<string, string>): JsonObject {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value.length > 0),
  );
}

function truncateProgressText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}...`
    : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeDiffForLog(diff: string): string {
  return diff
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("diff --git ") ||
        line.startsWith("+++") ||
        line.startsWith("---"),
    )
    .slice(0, 80)
    .join("\n");
}
