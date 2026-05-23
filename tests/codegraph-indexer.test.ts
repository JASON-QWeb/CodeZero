import { describe, expect, it } from "vitest";
import { createCodeGraphContextCommand, createCodeGraphIndexCommand, createCodeGraphSyncCommand } from "@agent/codebase-intelligence";

describe("codegraph indexer", () => {
  it("builds a pinned upstream init-and-index command", () => {
    const command = createCodeGraphIndexCommand({ repoDir: "/tmp/example-repo" });

    expect(command.command).toBe("npx");
    expect(command.args).toEqual(["-y", "@colbymchenry/codegraph@0.9.3", "init", "/tmp/example-repo", "--index"]);
    expect(command.displayCommand).toBe("npx -y @colbymchenry/codegraph@0.9.3 init /tmp/example-repo --index");
  });

  it("allows repository config to add CodeGraph initialization flags", () => {
    const command = createCodeGraphIndexCommand({
      repoDir: "/tmp/example-repo",
      packageName: "@colbymchenry/codegraph@0.9.3",
      initArgs: ["--index", "--verbose"]
    });

    expect(command.args).toContain("--index");
    expect(command.args).toContain("--verbose");
  });

  it("uses the upstream incremental sync command for an existing database", () => {
    const command = createCodeGraphSyncCommand({ repoDir: "/tmp/example-repo" });

    expect(command.args).toEqual(["-y", "@colbymchenry/codegraph@0.9.3", "sync", "/tmp/example-repo", "--quiet"]);
  });

  it("uses the upstream context command to prepare task context for the agent", () => {
    const command = createCodeGraphContextCommand({
      repoDir: "/tmp/example-repo",
      task: "Fix checkout retries",
      maxNodes: 30,
      maxCode: 10
    });

    expect(command.args).toEqual([
      "-y",
      "@colbymchenry/codegraph@0.9.3",
      "context",
      "Fix checkout retries",
      "--path",
      "/tmp/example-repo",
      "--format",
      "json",
      "--max-nodes",
      "30",
      "--max-code",
      "10"
    ]);
  });
});
