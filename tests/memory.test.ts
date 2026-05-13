import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContextPack } from "@agent/codebase-intelligence";
import { createTaskMemoryProposal, FileMemoryStore, toContextMemories } from "@agent/memory";
import { createTask } from "@agent/orchestrator";
import type { IssueContext, Task } from "@agent/shared";

const issue: IssueContext = {
  provider: "github",
  owner: "acme",
  repo: "shop",
  number: 12,
  url: "https://github.com/acme/shop/issues/12",
  title: "Refund status copy wrong",
  body: "The order detail page shows stale refund status copy.",
  labels: ["frontend", "refund"],
  comments: [],
  baseBranch: "main"
};

describe("memory", () => {
  it("creates task memory proposals for episodic and procedural memory", () => {
    const task: Task = {
      ...createTask(issue),
      prd: {
        title: "Refund status copy wrong",
        background: "",
        goals: ["Fix refund status copy on order detail."],
        nonGoals: [],
        userStories: [],
        acceptanceCriteria: [],
        risks: [],
        unknowns: [],
        taskType: "frontend",
        complexity: { score: 20, requiresHumanReview: false, reasons: [] }
      },
      qualityGateResults: [{ kind: "unit_test", command: "pnpm test", passed: true, exitCode: 0, durationMs: 100, output: "" }],
      reviewResult: {
        approved: true,
        blockingFindings: [],
        nonBlockingFindings: [],
        missingTests: [],
        scopeViolations: [],
        riskLevel: "low",
        prDescriptionNotes: []
      }
    };
    const proposal = createTaskMemoryProposal({ task, now: new Date("2026-05-12T00:00:00.000Z") });

    expect(proposal.records.map((record) => record.kind)).toEqual(["episodic", "procedural"]);
    expect(proposal.records.every((record) => record.status === "proposed")).toBe(true);
    expect(proposal.records[0]?.tags).toContain("refund");
  });

  it("stores proposed memory and searches only approved records", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
    const store = new FileMemoryStore(path.join(dir, "memory.json"));
    const proposal = createTaskMemoryProposal({ task: createTask(issue) });

    await store.propose(proposal.records);
    expect(await store.search(issue)).toHaveLength(0);

    await store.approve(proposal.records[0]?.id ?? "");
    const results = await store.search(issue);

    expect(results[0]?.record.kind).toBe("episodic");
    expect(results[0]?.reasons.length).toBeGreaterThan(0);
  });

  it("injects approved memory search results into ContextPack", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
    const store = new FileMemoryStore(path.join(dir, "memory.json"));
    const proposal = createTaskMemoryProposal({ task: createTask(issue) });
    await store.propose(proposal.records);
    await store.approve(proposal.records[0]?.id ?? "");
    const memories = toContextMemories(await store.search(issue));
    const contextPack = await buildContextPack({
      taskId: "task-memory",
      issue,
      repoDir: dir,
      files: [],
      symbols: [],
      businessRules: [],
      memories
    });

    expect(contextPack.memories).toHaveLength(1);
    expect(contextPack.memories[0]?.kind).toBe("episodic");
    expect(contextPack.memories[0]?.reasons.length).toBeGreaterThan(0);
  });
});
