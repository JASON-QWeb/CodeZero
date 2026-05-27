import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readContextFileSnippets } from "@agent/codebase-intelligence";
import type { ContextPack } from "@agent/shared";

describe("context pack snippets", () => {
  it("can read a small ordered subset for implementation prompts", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-context-snippets-"));
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src/a.ts"), "aaaaaa\n");
    await writeFile(path.join(repoDir, "src/b.ts"), "bbbbbb\n");
    await writeFile(path.join(repoDir, "src/c.ts"), "cccccc\n");

    const snippets = await readContextFileSnippets(repoDir, contextPack(), {
      includePaths: ["src/b.ts", "./src/a.ts"],
      maxCharsPerFile: 4,
      maxFiles: 1
    });

    expect(snippets).toEqual({
      "src/b.ts": "bbbb"
    });
  });

  it("can read execution-plan files even when they were not selected as relevant files", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-context-snippets-"));
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src/planned.ts"), "planned file\n");

    const snippets = await readContextFileSnippets(repoDir, contextPack(), {
      includePaths: ["src/planned.ts"],
      maxCharsPerFile: 20
    });

    expect(snippets).toEqual({
      "src/planned.ts": "planned file\n"
    });
  });
});

function contextPack(): ContextPack {
  return {
    id: "ctx-1",
    taskId: "task-1",
    taskSummary: "Demo",
    businessRules: [],
    memories: [],
    relevantFiles: ["src/a.ts", "src/b.ts", "src/c.ts"].map((filePath) => ({
      path: filePath,
      reason: "test",
      evidence: [],
      readMode: "full" as const
    })),
    symbols: [],
    tests: [],
    similarChanges: [],
    nonRelevantAreas: [],
    openQuestions: [],
    tokenBudget: 1000,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}
