import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, JsonValue } from "@agent/shared";

export const toolPermissions = ["read", "safe_write", "repo_write", "external_write", "dangerous"] as const;

export type ToolPermission = (typeof toolPermissions)[number];
export type PolicyAction = "allow" | "audit" | "require_approval" | "block";
export type ToolCallStatus = "success" | "failed" | "blocked" | "approval_required";

export type ToolDefinition = {
  name: string;
  description: string;
  permission: ToolPermission;
  timeoutMs?: number;
  policyRefs?: string[];
};

export type PolicyDefinition = {
  id: string;
  description?: string;
  toolNames?: string[];
  permissions?: ToolPermission[];
  matchPaths?: string[];
  matchCommands?: string[];
  action: PolicyAction;
};

export type ToolCallRequest = {
  id?: string;
  taskId?: string;
  toolName: string;
  input: JsonObject;
};

export type JsonToolAction = {
  id?: string;
  toolName: string;
  input: JsonObject;
};

export type JsonActionPlan = {
  actions: JsonToolAction[];
};

export type PolicyDecision = {
  policyId: string;
  action: PolicyAction;
  matched: boolean;
  reasons: string[];
};

export type ToolCallResult = {
  id: string;
  taskId?: string;
  toolName: string;
  status: ToolCallStatus;
  output?: JsonValue;
  error?: string;
  durationMs: number;
  policyDecisions: PolicyDecision[];
};

export type ToolExecutionContext = {
  taskId?: string;
  repoDir: string;
  env?: Record<string, string | undefined>;
};

export type ToolHandler = (input: JsonObject, context: ToolExecutionContext) => JsonValue | Promise<JsonValue>;

type RegisteredTool = {
  definition: ToolDefinition;
  handler: ToolHandler;
};

type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }

    this.tools.set(definition.name, { definition, handler });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }
}

export class ToolGateway {
  constructor(
    private readonly input: {
      registry: ToolRegistry;
      policies?: PolicyDefinition[];
    }
  ) {}

  async execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolCallResult> {
    const startedAt = Date.now();
    const id = request.id ?? `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const registered = this.input.registry.get(request.toolName);

    if (!registered) {
      return {
        id,
        taskId: request.taskId,
        toolName: request.toolName,
        status: "failed",
        error: `Unknown tool: ${request.toolName}`,
        durationMs: Date.now() - startedAt,
        policyDecisions: []
      };
    }

    const policyDecisions = evaluateToolPolicies({
      tool: registered.definition,
      request,
      policies: this.input.policies ?? []
    });
    const blockingDecision = policyDecisions.find((decision) => decision.action === "block");

    if (blockingDecision) {
      return {
        id,
        taskId: request.taskId,
        toolName: request.toolName,
        status: "blocked",
        error: blockingDecision.reasons.join("; "),
        durationMs: Date.now() - startedAt,
        policyDecisions
      };
    }

    const approvalDecision = policyDecisions.find((decision) => decision.action === "require_approval");

    if (approvalDecision) {
      return {
        id,
        taskId: request.taskId,
        toolName: request.toolName,
        status: "approval_required",
        error: approvalDecision.reasons.join("; "),
        durationMs: Date.now() - startedAt,
        policyDecisions
      };
    }

    try {
      const output = await withTimeout(
        Promise.resolve(registered.handler(request.input, { ...context, taskId: request.taskId ?? context.taskId })),
        registered.definition.timeoutMs ?? 30_000,
        registered.definition.name
      );

      return {
        id,
        taskId: request.taskId,
        toolName: request.toolName,
        status: "success",
        output: asJsonValue(output),
        durationMs: Date.now() - startedAt,
        policyDecisions
      };
    } catch (error) {
      return {
        id,
        taskId: request.taskId,
        toolName: request.toolName,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        policyDecisions
      };
    }
  }
}

export function parseJsonActionPlan(content: string): JsonActionPlan {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  const parsed = JSON.parse(candidate) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("JSON action response must be an object");
  }

  if (Array.isArray(parsed.actions)) {
    return {
      actions: parsed.actions.map((action) => parseJsonToolAction(action))
    };
  }

  return {
    actions: [parseJsonToolAction(parsed)]
  };
}

export async function runJsonActionPlan(input: {
  gateway: ToolGateway;
  plan: JsonActionPlan;
  context: ToolExecutionContext;
  taskId?: string;
  continueOnError?: boolean;
}): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];

  for (const action of input.plan.actions) {
    const result = await input.gateway.execute(
      {
        id: action.id,
        taskId: input.taskId ?? input.context.taskId,
        toolName: action.toolName,
        input: action.input
      },
      input.context
    );
    results.push(result);

    if (result.status !== "success" && !input.continueOnError) {
      break;
    }
  }

  return results;
}

export function createBuiltInToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    {
      name: "repo.read_file",
      description: "Read a UTF-8 file inside the task repository.",
      permission: "read",
      timeoutMs: 10_000
    },
    async (input, context) => {
      const relativePath = expectString(input.path, "path");
      const maxBytes = expectOptionalNumber(input.maxBytes) ?? 24_000;
      const filePath = resolveInsideRepo(context.repoDir, relativePath);
      const content = await readFile(filePath, "utf8");
      return {
        path: normalizeRelativePath(relativePath),
        content: content.slice(0, maxBytes),
        truncated: content.length > maxBytes
      };
    }
  );

  registry.register(
    {
      name: "repo.apply_patch",
      description: "Apply a unified diff to the task repository.",
      permission: "repo_write",
      timeoutMs: 30_000
    },
    async (input, context) => {
      const unifiedDiff = typeof input.unifiedDiff === "string" ? input.unifiedDiff : expectString(input.patch, "patch");
      const patchPath = path.join(context.repoDir, `.agent-tool-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);
      await writeFile(patchPath, unifiedDiff);

      try {
        return await runProcess({
          command: "git",
          args: ["apply", "--whitespace=nowarn", patchPath],
          cwd: context.repoDir,
          timeoutMs: 30_000,
          env: context.env
        });
      } finally {
        await rm(patchPath, { force: true });
      }
    }
  );

  registry.register(
    {
      name: "repo.search",
      description: "Search repository text with ripgrep.",
      permission: "read",
      timeoutMs: 10_000
    },
    async (input, context) => {
      const query = expectString(input.query, "query");
      const glob = typeof input.glob === "string" ? input.glob : undefined;
      const maxResults = expectOptionalNumber(input.maxResults) ?? 50;
      const args = ["--line-number", "--no-heading", "--color", "never", query];

      if (glob) {
        args.push("--glob", glob);
      }

      const result = await runProcess({
        command: "rg",
        args,
        cwd: context.repoDir,
        timeoutMs: 10_000,
        env: context.env
      });
      return {
        query,
        exitCode: result.exitCode,
        matches: result.stdout
          .split("\n")
          .filter(Boolean)
          .slice(0, maxResults)
          .map(parseRipgrepLine)
      };
    }
  );

  registry.register(
    {
      name: "shell.run",
      description: "Run an allowlisted shell command in the task repository.",
      permission: "repo_write",
      timeoutMs: 120_000,
      policyRefs: ["block-dangerous-shell"]
    },
    async (input, context) => {
      const command = expectString(input.command, "command");
      const result = await runProcess({
        command,
        args: [],
        cwd: context.repoDir,
        shell: true,
        timeoutMs: expectOptionalNumber(input.timeoutMs) ?? 120_000,
        env: context.env
      });
      return result;
    }
  );

  return registry;
}

export function evaluateToolPolicies(input: {
  tool: ToolDefinition;
  request: ToolCallRequest;
  policies: PolicyDefinition[];
}): PolicyDecision[] {
  const candidatePaths = extractPathCandidates(input.request.input);
  const command = typeof input.request.input.command === "string" ? input.request.input.command : undefined;

  return input.policies
    .map((policy) => {
      const reasons: string[] = [];

      if (policy.toolNames?.includes(input.tool.name)) {
        reasons.push(`tool matched ${input.tool.name}`);
      }

      if (policy.permissions?.includes(input.tool.permission)) {
        reasons.push(`permission matched ${input.tool.permission}`);
      }

      const matchedPath = policy.matchPaths?.find((pattern) => candidatePaths.some((candidate) => matchPathPattern(candidate, pattern)));

      if (matchedPath) {
        reasons.push(`path matched ${matchedPath}`);
      }

      const matchedCommand = command ? policy.matchCommands?.find((pattern) => command.includes(pattern)) : undefined;

      if (matchedCommand) {
        reasons.push(`command matched ${matchedCommand}`);
      }

      return {
        policyId: policy.id,
        action: policy.action,
        matched: reasons.length > 0,
        reasons
      };
    })
    .filter((decision) => decision.matched);
}

function parseRipgrepLine(line: string): JsonObject {
  const [file, lineNumber, ...rest] = line.split(":");
  return {
    path: file ?? "",
    line: Number(lineNumber ?? 0),
    text: rest.join(":")
  };
}

function parseJsonToolAction(value: unknown): JsonToolAction {
  if (!isRecord(value)) {
    throw new Error("JSON action must be an object");
  }

  const toolName = typeof value.toolName === "string" ? value.toolName : typeof value.tool === "string" ? value.tool : undefined;

  if (!toolName) {
    throw new Error("JSON action requires toolName or tool");
  }

  if (!isRecord(value.input)) {
    throw new Error(`JSON action ${toolName} requires object input`);
  }

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    toolName,
    input: asJsonValue(value.input) as JsonObject
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractPathCandidates(input: JsonValue, keyHint = ""): string[] {
  if (typeof input === "string") {
    if (isDiffKey(keyHint)) {
      return extractDiffPaths(input);
    }

    return isPathKey(keyHint) ? [normalizeRelativePath(input)] : [];
  }

  if (Array.isArray(input)) {
    return input.flatMap((value) => extractPathCandidates(value, keyHint));
  }

  if (input && typeof input === "object") {
    return Object.entries(input).flatMap(([key, value]) => extractPathCandidates(value, key));
  }

  return [];
}

function isPathKey(key: string): boolean {
  return ["path", "paths", "file", "files", "targetPath", "targetPaths"].includes(key);
}

function isDiffKey(key: string): boolean {
  return ["patch", "unifiedDiff", "diff"].includes(key);
}

function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>();

  for (const line of diff.split("\n")) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);

    if (diffMatch?.[1]) {
      paths.add(normalizeRelativePath(diffMatch[1]));
    }

    if (diffMatch?.[2]) {
      paths.add(normalizeRelativePath(diffMatch[2]));
    }

    const markerMatch = line.match(/^(?:---|\+\+\+) [ab]\/(.+)$/);

    if (markerMatch?.[1]) {
      paths.add(normalizeRelativePath(markerMatch[1]));
    }
  }

  return [...paths].filter((candidate) => candidate !== "/dev/null");
}

function matchPathPattern(candidate: string, pattern: string): boolean {
  const normalizedCandidate = normalizeRelativePath(candidate);
  const normalizedPattern = normalizeRelativePath(pattern);

  if (globToRegExp(normalizedPattern).test(normalizedCandidate)) {
    return true;
  }

  if (normalizedPattern.startsWith("**/")) {
    return globToRegExp(normalizedPattern.slice(3)).test(normalizedCandidate);
  }

  return false;
}

function globToRegExp(glob: string): RegExp {
  let source = "";

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];

    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }

    source += escapeRegExp(char ?? "");
  }

  return new RegExp(`^${source}$`);
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function resolveInsideRepo(repoDir: string, relativePath: string): string {
  const root = path.resolve(repoDir);
  const target = path.resolve(root, relativePath);

  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }

  return target;
}

function expectString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
}

function expectOptionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(asJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]));
  }

  return String(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Tool ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  shell?: boolean;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
}): Promise<ProcessResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: input.shell ?? false,
      env: { ...process.env, ...input.env },
      signal: controller.signal
    });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  clearTimeout(timeout);

  return {
    exitCode,
    stdout: stdout.join("").slice(-24_000),
    stderr: stderr.join("").slice(-24_000)
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
