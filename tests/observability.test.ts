import { describe, expect, it } from "vitest";
import { buildTaskTrace } from "@agent/observability";
import { createTask } from "@agent/orchestrator";
import { createTaskEvent } from "@agent/persistence";
import type { Artifact, IssueContext } from "@agent/shared";

const issue: IssueContext = {
  provider: "github",
  owner: "acme",
  repo: "shop",
  number: 9,
  url: "https://github.com/acme/shop/issues/9",
  title: "Fix refund status",
  body: "",
  labels: [],
  comments: [],
  baseBranch: "main"
};

describe("observability trace", () => {
  it("builds replayable spans from task events and artifacts", () => {
    const task = createTask(issue, new Date("2026-05-12T00:00:00.000Z"));
    const events = [
      createTaskEvent({ taskId: task.id, type: "TASK_CREATED", message: "created" }),
      createTaskEvent({
        taskId: task.id,
        type: "TOOL_CALL_FINISHED",
        message: "Tool shell.run finished with success",
        metadata: { toolName: "shell.run", status: "success" }
      }),
      createTaskEvent({
        taskId: task.id,
        type: "POLICY_DECISION",
        level: "warn",
        message: "Policy audit-database-migrations returned require_approval"
      }),
      createTaskEvent({
        taskId: task.id,
        type: "MEMORY_RETRIEVED",
        message: "Retrieved 1 approved memory record"
      })
    ];
    const artifacts: Artifact[] = [
      {
        id: "artifact-tool",
        taskId: task.id,
        type: "tool-call",
        path: "/tmp/tool-call.json",
        createdAt: "2026-05-12T00:00:03.000Z"
      }
    ];
    const trace = buildTaskTrace({ task, events, artifacts });

    expect(trace.summary.toolCalls).toBe(1);
    expect(trace.summary.policyDecisions).toBe(1);
    expect(trace.spans.map((span) => span.kind)).toContain("artifact");
    expect(trace.spans.map((span) => span.kind)).toContain("memory");
    expect(trace.spans.find((span) => span.kind === "policy")?.status).toBe("blocked");
  });
});
