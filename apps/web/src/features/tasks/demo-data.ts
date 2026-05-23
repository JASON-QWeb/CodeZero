import type { Task, TaskTrace, TraceSpan, TraceSpanKind } from "@agent/shared";
import type { MemoryRecord } from "./types";

const demoTimestamp = "2026-05-12T10:00:00.000Z";

export const mockTasks: Task[] = [
  {
    id: "task-demo-128",
    issue: {
      provider: "github",
      owner: "demo",
      repo: "commerce",
      number: 128,
      url: "https://github.com/demo/commerce/issues/128",
      title: "Fix refund status copy on order detail",
      body: "",
      labels: ["frontend"],
      comments: [],
      baseBranch: "main"
    },
    status: "SUBAGENT_REVIEWING",
    branchName: "agent/issue-128-fix-refund-status-copy",
    prUrl: "https://github.com/demo/commerce/pull/129",
    createdAt: demoTimestamp,
    updatedAt: demoTimestamp
  },
  {
    id: "task-demo-129",
    issue: {
      provider: "github",
      owner: "demo",
      repo: "commerce",
      number: 129,
      url: "https://github.com/demo/commerce/issues/129",
      title: "Add checkout rate limit copy",
      body: "",
      labels: ["backend"],
      comments: [],
      baseBranch: "main"
    },
    status: "QUEUED",
    branchName: "agent/issue-129-add-checkout-rate-limit-copy",
    createdAt: demoTimestamp,
    updatedAt: demoTimestamp
  },
  {
    id: "task-demo-42",
    issue: {
      provider: "github",
      owner: "demo",
      repo: "billing",
      number: 42,
      url: "https://github.com/demo/billing/issues/42",
      title: "Tighten invoice export validation",
      body: "",
      labels: ["fullstack"],
      comments: [],
      baseBranch: "main"
    },
    status: "PRD_REVIEW_REQUIRED",
    branchName: "agent/issue-42-tighten-invoice-export-validation",
    createdAt: demoTimestamp,
    updatedAt: demoTimestamp
  }
];

export const mockMemories: MemoryRecord[] = [
  {
    id: "memory-demo-procedure",
    kind: "procedural",
    status: "proposed",
    scope: "repository",
    owner: "demo",
    repo: "commerce",
    title: "Verification recipe from #128",
    content: "Use pnpm lint, pnpm typecheck, pnpm test and a focused UI screenshot before opening similar frontend PRs.",
    tags: ["verification", "frontend", "quality-gates"],
    confidence: 0.82,
    sourceTaskId: "task-demo-128",
    createdAt: demoTimestamp,
    updatedAt: demoTimestamp
  }
];

export function mockTrace(task: Task): TaskTrace {
  const now = new Date().toISOString();
  const span = (kind: TraceSpanKind, name: string, message: string, status: TraceSpan["status"] = "success"): TraceSpan => ({
    id: `demo-${kind}-${name}`,
    taskId: task.id,
    name,
    kind,
    status,
    level: status === "failed" || status === "blocked" ? "warn" : "info",
    message,
    startedAt: now,
    endedAt: now,
    durationMs: 0
  });

  const spans = [
    span("workflow", "Issue received", "Task created from GitHub issue"),
    span("navigation", "Navigation route", "Repo graph selected entrypoints and related tests"),
    span("memory", "Memory retrieved", "Approved procedural memory injected into ContextPack"),
    span("tool", "Patch applied", "Tool Gateway executed repo.apply_patch"),
    span("policy", "Policy check", "Path and command policy allowed the change"),
    span("quality_gate", "Quality gates", "lint, typecheck and tests passed")
  ];

  return {
    taskId: task.id,
    status: task.status,
    issueUrl: task.issue.url,
    prUrl: task.prUrl,
    spans,
    artifacts: [],
    summary: {
      totalSpans: spans.length,
      toolCalls: 1,
      policyDecisions: 1,
      failedOrBlocked: 0
    }
  };
}
