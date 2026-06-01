import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DockerSandboxManager,
  WorktreeSandboxManager,
  applyUnifiedDiff,
  cloneRepository,
  commitAll,
  getCurrentCommitSha,
  getGitDiff,
  listChangedFiles,
  runCommand
} from "@agent/sandbox";
import type { IssueContext } from "@agent/shared";

const issue: IssueContext = {
  provider: "github",
  owner: "acme",
  repo: "shop",
  number: 1,
  url: "https://github.com/acme/shop/issues/1",
  title: "Fix checkout",
  body: "",
  labels: [],
  comments: [],
  baseBranch: "main"
};

describe("sandbox command runner", () => {
  it("creates docker and worktree sandbox directory layouts", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-root-"));
    const manager = new DockerSandboxManager({
      mode: "docker",
      rootDir,
      dockerImage: "agent-sandbox-node:test",
      networkAllowlist: [],
      maxRuntimeMinutes: 10
    });
    const sandbox = await manager.create({ taskId: "task-1", issue });
    const worktree = await new WorktreeSandboxManager({
      mode: "worktree",
      rootDir,
      networkAllowlist: [],
      maxRuntimeMinutes: 10
    }).create({ taskId: "task-2", issue });

    expect(sandbox.repoDir).toBe(path.join(rootDir, "task-1", "repo"));
    expect(manager.cloneCommands(sandbox, "https://example.test/repo.git", "agent/issue-1")).toContain("git fetch origin");
    expect(manager.dockerRunCommand(sandbox)).toContain("agent-sandbox-node:test");
    expect(worktree.mode).toBe("worktree");
  });

  it("runs commands and captures output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-"));
    const chunks: string[] = [];
    const result = await runCommand({
      cwd: dir,
      command: "printf hello; printf warn >&2",
      onOutput: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`)
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("warn");
    expect(chunks).toEqual(["stdout:hello", "stderr:warn"]);
  });

  it("closes stdin for commands that do not receive input", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-stdin-"));
    const result = await runCommand({
      cwd: dir,
      command:
        "node -e \"process.stdin.on('end',()=>process.stdout.write('closed')); process.stdin.resume()\"",
      timeoutMs: 1_000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("closed");
  });

  it("terminates nested child processes when commands time out", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-timeout-"));
    const result = await runCommand({ cwd: dir, command: "sh -c 'sleep 1; printf alive > child.txt'", timeoutMs: 100 });

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Command timed out");
    await expect(access(path.join(dir, "child.txt"))).rejects.toThrow();
  });

  it("clears stale clone targets before cloning a repository", async () => {
    const sourceRepo = await createGitRepo();
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-root-"));
    const manager = new DockerSandboxManager({
      mode: "docker",
      rootDir,
      dockerImage: "agent-sandbox-node:test",
      networkAllowlist: [],
      maxRuntimeMinutes: 10
    });
    const sandbox = await manager.create({ taskId: "task-retry", issue });
    await mkdir(sandbox.repoDir, { recursive: true });
    const stalePath = path.join(sandbox.repoDir, "stale.txt");
    await writeFile(stalePath, "old clone\n");

    const results = await cloneRepository({
      sandbox,
      remoteUrl: sourceRepo,
      baseBranch: "main",
      issueBranch: "agent/issue-1"
    });

    expect(results.every((result) => result.exitCode === 0)).toBe(true);
    await expect(access(stalePath)).rejects.toThrow();
    await expect(getCurrentCommitSha(sandbox.repoDir)).resolves.toMatch(/[a-f0-9]{40}/);
  });

  it("supports git diff, changed-files, patch, commit, and ref helpers", async () => {
    const dir = await createGitRepo();
    const initialSha = await getCurrentCommitSha(dir);

    await writeFile(path.join(dir, "a.txt"), "b\n");
    await mkdir(path.join(dir, "test-results"), { recursive: true });
    await mkdir(path.join(dir, "playwright-report"), { recursive: true });
    await mkdir(path.join(dir, "coverage"), { recursive: true });
    await writeFile(path.join(dir, "test-results", ".last-run.json"), "{}\n");
    await writeFile(path.join(dir, "playwright-report", "index.html"), "<!doctype html>\n");
    await writeFile(path.join(dir, "coverage", "coverage-final.json"), "{}\n");
    expect(await getGitDiff(dir)).toContain("-a");
    expect(await listChangedFiles(dir)).toEqual(["a.txt"]);

    await writeFile(path.join(dir, "patch-target.txt"), "before\n");
    await runCommand({ cwd: dir, command: "git add patch-target.txt && git commit -m patch-target" });
    const patchResult = await applyUnifiedDiff(
      dir,
      [
        "diff --git a/patch-target.txt b/patch-target.txt",
        "index 96d80cd..cb5a311 100644",
        "--- a/patch-target.txt",
        "+++ b/patch-target.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        ""
      ].join("\n")
    );
    expect(patchResult.exitCode).toBe(0);
    expect(await readFile(path.join(dir, "patch-target.txt"), "utf8")).toBe("after\n");

    const commitResults = await commitAll(dir, "update files");
    expect(commitResults.every((result) => result.exitCode === 0)).toBe(true);
    const committedFiles = await runCommand({ cwd: dir, command: "git show --name-only --format= HEAD" });
    expect(committedFiles.stdout).not.toContain("test-results");
    expect(committedFiles.stdout).not.toContain("playwright-report");
    expect(committedFiles.stdout).not.toContain("coverage");
    await expect(getCurrentCommitSha(dir)).resolves.not.toBe(initialSha);
    await expect(getCurrentCommitSha(dir, "missing-ref")).rejects.toThrow("Failed to resolve git ref missing-ref");
  });
});

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-git-"));
  await runCommand({ cwd: dir, command: "git init -b main" });
  await runCommand({ cwd: dir, command: "git config user.email test@example.com && git config user.name Test" });
  await writeFile(path.join(dir, "a.txt"), "a\n");
  await runCommand({ cwd: dir, command: "git add a.txt && git commit -m init" });
  return dir;
}
