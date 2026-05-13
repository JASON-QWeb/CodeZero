import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGoldenIssue, evaluateGoldenIssueSuite, renderEvalReportMarkdown, type GoldenIssueCandidate, type GoldenIssueFixture } from "@agent/evals";
import type { ContextPack, TaskTrace } from "@agent/shared";

describe("golden issue eval harness", () => {
  it("scores a complete candidate against the golden fixture", async () => {
    const fixture = await loadFixture();
    const report = evaluateGoldenIssue(fixture, {
      contextPack: contextPack(),
      navigationRoute: { entrypoints: ["/orders/:id"] },
      prBody: ["## Local Verification", "## Quality Gates"].join("\n"),
      trace: trace()
    });

    expect(report.total).toBe(6);
    expect(report.passed).toBe(6);
    expect(report.score).toBe(1);
  });

  it("surfaces regression when required evidence disappears", async () => {
    const fixture = await loadFixture();
    const report = evaluateGoldenIssue(fixture, {
      contextPack: { ...contextPack(), memories: [], tests: [] },
      navigationRoute: { entrypoints: [] },
      prBody: "## Summary",
      trace: { ...trace(), spans: trace().spans.filter((span) => span.kind !== "memory" && span.kind !== "tool") }
    });

    expect(report.score).toBeLessThan(1);
    expect(report.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.id)).toContain("memory-kinds");
  });

  it("evaluates the golden suite and renders a CI-friendly report", async () => {
    const fixtures = await loadFixtures();
    const candidates = await loadCandidates();
    const report = evaluateGoldenIssueSuite(fixtures, candidates);
    const markdown = renderEvalReportMarkdown(report);

    expect(report.fixtures).toHaveLength(3);
    expect(report.score).toBe(1);
    expect(markdown).toContain("Golden Issue Eval Report");
    expect(markdown).toContain("API rate limit policy and tool gateway regression");
  });
});

async function loadFixture(): Promise<GoldenIssueFixture> {
  const content = await readFile(path.join(process.cwd(), "evals", "golden-issues", "refund-status.json"), "utf8");
  return JSON.parse(content) as GoldenIssueFixture;
}

async function loadFixtures(): Promise<GoldenIssueFixture[]> {
  const dir = path.join(process.cwd(), "evals", "golden-issues");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort((left, right) => left.localeCompare(right));
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(dir, file), "utf8")) as GoldenIssueFixture));
}

async function loadCandidates(): Promise<Map<string, GoldenIssueCandidate>> {
  const dir = path.join(process.cwd(), "evals", "candidates");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort((left, right) => left.localeCompare(right));
  const candidates = new Map<string, GoldenIssueCandidate>();

  for (const file of files) {
    const parsed = JSON.parse(await readFile(path.join(dir, file), "utf8")) as GoldenIssueCandidate & { fixtureId?: string };
    const { fixtureId, ...candidate } = parsed;
    candidates.set(fixtureId ?? path.basename(file, ".json"), candidate);
  }

  return candidates;
}

function contextPack(): ContextPack {
  return {
    id: "ctx-task-7",
    taskId: "task-7",
    taskSummary: "Refund status wrong on order detail page",
    businessRules: [],
    memories: [
      {
        id: "memory-refund",
        kind: "episodic",
        title: "Prior refund issue",
        content: "Refund status used billing refund service.",
        score: 0.91,
        confidence: 0.86,
        reasons: ["matched refund"]
      }
    ],
    relevantFiles: [
      {
        path: "src/billing/refund-status.ts",
        reason: "Relevant refund status logic",
        evidence: [{ kind: "graph", score: 10, summary: "navigation" }],
        readMode: "full"
      }
    ],
    symbols: [],
    tests: ["src/billing/refund-status.test.ts"],
    similarChanges: [],
    nonRelevantAreas: [],
    openQuestions: [],
    tokenBudget: 30_000,
    createdAt: "2026-05-12T00:00:00.000Z"
  };
}

function trace(): TaskTrace {
  return {
    taskId: "task-7",
    status: "HUMAN_REVIEW",
    issueUrl: "https://github.com/acme/shop/issues/7",
    spans: [
      span("navigation", "NAVIGATION_ROUTE_CREATED"),
      span("memory", "MEMORY_RETRIEVED"),
      span("tool", "TOOL_CALL_FINISHED")
    ],
    artifacts: [],
    summary: {
      totalSpans: 3,
      toolCalls: 1,
      policyDecisions: 0,
      failedOrBlocked: 0
    }
  };
}

function span(kind: TaskTrace["spans"][number]["kind"], name: string): TaskTrace["spans"][number] {
  return {
    id: name,
    taskId: "task-7",
    name,
    kind,
    status: "success",
    level: "info",
    message: name,
    startedAt: "2026-05-12T00:00:00.000Z",
    endedAt: "2026-05-12T00:00:00.000Z",
    durationMs: 0
  };
}
