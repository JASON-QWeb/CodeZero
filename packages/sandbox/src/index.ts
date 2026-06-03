import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IssueContext } from "@agent/shared";

export type SandboxMode = "docker" | "worktree";

export type SandboxConfig = {
  mode: SandboxMode;
  rootDir: string;
  dockerImage?: string;
  networkAllowlist: string[];
  maxRuntimeMinutes: number;
  maxDiffFiles?: number;
  maxDiffLines?: number;
  filesystemAllowRepoOnly?: boolean;
  docker?: DockerResourceLimits;
};

export type DockerResourceLimits = {
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
};

export type Sandbox = {
  taskId: string;
  repoDir: string;
  artifactDir: string;
  logDir: string;
  mode: SandboxMode;
  rootDir?: string;
  dockerImage?: string;
  networkAllowlist?: string[];
  filesystemAllowRepoOnly?: boolean;
  docker?: DockerResourceLimits;
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

export type DiffLimits = {
  maxFiles?: number;
  maxLines?: number;
};

const generatedPathspecExcludes = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "test-results/**",
  "playwright-report/**",
  "coverage/**"
];

export class DockerSandboxManager implements SandboxManager {
  constructor(private readonly config: SandboxConfig) {}

  async create(input: SandboxCreateInput): Promise<Sandbox> {
    const base = path.join(this.config.rootDir, input.taskId);
    const sandbox: Sandbox = {
      taskId: input.taskId,
      repoDir: path.join(base, "repo"),
      artifactDir: path.join(base, "artifacts"),
      logDir: path.join(base, "logs"),
      mode: this.config.mode,
      rootDir: this.config.rootDir,
      dockerImage: this.config.dockerImage,
      networkAllowlist: this.config.networkAllowlist,
      filesystemAllowRepoOnly: this.config.filesystemAllowRepoOnly,
      docker: this.config.docker
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

  dockerRunCommand(sandbox: Sandbox, command = "pwd"): string {
    return formatDockerCommand({
      sandbox: { ...sandbox, dockerImage: sandbox.dockerImage ?? this.config.dockerImage },
      command
    });
  }
}

export class WorktreeSandboxManager extends DockerSandboxManager {
  override async create(input: SandboxCreateInput): Promise<Sandbox> {
    const sandbox = await super.create(input);
    return { ...sandbox, mode: "worktree" };
  }
}

export function createSandboxManager(config: SandboxConfig): SandboxManager {
  return config.mode === "worktree"
    ? new WorktreeSandboxManager(config)
    : new DockerSandboxManager(config);
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
    } else {
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

export async function runSandboxCommand(input: {
  sandbox: Sandbox;
  command: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  onOutput?: (chunk: CommandOutputChunk) => void | Promise<void>;
}): Promise<CommandResult> {
  if (input.sandbox.mode !== "docker") {
    return runCommand({
      cwd: input.sandbox.repoDir,
      command: input.command,
      timeoutMs: input.timeoutMs,
      env: input.env,
      stdin: input.stdin,
      onOutput: input.onOutput
    });
  }

  assertCommandReferencesAllowedHosts(
    input.command,
    input.sandbox.networkAllowlist ?? []
  );
  const command = await buildDockerCommand({
    sandbox: input.sandbox,
    command: input.command,
    env: input.env
  });
  return runCommand({
    cwd: input.sandbox.repoDir,
    command,
    timeoutMs: input.timeoutMs,
    stdin: input.stdin,
    onOutput: input.onOutput
  });
}

export async function cloneRepository(input: {
  sandbox: Sandbox;
  remoteUrl: string;
  baseBranch: string;
  issueBranch: string;
  timeoutMs?: number;
}): Promise<CommandResult[]> {
  if (input.sandbox.mode === "worktree") {
    return prepareWorktreeRepository({
      sandbox: input.sandbox,
      remoteUrl: input.remoteUrl,
      baseRef: input.baseBranch,
      worktreeBranch: input.issueBranch,
      timeoutMs: input.timeoutMs
    });
  }

  await resetCloneTarget(input.sandbox.repoDir);
  const cloneTarget =
    input.sandbox.mode === "docker" ? "/workspace/repo" : input.sandbox.repoDir;
  const commands = [
    `git clone --depth 1 --branch ${shellQuote(input.baseBranch)} ${shellQuote(input.remoteUrl)} ${shellQuote(cloneTarget)}`,
    `git checkout -b ${shellQuote(input.issueBranch)}`
  ];
  const results: CommandResult[] = [];

  const cloneResult = await runCloneCommand({
    sandbox: input.sandbox,
    command: commands[0] ?? "",
    timeoutMs: input.timeoutMs
  });
  results.push(cloneResult);

  if (cloneResult.exitCode !== 0) {
    return results;
  }

  results.push(
    await runCloneCommand({
      sandbox: input.sandbox,
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
  if (input.sandbox.mode === "worktree") {
    return prepareWorktreeRepository({
      sandbox: input.sandbox,
      remoteUrl: input.remoteUrl,
      baseRef: input.branch,
      worktreeBranch: input.branch,
      timeoutMs: input.timeoutMs
    });
  }

  await resetCloneTarget(input.sandbox.repoDir);
  const result = await runCloneCommand({
    sandbox: input.sandbox,
    command: `git clone --depth 1 --branch ${shellQuote(input.branch)} ${shellQuote(input.remoteUrl)} ${shellQuote(input.sandbox.mode === "docker" ? "/workspace/repo" : input.sandbox.repoDir)}`,
    timeoutMs: input.timeoutMs
  });

  return [result];
}

export async function getGitDiff(repoDir: string): Promise<string> {
  const result = await runCommand({ cwd: repoDir, command: `git diff -- ${gitTrackedPathspec()}`, timeoutMs: 60_000 });
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
  const result = await runCommand({ cwd: repoDir, command: `git status --short -- ${gitTrackedPathspec()}`, timeoutMs: 60_000 });
  return result.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export async function enforceDiffLimits(
  repoDir: string,
  limits: DiffLimits,
): Promise<void> {
  const [changedFiles, diff] = await Promise.all([
    listChangedFiles(repoDir),
    getGitDiff(repoDir)
  ]);
  const changedLineCount = diff
    .split("\n")
    .filter((line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ).length;

  if (
    limits.maxFiles !== undefined &&
    changedFiles.length > limits.maxFiles
  ) {
    throw new Error(
      `Diff changed ${changedFiles.length} files, exceeding sandbox limit ${limits.maxFiles}`,
    );
  }

  if (limits.maxLines !== undefined && changedLineCount > limits.maxLines) {
    throw new Error(
      `Diff changed ${changedLineCount} lines, exceeding sandbox limit ${limits.maxLines}`,
    );
  }
}

export async function getCurrentCommitSha(repoDir: string, ref = "HEAD"): Promise<string> {
  const result = await runCommand({ cwd: repoDir, command: `git rev-parse ${shellQuote(ref)}`, timeoutMs: 60_000 });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to resolve git ref ${ref}: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

export async function commitAll(repoDir: string, message: string): Promise<CommandResult[]> {
  const add = await runCommand({ cwd: repoDir, command: `git add -A -- ${gitTrackedPathspec()}`, timeoutMs: 60_000 });

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

async function runCloneCommand(input: {
  sandbox: Sandbox;
  command: string;
  timeoutMs?: number;
}): Promise<CommandResult> {
  if (input.sandbox.mode === "docker") {
    return runSandboxCommand(input);
  }

  return runCommand({
    cwd: path.dirname(input.sandbox.repoDir),
    command: input.command,
    timeoutMs: input.timeoutMs
  });
}

async function prepareWorktreeRepository(input: {
  sandbox: Sandbox;
  remoteUrl: string;
  baseRef: string;
  worktreeBranch: string;
  timeoutMs?: number;
}): Promise<CommandResult[]> {
  await resetCloneTarget(input.sandbox.repoDir);
  const cacheDir = path.join(sandboxRootDir(input.sandbox), "_git-cache");
  await mkdir(cacheDir, { recursive: true });
  const mirrorDir = path.join(cacheDir, `${hashRemote(input.remoteUrl)}.git`);
  const results: CommandResult[] = [];
  const mirrorExists = await pathExists(path.join(mirrorDir, "HEAD"));

  if (!mirrorExists) {
    const cloneMirror = await runCommand({
      cwd: cacheDir,
      command: `git clone --mirror ${shellQuote(input.remoteUrl)} ${shellQuote(mirrorDir)}`,
      timeoutMs: input.timeoutMs
    });
    results.push(cloneMirror);

    if (cloneMirror.exitCode !== 0) {
      return results;
    }
  } else {
    const setUrl = await runCommand({
      cwd: mirrorDir,
      command: `git remote set-url origin ${shellQuote(input.remoteUrl)}`,
      timeoutMs: 60_000
    });
    results.push(setUrl);

    if (setUrl.exitCode !== 0) {
      return results;
    }
  }

  const fetch = await runCommand({
    cwd: mirrorDir,
    command: "git fetch --prune origin '+refs/heads/*:refs/heads/*'",
    timeoutMs: input.timeoutMs
  });
  results.push(fetch);

  if (fetch.exitCode !== 0) {
    return results;
  }

  const prune = await runCommand({
    cwd: mirrorDir,
    command: "git worktree prune",
    timeoutMs: 60_000
  });
  results.push(prune);

  if (prune.exitCode !== 0) {
    return results;
  }

  const addWorktree = await runCommand({
    cwd: mirrorDir,
    command: [
      "git worktree add --force",
      "-B",
      shellQuote(input.worktreeBranch),
      shellQuote(input.sandbox.repoDir),
      shellQuote(input.baseRef)
    ].join(" "),
    timeoutMs: input.timeoutMs
  });
  results.push(addWorktree);
  return results;
}

async function buildDockerCommand(input: {
  sandbox: Sandbox;
  command: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const sandbox = input.sandbox;
  await Promise.all([
    mkdir(sandbox.repoDir, { recursive: true }),
    mkdir(sandbox.artifactDir, { recursive: true }),
    mkdir(sandbox.logDir, { recursive: true })
  ]);
  const envFile = await writeDockerEnvFile(sandbox, input.env);
  return formatDockerCommand({ ...input, envFile });
}

function formatDockerCommand(input: {
  sandbox: Sandbox;
  command: string;
  envFile?: string;
}): string {
  const sandbox = input.sandbox;
  const dockerArgs = [
    "docker run --rm --init",
    "--cap-drop ALL",
    "--security-opt no-new-privileges",
    sandbox.networkAllowlist?.length ? "--network bridge" : "--network none",
    sandbox.docker?.memory ? `--memory ${shellQuote(sandbox.docker.memory)}` : "",
    sandbox.docker?.cpus ? `--cpus ${shellQuote(String(sandbox.docker.cpus))}` : "",
    sandbox.docker?.pidsLimit ? `--pids-limit ${shellQuote(String(sandbox.docker.pidsLimit))}` : "",
    `-v ${shellQuote(sandbox.repoDir)}:/workspace/repo`,
    `-v ${shellQuote(sandbox.artifactDir)}:/workspace/artifacts`,
    `-v ${shellQuote(sandbox.logDir)}:/workspace/logs`,
    input.envFile ? `--env-file ${shellQuote(input.envFile)}` : "",
    `-e CODEZERO_NETWORK_ALLOWLIST=${shellQuote((sandbox.networkAllowlist ?? []).join(","))}`,
    "-w /workspace/repo",
    shellQuote(sandbox.dockerImage ?? "agent-sandbox-node:latest"),
    "/bin/sh -lc",
    shellQuote(input.command)
  ].filter(Boolean);
  return dockerArgs.join(" ");
}

async function writeDockerEnvFile(
  sandbox: Sandbox,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string | undefined> {
  const entries = Object.entries(env ?? {}).filter(
    (entry): entry is [string, string] =>
      Boolean(entry[0]) && entry[1] !== undefined,
  );

  if (entries.length === 0) {
    return undefined;
  }

  const filePath = path.join(
    sandbox.logDir,
    `docker-env-${Date.now()}-${Math.random().toString(16).slice(2)}.env`,
  );
  const content = entries
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`)
    .join("\n");
  await writeFile(filePath, `${content}\n`, { mode: 0o600 });
  return filePath;
}

function assertCommandReferencesAllowedHosts(
  command: string,
  allowlist: string[],
): void {
  const allowed = new Set(allowlist.map((host) => host.toLowerCase()));
  const hosts = commandHosts(command);

  if (allowed.size === 0 && hosts.length > 0) {
    throw new Error(
      `Sandbox command references network hosts but network allowlist is empty: ${hosts.join(", ")}`,
    );
  }

  const blocked = hosts.filter((host) => !allowed.has(host.toLowerCase()));

  if (blocked.length > 0) {
    throw new Error(
      `Sandbox command references hosts outside network allowlist: ${blocked.join(", ")}`,
    );
  }
}

function commandHosts(command: string): string[] {
  const hosts = new Set<string>();
  const urlPattern = /\b(?:https?|ssh|git):\/\/([^/\s'"]+)/gi;

  for (const match of command.matchAll(urlPattern)) {
    const host = (match[1] ?? "").replace(/^.*@/, "").replace(/:\d+$/, "");

    if (host) {
      hosts.add(host);
    }
  }

  for (const match of command.matchAll(/\bgit@([^:\s'"]+):/g)) {
    const host = match[1];

    if (host) {
      hosts.add(host);
    }
  }

  return [...hosts];
}

function sandboxRootDir(sandbox: Sandbox): string {
  return sandbox.rootDir ?? path.dirname(path.dirname(sandbox.repoDir));
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}

function hashRemote(remoteUrl: string): string {
  return createHash("sha256").update(remoteUrl).digest("hex").slice(0, 24);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function gitTrackedPathspec(): string {
  return [".", ...generatedPathspecExcludes.map((pattern) => `:(exclude)${pattern}`)]
    .map(shellQuote)
    .join(" ");
}
