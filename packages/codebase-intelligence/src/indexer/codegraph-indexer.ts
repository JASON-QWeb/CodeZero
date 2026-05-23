import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonObject, JsonValue } from "@agent/shared";

export const defaultCodeGraphPackage = "@colbymchenry/codegraph@0.9.3";
export const defaultCodeGraphInitArgs = ["--index"];
export const defaultCodeGraphRefreshArgs = ["--quiet"];

export type CodeGraphIndexStatus = "success" | "failed";

export type CodeGraphIndexCommand = {
  command: "npx";
  args: string[];
  displayCommand: string;
};

export type CodeGraphIndexInput = {
  repoDir: string;
  packageName?: string;
  initArgs?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type CodeGraphContextInput = {
  repoDir: string;
  task: string;
  packageName?: string;
  timeoutMs?: number;
  maxNodes?: number;
  maxCode?: number;
  env?: NodeJS.ProcessEnv;
};

export type CodeGraphIndexResult = {
  tool: "codegraph";
  status: CodeGraphIndexStatus;
  command: string;
  args: string[];
  displayCommand: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  indexDir: string;
  databaseFile: string;
  createdAt: string;
};

export type CodeGraphContextResult = {
  tool: "codegraph";
  status: CodeGraphIndexStatus;
  command: string;
  args: string[];
  displayCommand: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  context?: JsonObject;
  createdAt: string;
};

type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export function createCodeGraphIndexCommand(
  input: Pick<CodeGraphIndexInput, "repoDir" | "packageName" | "initArgs"> = { repoDir: "." }
): CodeGraphIndexCommand {
  const packageName = input.packageName ?? defaultCodeGraphPackage;
  const initArgs = input.initArgs ?? defaultCodeGraphInitArgs;
  const args = ["-y", packageName, "init", input.repoDir, ...initArgs];

  return {
    command: "npx",
    args,
    displayCommand: ["npx", ...args].map(shellDisplayQuote).join(" ")
  };
}

export function createCodeGraphRefreshCommand(input: Pick<CodeGraphIndexInput, "repoDir" | "packageName">): CodeGraphIndexCommand {
  const packageName = input.packageName ?? defaultCodeGraphPackage;
  const args = ["-y", packageName, "index", input.repoDir, ...defaultCodeGraphRefreshArgs];

  return {
    command: "npx",
    args,
    displayCommand: ["npx", ...args].map(shellDisplayQuote).join(" ")
  };
}

export function createCodeGraphContextCommand(input: Pick<CodeGraphContextInput, "repoDir" | "task" | "packageName" | "maxNodes" | "maxCode">): CodeGraphIndexCommand {
  const packageName = input.packageName ?? defaultCodeGraphPackage;
  const args = ["-y", packageName, "context", input.task, "--path", input.repoDir, "--format", "json"];

  if (input.maxNodes) {
    args.push("--max-nodes", String(input.maxNodes));
  }

  if (input.maxCode) {
    args.push("--max-code", String(input.maxCode));
  }

  return {
    command: "npx",
    args,
    displayCommand: ["npx", ...args].map(shellDisplayQuote).join(" ")
  };
}

export async function indexRepositoryWithCodeGraph(input: CodeGraphIndexInput): Promise<CodeGraphIndexResult> {
  const startedAt = Date.now();
  const databaseFile = path.join(input.repoDir, ".codegraph", "codegraph.db");
  const alreadyInitialized = await access(databaseFile).then(
    () => true,
    () => false
  );
  const command = alreadyInitialized ? createCodeGraphRefreshCommand(input) : createCodeGraphIndexCommand(input);
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), "agent-codegraph-run-"));

  await ensureCodeGraphExcluded(input.repoDir);

  try {
    const result = await runProcess({
      command: command.command,
      args: command.args,
      cwd: scratchDir,
      timeoutMs: input.timeoutMs ?? 10 * 60_000,
      env: {
        ...input.env,
        CODEGRAPH_FORCE_WATCH: "1"
      }
    });

    return {
      tool: "codegraph",
      status: result.exitCode === 0 ? "success" : "failed",
      command: command.command,
      args: command.args,
      displayCommand: command.displayCommand,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
      indexDir: path.join(input.repoDir, ".codegraph"),
      databaseFile,
      createdAt: new Date().toISOString()
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

export async function buildCodeGraphTaskContext(input: CodeGraphContextInput): Promise<CodeGraphContextResult> {
  const startedAt = Date.now();
  const command = createCodeGraphContextCommand(input);
  const result = await runProcess({
    command: command.command,
    args: command.args,
    cwd: input.repoDir,
    timeoutMs: input.timeoutMs ?? 60_000,
    env: input.env ?? process.env
  });
  let context: JsonObject | undefined;
  let parseError = "";

  if (result.exitCode === 0) {
    try {
      const parsed: unknown = JSON.parse(result.stdout);

      if (isJsonObject(parsed)) {
        context = parsed;
      } else {
        parseError = "CodeGraph context output is not a JSON object";
      }
    } catch (error) {
      parseError = `CodeGraph context output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    tool: "codegraph",
    status: result.exitCode === 0 && context ? "success" : "failed",
    command: command.command,
    args: command.args,
    displayCommand: command.displayCommand,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: [result.stderr, parseError].filter(Boolean).join("\n"),
    durationMs: Date.now() - startedAt,
    context,
    createdAt: new Date().toISOString()
  };
}

async function ensureCodeGraphExcluded(repoDir: string): Promise<void> {
  const excludePath = await resolveGitExcludePath(repoDir);

  if (!excludePath) {
    return;
  }
  const current = await readFile(excludePath, "utf8").catch(() => "");

  if (current.split(/\r?\n/).some((line) => line.trim() === ".codegraph/" || line.trim() === ".codegraph")) {
    return;
  }

  await mkdir(path.dirname(excludePath), { recursive: true });
  await writeFile(excludePath, `${current}${current.endsWith("\n") || current.length === 0 ? "" : "\n"}.codegraph/\n`);
}

async function resolveGitExcludePath(repoDir: string): Promise<string | undefined> {
  const result = await runProcess({
    command: "git",
    args: ["rev-parse", "--git-path", "info/exclude"],
    cwd: repoDir,
    timeoutMs: 10_000,
    env: process.env
  });
  const excludePath = result.stdout.trim();

  if (result.exitCode !== 0 || !excludePath) {
    return undefined;
  }

  return path.resolve(repoDir, excludePath);
}

async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      signal: controller.signal
    });

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  clearTimeout(timeout);

  return {
    exitCode,
    stdout: tail(stdout.join("")),
    stderr: tail(stderr.join(""))
  };
}

function tail(value: string, maxChars = 24_000): string {
  return value.slice(-maxChars);
}

function shellDisplayQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonObject(value);
}
