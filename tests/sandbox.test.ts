import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getGitDiff, runCommand } from "@agent/sandbox";

describe("sandbox command runner", () => {
  it("runs commands and captures output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-sandbox-"));
    const result = await runCommand({ cwd: dir, command: "printf hello" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("can inspect git diff", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-git-"));
    await runCommand({ cwd: dir, command: "git init" });
    await runCommand({ cwd: dir, command: "git config user.email test@example.com && git config user.name Test" });
    await writeFile(path.join(dir, "a.txt"), "a\n");
    await runCommand({ cwd: dir, command: "git add a.txt && git commit -m init" });
    await writeFile(path.join(dir, "a.txt"), "b\n");
    expect(await getGitDiff(dir)).toContain("-a");
  });
});

