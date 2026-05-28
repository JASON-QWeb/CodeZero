import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentPrBody,
  createPrLocalVerificationPlan,
  detectIssueLocale,
  detectInstallCommand,
  validateAgentPrBodyCompleteness,
} from "../packages/workflows/src/pr-local-verification";
import type { QualityGateResult, Task } from "@agent/shared";

const qualityGateResults: QualityGateResult[] = [
  {
    kind: "build",
    command: "pnpm build",
    passed: true,
    exitCode: 0,
    durationMs: 1200,
    output: "",
  },
  {
    kind: "unit_test",
    command: "pnpm test",
    passed: true,
    exitCode: 0,
    durationMs: 900,
    output: "",
  },
];

const task: Task = {
  id: "task-acme-shop-7",
  issue: {
    provider: "github",
    owner: "acme",
    repo: "shop",
    number: 7,
    url: "https://github.com/acme/shop/issues/7",
    title: "Fix refund status copy",
    body: "Refund status copy is wrong.",
    labels: ["frontend"],
    comments: [],
    baseBranch: "main",
  },
  status: "PR_CREATING",
  qualityGateResults,
  planningDocument: {
    title: "Fix refund status copy",
    background: "The order detail page renders outdated refund text.",
    goals: ["Show the correct refund status copy on the order detail page."],
    nonGoals: [],
    userStories: [],
    acceptanceCriteria: ["Refund status copy matches the service state."],
    risks: [],
    unknowns: [],
    taskType: "frontend",
    complexity: { score: 20, requiresHumanReview: false, reasons: [] },
    implementationPlan: {
      goal: "Update refund status copy.",
      acceptanceCriteria: ["Refund status copy matches the service state."],
      filesToRead: ["src/orders/detail.tsx"],
      filesExpectedToChange: ["src/orders/detail.tsx"],
      testsToAddOrUpdate: ["src/orders/detail.test.tsx"],
      commandsToRun: ["pnpm test"],
      explicitNonGoals: [],
      riskNotes: [],
    },
  },
  reviewResult: {
    approved: true,
    blockingFindings: [],
    nonBlockingFindings: [],
    missingTests: [],
    scopeViolations: [],
    riskLevel: "low",
    prDescriptionNotes: ["Focused change with passing checks."],
  },
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
};

describe("PR local verification", () => {
  it("detects deterministic install commands from repo files", async () => {
    const repoDir = await mkdtemp(
      path.join(os.tmpdir(), "agent-pr-verification-"),
    );
    await writeFile(
      path.join(repoDir, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );

    await expect(detectInstallCommand(repoDir)).resolves.toBe(
      "pnpm install --frozen-lockfile",
    );
  });

  it("renders GitHub CLI and plain Git verification commands into the PR body", () => {
    const verification = createPrLocalVerificationPlan({
      owner: "acme",
      repo: "shop",
      baseBranch: "main",
      baseSha: "abc123",
      agentBranch: "agent/issue-7-fix-refund-status-copy",
      installCommand: "pnpm install --frozen-lockfile",
      qualityGateResults,
      devCommand: "pnpm dev",
      screenshotArtifacts: [
        {
          path: "/tmp/order-detail-desktop.png",
          metadata: {
            url: "http://localhost:3000/orders/7",
            viewport: "desktop",
          },
        },
      ],
      sandbox: { mode: "docker", image: "agent-sandbox-node:latest" },
    });
    const body = createAgentPrBody({ task, verification });

    expect(verification.commands.githubCli).toContain(
      "gh pr checkout agent/issue-7-fix-refund-status-copy",
    );
    expect(verification.commands.plainGit).toContain(
      "git fetch origin agent/issue-7-fix-refund-status-copy",
    );
    expect(body).toContain("## Local Verification");
    expect(body).toContain("## PR Content Completeness Check");
    expect(body).toContain("### Frontend Screenshot Verification");
    expect(body).toContain("pnpm install --frozen-lockfile");
    expect(body).toContain("pnpm build");
    expect(body).toContain("Base commit: abc123");
    expect(body).toContain(
      "http://localhost:3000/orders/7 desktop: /tmp/order-detail-desktop.png",
    );
  });

  it("localizes PR text and embeds public screenshot URLs as images", () => {
    const chineseTask: Task = {
      ...task,
      issue: {
        ...task.issue,
        title: "优化首页卡片",
        body: "请把首页卡片间距调小一点。",
      },
      planningDocument: {
        ...task.planningDocument!,
        goals: ["首页卡片间距更紧凑。"],
      },
    };
    const verification = createPrLocalVerificationPlan({
      owner: "acme",
      repo: "shop",
      baseBranch: "main",
      baseSha: "abc123",
      agentBranch: "agent/issue-8-home-card",
      qualityGateResults,
      screenshotArtifacts: [
        {
          url: "https://raw.githubusercontent.com/acme/shop/refs/heads/agent/issue-8-home-card/.agent/screenshots/issue-8/01-desktop.png",
          metadata: { url: "http://localhost:3000", viewport: "desktop" },
        },
      ],
    });
    const body = createAgentPrBody({ task: chineseTask, verification });

    expect(detectIssueLocale(chineseTask.issue)).toBe("zh");
    expect(body).toContain("## 摘要");
    expect(body).toContain("## PR 内容完整性检查");
    expect(body).toContain("## 质量门禁");
    expect(body).toContain(
      "![http://localhost:3000 desktop](https://raw.githubusercontent.com/acme/shop/refs/heads/agent/issue-8-home-card/.agent/screenshots/issue-8/01-desktop.png)",
    );
    expect(
      validateAgentPrBodyCompleteness({
        task: chineseTask,
        verification,
        body,
      }),
    ).toEqual({ passed: true, errors: [] });
  });

  it("defaults unknown or empty issue language to Chinese but keeps English issues in English", () => {
    expect(
      detectIssueLocale({ ...task.issue, title: "", body: "", comments: [] }),
    ).toBe("zh");
    expect(detectIssueLocale(task.issue)).toBe("en");
  });

  it("fails PR content completeness when screenshot artifacts are not embedded images", () => {
    const verification = createPrLocalVerificationPlan({
      owner: "acme",
      repo: "shop",
      baseBranch: "main",
      baseSha: "abc123",
      agentBranch: "agent/issue-7-fix-refund-status-copy",
      qualityGateResults,
      screenshotArtifacts: [
        {
          path: "/tmp/order-detail-desktop.png",
          metadata: {
            url: "http://localhost:3000/orders/7",
            viewport: "desktop",
          },
        },
      ],
    });
    const body = createAgentPrBody({ task, verification });

    expect(
      validateAgentPrBodyCompleteness({ task, verification, body }).passed,
    ).toBe(false);
  });
});
