import { describe, expect, it } from "vitest";
import { buildTaskTrace, buildTaskTraceReplay } from "@agent/observability";
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
        type: "AGENT_RUN_FINISHED",
        message: "Implementation executor finished with success",
        metadata: { executor: "opencode", status: "success" }
      }),
      createTaskEvent({
        taskId: task.id,
        type: "QUALITY_GATE_FINISHED",
        message: "Quality gates passed"
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

    expect(trace.spans.map((span) => span.kind)).toContain("artifact");
    expect(trace.spans.map((span) => span.kind)).toContain("model");
    expect(trace.spans.map((span) => span.kind)).toContain("quality_gate");
    expect(trace.spans.map((span) => span.kind)).toContain("memory");
    expect(trace.summary.failedOrBlocked).toBe(0);
  });

  it("builds a cursor-based trace replay with resume actions", () => {
    const task = { ...createTask(issue), status: "PRD_REVIEW_REQUIRED" as const };
    const trace = buildTaskTrace({
      task,
      events: [
        createTaskEvent({ taskId: task.id, type: "TASK_CREATED", message: "created" }),
        createTaskEvent({
          taskId: task.id,
          type: "HUMAN_REVIEW_REQUIRED",
          level: "warn",
          message: "PRD requires approval"
        })
      ],
      artifacts: []
    });
    const replay = buildTaskTraceReplay(trace, { limit: 1 });

    expect(replay.steps).toHaveLength(1);
    expect(replay.nextCursor).toBe(replay.steps[0]?.spanId);
    expect(replay.failedStep?.kind).toBe("human");
    expect(replay.resumeActions.find((action) => action.type === "approve_prd")?.available).toBe(true);
  });
});
