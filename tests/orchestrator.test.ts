import { describe, expect, it } from "vitest";
import {
  allQualityGatesPassed,
  canTransition,
  createDefaultWorkflowPlan,
  makeIssueBranchName,
  shouldRequirePrdReview
} from "@agent/orchestrator";
import type { IssueContext, QualityGateResult } from "@agent/shared";

const issue: IssueContext = {
  provider: "github",
  owner: "acme",
  repo: "shop",
  number: 42,
  url: "https://github.com/acme/shop/issues/42",
  title: "Fix refund status copy",
  body: "",
  labels: [],
  comments: [],
  baseBranch: "main"
};

describe("orchestrator", () => {
  it("keeps each issue on an isolated branch", () => {
    expect(makeIssueBranchName(issue)).toBe("agent/issue-42-fix-refund-status-copy");
  });

  it("requires PRD review for complex work", () => {
    expect(shouldRequirePrdReview({ score: 41, requiresHumanReview: false, reasons: [] })).toBe(true);
    expect(shouldRequirePrdReview({ score: 10, requiresHumanReview: true, reasons: ["security"] })).toBe(true);
  });

  it("models the quality gate before PR creation", () => {
    const plan = createDefaultWorkflowPlan();
    expect(plan.indexOf("quality-gates")).toBeLessThan(plan.indexOf("subagent-review"));
    expect(plan.indexOf("subagent-review")).toBeLessThan(plan.indexOf("create-draft-pr"));
    expect(canTransition("QUALITY_GATES_RUNNING", "SUBAGENT_REVIEWING")).toBe(true);
  });

  it("blocks PR creation when a quality gate fails", () => {
    const results: QualityGateResult[] = [
      { kind: "build", command: "npm run build", passed: true, exitCode: 0, durationMs: 100, output: "" },
      { kind: "lint", command: "npm run lint", passed: false, exitCode: 1, durationMs: 100, output: "lint failed" }
    ];

    expect(allQualityGatesPassed(results)).toBe(false);
  });
});

