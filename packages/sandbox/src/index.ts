import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IssueContext } from "@agent/shared";

export type SandboxMode = "docker" | "worktree";

export type SandboxConfig = {
  mode: SandboxMode;
  rootDir: string;
  dockerImage?: string;
  networkAllowlist: string[];
  maxRuntimeMinutes: number;
};

export type Sandbox = {
  taskId: string;
  repoDir: string;
  artifactDir: string;
  logDir: string;
  mode: SandboxMode;
};

export type SandboxCreateInput = {
  taskId: string;
  issue: IssueContext;
};

export type SandboxManager = {
  create(input: SandboxCreateInput): Promise<Sandbox>;
  cloneCommands(sandbox: Sandbox, remoteUrl: string, branchName: string): string[];
};

export type CommandResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type CommandOutputChunk = {
  stream: "stdout" | "stderr";
  text: string;
};

export class DockerSandboxManager implements SandboxManager {
  constructor(private readonly config: SandboxConfig) {}

  async create(input: SandboxCreateInput): Promise<Sandbox> {
    const base = path.join(this.config.rootDir, input.taskId);
    const sandbox: Sandbox = {
      taskId: input.taskId,
      repoDir: path.join(base, "repo"),
      artifactDir: path.join(base, "artifacts"),
      logDir: path.join(base, "logs"),
      mode: "docker"
    };

    await Promise.all([mkdir(sandbox.repoDir, { recursive: true }), mkdir(sandbox.artifactDir, { recursive: true }), mkdir(sandbox.logDir, { recursive: true })]);

    return sandbox;
  }

  cloneCommands(sandbox: Sandbox, remoteUrl: string, branchName: string): string[] {
    return [
      `git clone ${remoteUrl} ${sandbox.repoDir}`,
      `cd ${sandbox.repoDir}`,
      `git fetch origin`,
      `git checkout ${branchName}`
    ];
  }

  dockerRunCommand(sandbox: Sandbox): string {
    const image = this.config.dockerImage ?? "agent-sandbox-node:latest";
    return `docker run --rm -v ${sandbox.repoDir}:/workspace/repo -v ${sandbox.artifactDir}:/workspace/artifacts ${image}`;
  }
}

export class WorktreeSandboxManager extends DockerSandboxManager {
  override async create(input: SandboxCreateInput): Promise<Sandbox> {
    const sandbox = await super.create(input);
    return { ...sandbox, mode: "worktree" };
  }
}

export async function runCommand(input: {
  cwd: string;
  command: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  onOutput?: (chunk: CommandOutputChunk) => void | Promise<void>;
}): Promise<CommandResult> {
  const startedAt = Date.now();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outputCallbacks: Promise<void>[] = [];
  const timeoutMs = input.timeoutMs ?? 10 * 60_000;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const dispatchOutput = (stream: CommandOutputChunk["stream"], text: string) => {
    const callbackResult = input.onOutput?.({ stream, text });
    if (callbackResult) {
      outputCallbacks.push(Promise.resolve(callbackResult).catch(() => undefined));
    }
  };

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      env: { ...process.env, ...input.env },
      detached: true
    });
    let forceKill: NodeJS.Timeout | undefined;
    const terminateChildGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) {
        return;
      }

      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const onParentSignal = (signal: NodeJS.Signals) => {
      terminateChildGroup(signal);
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      process.kill(process.pid, signal);
    };
    const onSigterm = () => onParentSignal("SIGTERM");
    const onSigint = () => onParentSignal("SIGINT");
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKill) {
        clearTimeout(forceKill);
      }
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    };

    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    timeout = setTimeout(() => {
      timedOut = true;
      terminateChildGroup("SIGTERM");
      forceKill = setTimeout(() => terminateChildGroup("SIGKILL"), 5_000);
      forceKill.unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout.push(text);
      dispatchOutput("stdout", text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr.push(text);
      dispatchOutput("stderr", text);
    });
    child.on("error", () => {
      cleanup();
      resolve(null);
    });
    child.on("close", (code) => {
      cleanup();
      resolve(code);
    });

    if (input.stdin !== undefined) {
      child.stdin.write(input.stdin);
      child.stdin.end();
    }
  });
  await Promise.all(outputCallbacks);

  const stderrText = stderr.join("").slice(-24_000);
  const timedOutMessage = timedOut ? `Command timed out after ${timeoutMs}ms` : "";

  return {
    command: input.command,
    cwd: input.cwd,
    exitCode,
    stdout: stdout.join("").slice(-24_000),
    stderr: [stderrText, timedOutMessage].filter(Boolean).join("\n"),
    durationMs: Date.now() - startedAt
  };
}

export async function cloneRepository(input: {
  sandbox: Sandbox;
  remoteUrl: string;
  baseBranch: string;
  issueBranch: string;
  timeoutMs?: number;
}): Promise<CommandResult[]> {
  await resetCloneTarget(input.sandbox.repoDir);
  const commands = [
    `git clone --depth 1 --branch ${shellQuote(input.baseBranch)} ${shellQuote(input.remoteUrl)} ${shellQuote(input.sandbox.repoDir)}`,
    `git checkout -b ${shellQuote(input.issueBranch)}`
  ];
  const results: CommandResult[] = [];

  const cloneResult = await runCommand({
    cwd: path.dirname(input.sandbox.repoDir),
    command: commands[0] ?? "",
    timeoutMs: input.timeoutMs
  });
  results.push(cloneResult);

  if (cloneResult.exitCode !== 0) {
    return results;
  }

  results.push(
    await runCommand({
      cwd: input.sandbox.repoDir,
      command: commands[1] ?? "",
      timeoutMs: input.timeoutMs
    })
  );

  return results;
}

export async function cloneRepositoryBranch(input: {
  sandbox: Sandbox;
  remoteUrl: string;
  branch: string;
  timeoutMs?: number;
}): Promise<CommandResult[]> {
  await resetCloneTarget(input.sandbox.repoDir);
  const result = await runCommand({
    cwd: path.dirname(input.sandbox.repoDir),
    command: `git clone --depth 1 --branch ${shellQuote(input.branch)} ${shellQuote(input.remoteUrl)} ${shellQuote(input.sandbox.repoDir)}`,
    timeoutMs: input.timeoutMs
  });

  return [result];
}

export async function getGitDiff(repoDir: string): Promise<string> {
  const result = await runCommand({ cwd: repoDir, command: "git diff -- . ':!package-lock.json' ':!pnpm-lock.yaml'", timeoutMs: 60_000 });
  return `${result.stdout}${result.stderr}`.trim();
}

export async function applyUnifiedDiff(repoDir: string, diff: string): Promise<CommandResult> {
  const patchPath = path.join(repoDir, ".agent-generated.patch");
  await writeFile(patchPath, diff);
  const result = await runCommand({ cwd: repoDir, command: `git apply --whitespace=nowarn ${shellQuote(patchPath)}`, timeoutMs: 60_000 });
  await runCommand({ cwd: repoDir, command: `rm -f ${shellQuote(patchPath)}`, timeoutMs: 10_000 });
  return result;
}

export async function listChangedFiles(repoDir: string): Promise<string[]> {
  const result = await runCommand({ cwd: repoDir, command: "git status --short", timeoutMs: 60_000 });
  return result.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export async function getCurrentCommitSha(repoDir: string, ref = "HEAD"): Promise<string> {
  const result = await runCommand({ cwd: repoDir, command: `git rev-parse ${shellQuote(ref)}`, timeoutMs: 60_000 });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to resolve git ref ${ref}: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

export async function commitAll(repoDir: string, message: string): Promise<CommandResult[]> {
  const add = await runCommand({ cwd: repoDir, command: "git add -A", timeoutMs: 60_000 });

  if (add.exitCode !== 0) {
    return [add];
  }

  const commit = await runCommand({ cwd: repoDir, command: `git commit -m ${shellQuote(message)}`, timeoutMs: 60_000 });
  return [add, commit];
}

export async function pushBranch(repoDir: string, branchName: string): Promise<CommandResult> {
  return runCommand({ cwd: repoDir, command: `git push -u origin ${shellQuote(branchName)}`, timeoutMs: 10 * 60_000 });
}

async function resetCloneTarget(repoDir: string): Promise<void> {
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(path.dirname(repoDir), { recursive: true });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
