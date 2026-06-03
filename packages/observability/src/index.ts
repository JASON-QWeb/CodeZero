import type {
  Artifact,
  Task,
  TaskEvent,
  TaskEventType,
  TaskTrace,
  TaskTraceReplay,
  TraceSpan,
  TraceSpanKind,
  TraceSpanStatus,
} from "@agent/shared";

export type BuildTaskTraceInput = {
  task: Task;
  events: TaskEvent[];
  artifacts: Artifact[];
};

export function buildTaskTrace(input: BuildTaskTraceInput): TaskTrace {
  const sortedEvents = [...input.events].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const rootSpan: TraceSpan = {
    id: `${input.task.id}:root`,
    taskId: input.task.id,
    name: `Task ${input.task.issue.owner}/${input.task.issue.repo}#${input.task.issue.number}`,
    kind: "workflow",
    status: taskStatusToTraceStatus(input.task.status),
    level:
      input.task.status === "FAILED"
        ? "error"
        : input.task.status === "BLOCKED"
          ? "warn"
          : "info",
    message: input.task.issue.title,
    startedAt: input.task.createdAt,
    endedAt: input.task.updatedAt,
    durationMs: durationMs(input.task.createdAt, input.task.updatedAt),
  };
  const spans = [
    rootSpan,
    ...sortedEvents.map((event) => eventToSpan(event, rootSpan.id)),
    ...input.artifacts.map((artifact) =>
      artifactToSpan(input.task, artifact, rootSpan.id),
    ),
  ].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const failedOrBlocked = spans.filter(
    (span) => span.status === "failed" || span.status === "blocked",
  ).length;

  return {
    taskId: input.task.id,
    status: input.task.status,
    issueUrl: input.task.issue.url,
    prUrl: input.task.prUrl,
    spans,
    artifacts: input.artifacts,
    summary: {
      totalSpans: spans.length,
      failedOrBlocked,
    },
  };
}

export function buildTaskTraceReplay(
  trace: TaskTrace,
  input: { cursor?: string; limit?: number } = {},
): TaskTraceReplay {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const startIndex = input.cursor
    ? Math.max(
        0,
        trace.spans.findIndex((span) => span.id === input.cursor) + 1,
      )
    : 0;
  const selectedSpans = trace.spans.slice(startIndex, startIndex + limit);
  const steps = selectedSpans.map((span, offset) =>
    spanToReplayStep(span, startIndex + offset),
  );
  const failedStep =
    [...trace.spans.slice(1), trace.spans[0]].filter(
      (span): span is TraceSpan => Boolean(span),
    )
      .map((span, index) => spanToReplayStep(span, index))
      .find((step) => step.status === "failed" || step.status === "blocked");
  const nextSpan = trace.spans[startIndex + selectedSpans.length];
  const previousSpan = startIndex > 0 ? trace.spans[startIndex - 1] : undefined;

  return {
    taskId: trace.taskId,
    status: trace.status,
    cursor: input.cursor,
    nextCursor: nextSpan ? selectedSpans.at(-1)?.id : undefined,
    previousCursor: previousSpan?.id,
    steps,
    failedStep,
    resumeActions: replayResumeActions(trace, failedStep),
    summary: {
      ...trace.summary,
      replayedSpans: startIndex + selectedSpans.length,
      remainingSpans: Math.max(
        0,
        trace.spans.length - startIndex - selectedSpans.length,
      ),
    },
  };
}

function spanToReplayStep(span: TraceSpan, index: number): TaskTraceReplay["steps"][number] {
  return {
    cursor: span.id,
    spanId: span.id,
    parentId: span.parentId,
    index,
    name: span.name,
    kind: span.kind,
    status: span.status,
    message: span.message,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    durationMs: span.durationMs,
    metadata: span.metadata,
    canResumeFromHere:
      span.kind === "human" ||
      span.kind === "error" ||
      span.status === "failed" ||
      span.status === "blocked",
  };
}

function replayResumeActions(
  trace: TaskTrace,
  failedStep: TaskTraceReplay["failedStep"],
): TaskTraceReplay["resumeActions"] {
  return [
    {
      type: "approve_prd",
      label: "Approve pending PRD and resume graph",
      available: trace.status === "PRD_REVIEW_REQUIRED",
    },
    {
      type: "retry_workflow",
      label: "Retry workflow from latest durable checkpoint",
      available:
        trace.status === "FAILED" ||
        trace.status === "BLOCKED" ||
        Boolean(failedStep),
    },
    {
      type: "inspect_failure",
      label: "Inspect failed or blocked replay step",
      available: Boolean(failedStep),
    },
    {
      type: "open_pr",
      label: "Open draft pull request",
      available: Boolean(trace.prUrl),
    },
  ];
}

function eventToSpan(event: TaskEvent, parentId: string): TraceSpan {
  return {
    id: event.id,
    taskId: event.taskId,
    parentId,
    name: event.type,
    kind: eventKind(event.type),
    status: eventStatus(event),
    level: event.level,
    message: event.message,
    startedAt: event.createdAt,
    endedAt: event.createdAt,
    durationMs: 0,
    metadata: event.metadata,
  };
}

function artifactToSpan(
  task: Task,
  artifact: Artifact,
  parentId: string,
): TraceSpan {
  return {
    id: artifact.id,
    taskId: task.id,
    parentId,
    name: `artifact:${artifact.type}`,
    kind: "artifact",
    status: "success",
    level: "info",
    message: artifact.path ?? artifact.url ?? artifact.type,
    startedAt: artifact.createdAt,
    endedAt: artifact.createdAt,
    durationMs: 0,
    metadata: artifact.metadata,
  };
}

function eventKind(type: TaskEventType): TraceSpanKind {
  if (
    type.startsWith("AGENT_RUN") ||
    type === "PRD_DRAFTED" ||
    type === "SUBAGENT_REVIEW_FINISHED"
  ) {
    return "model";
  }

  if (type.startsWith("QUALITY_GATE") || type === "SCREENSHOT_CAPTURED") {
    return "quality_gate";
  }

  if (
    type === "REPO_NAVIGATION_GRAPH_CREATED" ||
    type === "NAVIGATION_ROUTE_CREATED" ||
    type === "AGENTIC_SEARCH_FINISHED"
  ) {
    return "navigation";
  }

  if (type === "MEMORY_RETRIEVED" || type === "MEMORY_PROPOSAL_CREATED") {
    return "memory";
  }

  if (
    type === "PR_CREATED" ||
    type === "PR_UPDATED" ||
    type === "PR_REVIEW_COMMENT_RECEIVED" ||
    type === "TASK_COMPLETED" ||
    type === "REPO_CLONED" ||
    type === "ISSUE_BRANCH_CREATED"
  ) {
    return "github";
  }

  if (type === "HUMAN_REVIEW_REQUIRED" || type === "PRD_APPROVED") {
    return "human";
  }

  if (type === "TASK_FAILED" || type === "TASK_BLOCKED") {
    return "error";
  }

  return "workflow";
}

function eventStatus(event: TaskEvent): TraceSpanStatus {
  if (event.level === "error" || event.type === "TASK_FAILED") {
    return "failed";
  }

  if (
    event.level === "warn" ||
    event.type === "TASK_BLOCKED" ||
    event.type === "HUMAN_REVIEW_REQUIRED"
  ) {
    return "blocked";
  }

  return "success";
}

function taskStatusToTraceStatus(status: Task["status"]): TraceSpanStatus {
  if (status === "FAILED") {
    return "failed";
  }

  if (
    status === "BLOCKED" ||
    status === "PRD_REVIEW_REQUIRED" ||
    status === "HUMAN_REVIEW" ||
    status === "WAITING_MERGE"
  ) {
    return "blocked";
  }

  if (status === "DONE") {
    return "success";
  }

  if (status === "QUEUED" || status === "ISSUE_RECEIVED") {
    return "info";
  }

  return "running";
}

function durationMs(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}
