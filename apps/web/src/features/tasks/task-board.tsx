"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Clock3,
  GitPullRequestDraft,
  ListChecks,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Task, TaskTrace, TraceSpan, TraceSpanKind } from "@agent/shared";
import { StatusPill } from "../../components/status-pill";

type TasksResponse = {
  tasks: Task[];
};

type TraceResponse = {
  trace: TaskTrace;
};

type MemoryStatus = "proposed" | "approved" | "rejected";

type MemoryRecord = {
  id: string;
  kind: "semantic" | "episodic" | "procedural" | "policy";
  status: MemoryStatus;
  scope: "repository" | "global";
  owner?: string;
  repo?: string;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  sourceTaskId?: string;
  createdAt: string;
  updatedAt: string;
};

type MemoriesResponse = {
  memories: MemoryRecord[];
};

const demoTimestamp = "2026-05-12T10:00:00.000Z";

const mockTasks: Task[] = [
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
  }
];

const mockMemories: MemoryRecord[] = [
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

const apiBaseUrl = () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function fetchTasks(): Promise<Task[]> {
  const response = await fetch(`${apiBaseUrl()}/tasks`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load tasks");
  }

  const data = (await response.json()) as TasksResponse;
  return data.tasks;
}

async function fetchTrace(taskId: string): Promise<TaskTrace> {
  const response = await fetch(`${apiBaseUrl()}/tasks/${taskId}/trace`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load task trace");
  }

  const data = (await response.json()) as TraceResponse;
  return data.trace;
}

async function fetchMemories(status: MemoryStatus): Promise<MemoryRecord[]> {
  const response = await fetch(`${apiBaseUrl()}/memories?status=${status}`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load memories");
  }

  const data = (await response.json()) as MemoriesResponse;
  return data.memories;
}

async function updateMemoryStatus(input: { id: string; status: Extract<MemoryStatus, "approved" | "rejected"> }): Promise<MemoryRecord> {
  const response = await fetch(`${apiBaseUrl()}/memories/${input.id}/${input.status === "approved" ? "approve" : "reject"}`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error("Failed to update memory");
  }

  return ((await response.json()) as { memory: MemoryRecord }).memory;
}

export function TaskBoard() {
  const queryClient = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const { data, isError } = useQuery({
    queryKey: ["tasks"],
    queryFn: fetchTasks
  });
  const memoryQuery = useQuery({
    queryKey: ["memories", "proposed"],
    queryFn: () => fetchMemories("proposed")
  });
  const memoryMutation = useMutation({
    mutationFn: updateMemoryStatus,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memories"] });
    }
  });

  const hasLiveTasks = Boolean(data?.length);
  const tasks: Task[] = data?.length ? data : mockTasks;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const fallbackTask = selectedTask ?? mockTasks[0]!;
  const hasLiveMemories = Boolean(memoryQuery.data?.length);
  const memories: MemoryRecord[] = memoryQuery.data?.length ? memoryQuery.data : mockMemories;
  const traceQuery = useQuery({
    queryKey: ["task-trace", selectedTask?.id],
    queryFn: () => fetchTrace(selectedTask?.id ?? ""),
    enabled: Boolean(hasLiveTasks && selectedTask?.id)
  });
  const trace = traceQuery.data ?? mockTrace(fallbackTask);
  const stats = useMemo(
    () => ({
      active: tasks.filter((task) => !["DONE", "BLOCKED", "FAILED", "CANCELLED"].includes(task.status)).length,
      review: tasks.filter((task) => ["PRD_REVIEW_REQUIRED", "SUBAGENT_REVIEWING", "HUMAN_REVIEW"].includes(task.status)).length,
      blocked: tasks.filter((task) => ["BLOCKED", "FAILED"].includes(task.status)).length,
      proposedMemory: memories.length
    }),
    [memories.length, tasks]
  );

  useEffect(() => {
    if (!selectedTaskId && tasks[0]) {
      setSelectedTaskId(tasks[0].id);
    }
  }, [selectedTaskId, tasks]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Agent PRD Automation</p>
          <h1>Run Console</h1>
        </div>
        <div className="health">
          <Activity size={18} aria-hidden />
          <span>{isError ? "API offline" : "Live"}</span>
        </div>
      </header>

      <section className="metrics" aria-label="Task metrics">
        <Metric icon={<Search size={18} />} label="Active" value={stats.active} />
        <Metric icon={<ShieldCheck size={18} />} label="Review" value={stats.review} />
        <Metric icon={<AlertTriangle size={18} />} label="Blocked" value={stats.blocked} />
        <Metric icon={<Sparkles size={18} />} label="Memory Inbox" value={stats.proposedMemory} />
      </section>

      <section className="workspaceGrid" aria-label="Agent workspace">
        <section className="taskGrid" aria-label="Tasks">
          <div className="sectionHeader">
            <div>
              <h2>Tasks</h2>
              <span>{tasks.length} tracked issue workflows</span>
            </div>
            <RotateCcw size={18} aria-hidden />
          </div>
          {tasks.map((task) => (
            <button
              className={`taskRow ${task.id === selectedTask?.id ? "taskRowSelected" : ""}`}
              key={task.id}
              onClick={() => setSelectedTaskId(task.id)}
              type="button"
            >
              <div className="issueCell">
                <span className="issueTitle">
                  #{task.issue.number} {task.issue.title}
                </span>
                <span>
                  {task.issue.owner}/{task.issue.repo} · base {task.issue.baseBranch}
                </span>
              </div>
              <StatusPill status={task.status} />
              <div className="branchCell">
                <GitPullRequestDraft size={16} aria-hidden />
                <span>{task.branchName ?? "branch pending"}</span>
              </div>
            </button>
          ))}
        </section>

        <section className="detailPanel" aria-label="Selected task details">
          {selectedTask ? <TaskDetail task={selectedTask} trace={trace} traceLoading={traceQuery.isLoading} /> : <EmptyState label="No task selected" />}
        </section>

        <section className="memoryPanel" aria-label="Memory approval inbox">
          <div className="sectionHeader">
            <div>
              <h2>Memory Inbox</h2>
              <span>{memoryQuery.isError ? "API offline, showing demo" : "Approve before reuse"}</span>
            </div>
            <ListChecks size={18} aria-hidden />
          </div>

          <div className="memoryList">
            {memories.map((memory) => (
              <article className="memoryItem" key={memory.id}>
                <div className="memoryMeta">
                  <span>{memory.kind}</span>
                  <span>{memory.scope === "repository" ? `${memory.owner}/${memory.repo}` : "global"}</span>
                  <span>{Math.round(memory.confidence * 100)}%</span>
                </div>
                <h3>{memory.title}</h3>
                <p>{memory.content}</p>
                <div className="tagList">
                  {memory.tags.slice(0, 4).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                <div className="memoryActions">
                  <button
                    className="iconButton positive"
                    disabled={memoryMutation.isPending || !hasLiveMemories}
                    onClick={() => memoryMutation.mutate({ id: memory.id, status: "approved" })}
                    title="Approve memory"
                    type="button"
                  >
                    <Check size={16} aria-hidden />
                    <span>Approve</span>
                  </button>
                  <button
                    className="iconButton danger"
                    disabled={memoryMutation.isPending || !hasLiveMemories}
                    onClick={() => memoryMutation.mutate({ id: memory.id, status: "rejected" })}
                    title="Reject memory"
                    type="button"
                  >
                    <X size={16} aria-hidden />
                    <span>Reject</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="metric">
      <div className="metricIcon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function TaskDetail({ task, trace, traceLoading }: { task: Task; trace: TaskTrace; traceLoading: boolean }) {
  return (
    <>
      <div className="detailHeader">
        <div>
          <p className="eyebrow">Selected Run</p>
          <h2>
            #{task.issue.number} {task.issue.title}
          </h2>
          <span>
            {task.issue.owner}/{task.issue.repo} · updated {formatTime(task.updatedAt)}
          </span>
        </div>
        <StatusPill status={task.status} />
      </div>

      <div className="linkRow">
        <a href={task.issue.url} target="_blank" rel="noreferrer">
          Issue
        </a>
        {task.prUrl ? (
          <a href={task.prUrl} target="_blank" rel="noreferrer">
            Draft PR
          </a>
        ) : null}
        <span>{task.branchName ?? "branch pending"}</span>
      </div>

      <div className="traceSummary" aria-label="Trace summary">
        <TraceMetric label="Spans" value={trace.summary.totalSpans} />
        <TraceMetric label="Tools" value={trace.summary.toolCalls} />
        <TraceMetric label="Policies" value={trace.summary.policyDecisions} />
        <TraceMetric label="Blocked" value={trace.summary.failedOrBlocked} />
      </div>

      <div className="sectionHeader compact">
        <div>
          <h2>Trace Replay</h2>
          <span>{traceLoading ? "Loading trace" : `${trace.spans.length} spans from issue to PR`}</span>
        </div>
        <Clock3 size={18} aria-hidden />
      </div>

      <ol className="traceTimeline">
        {trace.spans.map((span) => (
          <TraceRow key={span.id} span={span} />
        ))}
      </ol>
    </>
  );
}

function TraceMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TraceRow({ span }: { span: TraceSpan }) {
  return (
    <li className={`traceRow trace-${span.kind}`}>
      <div className="traceMarker" aria-hidden />
      <div>
        <div className="traceTopline">
          <strong>{span.name}</strong>
          <span>{span.kind.replaceAll("_", " ")}</span>
        </div>
        <p>{span.message}</p>
      </div>
      <span className={`traceStatus status-${span.status}`}>{span.status}</span>
    </li>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="emptyState">{label}</div>;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function mockTrace(task: Task): TaskTrace {
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
