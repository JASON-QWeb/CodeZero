import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBuiltInToolRegistry,
  evaluateToolPolicies,
  extractDiffPaths,
  extractPathCandidates,
  matchPathPattern,
  parseJsonActionPlan,
  runJsonActionPlan,
  ToolGateway,
  ToolRegistry
} from "@agent/tool-gateway";

describe("tool gateway modules", () => {
  it("extracts paths from nested tool input and unified diffs", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      ""
    ].join("\n");

    expect(extractDiffPaths(diff)).toEqual(["src/old.ts", "src/new.ts"]);
    expect(extractPathCandidates({ input: { paths: ["./src/a.ts"], unifiedDiff: diff } })).toEqual(["src/a.ts", "src/old.ts", "src/new.ts"]);
  });

  it("matches repository path policies with glob patterns", () => {
    expect(matchPathPattern("src/app/config.ts", "**/config.ts")).toBe(true);
    expect(matchPathPattern("src/app/config.ts", "src/*/config.ts")).toBe(true);
    expect(matchPathPattern("src/app/config.ts", "test/**")).toBe(false);
  });

  it("evaluates tool, permission, path, and command policy reasons", () => {
    const decisions = evaluateToolPolicies({
      tool: {
        name: "shell.run",
        description: "Run",
        permission: "repo_write"
      },
      request: {
        toolName: "shell.run",
        input: {
          command: "rm -rf .",
          path: ".env"
        }
      },
      policies: [
        { id: "tool", toolNames: ["shell.run"], action: "audit" },
        { id: "permission", permissions: ["repo_write"], action: "audit" },
        { id: "path", matchPaths: [".env*"], action: "block" },
        { id: "command", matchCommands: ["rm -rf"], action: "block" }
      ]
    });

    expect(decisions.map((decision) => decision.policyId)).toEqual(["tool", "permission", "path", "command"]);
    expect(decisions.at(-1)?.reasons).toContain("command matched rm -rf");
  });

  it("rejects duplicate registrations and unknown tool calls cleanly", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "noop", description: "Noop", permission: "read" }, () => ({ ok: true }));

    expect(() => registry.register({ name: "noop", description: "Noop", permission: "read" }, () => ({ ok: true }))).toThrow("already registered");

    const result = await new ToolGateway({ registry }).execute({ toolName: "missing", input: {} }, { repoDir: process.cwd() });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Unknown tool");
  });

  it("stops or continues JSON action plans based on continueOnError", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-tool-plan-"));
    await writeFile(path.join(repoDir, "README.md"), "# Demo\n");
    const gateway = new ToolGateway({ registry: createBuiltInToolRegistry() });
    const plan = parseJsonActionPlan(JSON.stringify({
      actions: [
        { tool: "missing.tool", input: {} },
        { tool: "repo.read_file", input: { path: "README.md" } }
      ]
    }));

    await expect(runJsonActionPlan({ gateway, plan, context: { repoDir } })).resolves.toHaveLength(1);
    const continued = await runJsonActionPlan({ gateway, plan, context: { repoDir }, continueOnError: true });
    expect(continued.map((result) => result.status)).toEqual(["failed", "success"]);
  });

  it("prevents repository read tools from escaping the repo root", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-tool-escape-"));
    const gateway = new ToolGateway({ registry: createBuiltInToolRegistry() });
    const result = await gateway.execute({ toolName: "repo.read_file", input: { path: "../outside.txt" } }, { repoDir });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("escapes repository root");
  });
});
