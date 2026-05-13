"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Clock3,
  GitBranch,
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

type RepositoryQueueSummary = {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  configured: boolean;
  maxConcurrentIssues: number;
  runningCount: number;
  queuedCount: number;
  reviewCount: number;
  blockedCount: number;
  completedCount: number;
  totalCount: number;
  availableSlots: number;
  tasks: Task[];
};

type RepositoryQueuesResponse = {
  repositories: RepositoryQueueSummary[];
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

async function fetchRepositoryQueues(): Promise<RepositoryQueueSummary[]> {
  const response = await fetch(`${apiBaseUrl()}/tasks/repositories`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load repository queues");
  }

  const data = (await response.json()) as RepositoryQueuesResponse;
  return data.repositories;
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
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | undefined>();
  const { data, isError } = useQuery({
    queryKey: ["tasks"],
    queryFn: fetchTasks
  });
  const repositoryQuery = useQuery({
    queryKey: ["task-repositories"],
    queryFn: fetchRepositoryQueues
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
  const repositories = useMemo(() => (repositoryQuery.data?.length ? repositoryQuery.data : buildRepositorySummariesFromTasks(tasks)), [repositoryQuery.data, tasks]);
  const selectedRepository = repositories.find((repository) => repository.id === selectedRepositoryId) ?? repositories[0];
  const visibleTasks = useMemo(
    () => (selectedRepository ? tasks.filter((task) => task.issue.owner === selectedRepository.owner && task.issue.repo === selectedRepository.repo) : tasks),
    [selectedRepository, tasks]
  );
  const selectedTask = visibleTasks.find((task) => task.id === selectedTaskId) ?? visibleTasks[0];
  const fallbackTask = selectedTask ?? tasks[0] ?? mockTasks[0]!;
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
      active: repositories.reduce((sum, repository) => sum + repository.runningCount, 0),
      queued: repositories.reduce((sum, repository) => sum + repository.queuedCount, 0),
      review: repositories.reduce((sum, repository) => sum + repository.reviewCount, 0),
      blocked: repositories.reduce((sum, repository) => sum + repository.blockedCount, 0),
      proposedMemory: memories.length
    }),
    [memories.length, repositories]
  );

  useEffect(() => {
    if (!selectedRepositoryId && repositories[0]) {
      setSelectedRepositoryId(repositories[0].id);
    }
  }, [repositories, selectedRepositoryId]);

  useEffect(() => {
    if (visibleTasks.length > 0 && !visibleTasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(visibleTasks[0]?.id);
    }
  }, [selectedTaskId, visibleTasks]);

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
        <Metric icon={<Clock3 size={18} />} label="Queued" value={stats.queued} />
        <Metric icon={<ShieldCheck size={18} />} label="Review" value={stats.review} />
        <Metric icon={<AlertTriangle size={18} />} label="Blocked" value={stats.blocked} />
        <Metric icon={<Sparkles size={18} />} label="Memory Inbox" value={stats.proposedMemory} />
      </section>

      <section className="repositoryBoard" aria-label="Repository queues">
        <div className="sectionHeader">
          <div>
            <h2>Repositories</h2>
            <span>{repositoryQuery.isError ? "API offline, showing demo" : `${repositories.length} configured queues`}</span>
          </div>
          <GitBranch size={18} aria-hidden />
        </div>
        <div className="repositoryCards">
          {repositories.map((repository) => (
            <RepositoryCard
              key={repository.id}
              onSelect={() => {
                setSelectedRepositoryId(repository.id);
                setSelectedTaskId(repository.tasks[0]?.id);
              }}
              repository={repository}
              selected={repository.id === selectedRepository?.id}
            />
          ))}
        </div>
      </section>

      <section className="workspaceGrid" aria-label="Agent workspace">
        <section className="taskGrid" aria-label="Tasks">
          <div className="sectionHeader">
            <div>
              <h2>{selectedRepository?.fullName ?? "Tasks"}</h2>
              <span>
                {selectedRepository
                  ? `${selectedRepository.queuedCount} queued · ${selectedRepository.runningCount}/${selectedRepository.maxConcurrentIssues} running`
                  : `${visibleTasks.length} tracked issue workflows`}
              </span>
            </div>
            <RotateCcw size={18} aria-hidden />
          </div>
          {visibleTasks.length > 0 ? (
            visibleTasks.map((task) => (
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
            ))
          ) : (
            <EmptyState label="No queued issues" />
          )}
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

function RepositoryCard({
  onSelect,
  repository,
  selected
}: {
  onSelect: () => void;
  repository: RepositoryQueueSummary;
  selected: boolean;
}) {
  const utilization = repository.maxConcurrentIssues > 0 ? Math.min(100, Math.round((repository.runningCount / repository.maxConcurrentIssues) * 100)) : 0;

  return (
    <button className={`repositoryCard ${selected ? "repositoryCardSelected" : ""}`} onClick={onSelect} type="button">
      <div className="repositoryCardTopline">
        <strong>{repository.fullName}</strong>
        <span>{repository.configured ? "Configured" : "Unconfigured"}</span>
      </div>
      <div className="queueBar" aria-hidden>
        <span style={{ width: `${utilization}%` }} />
      </div>
      <div className="repositoryStats">
        <span>
          <strong>{repository.queuedCount}</strong>
          Queued
        </span>
        <span>
          <strong>
            {repository.runningCount}/{repository.maxConcurrentIssues}
          </strong>
          Running
        </span>
        <span>
          <strong>{repository.reviewCount}</strong>
          Review
        </span>
        <span>
          <strong>{repository.blockedCount}</strong>
          Blocked
        </span>
      </div>
    </button>
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

function buildRepositorySummariesFromTasks(tasks: Task[]): RepositoryQueueSummary[] {
  const summaries = new Map<string, RepositoryQueueSummary>();

  for (const task of tasks) {
    const key = `${task.issue.owner}/${task.issue.repo}`;
    const summary =
      summaries.get(key) ??
      ({
        id: key,
        owner: task.issue.owner,
        repo: task.issue.repo,
        fullName: key,
        configured: true,
        maxConcurrentIssues: task.issue.repo === "commerce" ? 2 : 1,
        runningCount: 0,
        queuedCount: 0,
        reviewCount: 0,
        blockedCount: 0,
        completedCount: 0,
        totalCount: 0,
        availableSlots: 0,
        tasks: []
      } satisfies RepositoryQueueSummary);

    summary.tasks.push(task);
    summary.totalCount += 1;

    if (isRunningStatus(task.status)) {
      summary.runningCount += 1;
    } else if (isQueuedStatus(task.status)) {
      summary.queuedCount += 1;
    } else if (["PRD_REVIEW_REQUIRED", "HUMAN_REVIEW"].includes(task.status)) {
      summary.reviewCount += 1;
    } else if (["BLOCKED", "FAILED"].includes(task.status)) {
      summary.blockedCount += 1;
    } else if (["DONE", "CANCELLED"].includes(task.status)) {
      summary.completedCount += 1;
    }

    summary.availableSlots = Math.max(0, summary.maxConcurrentIssues - summary.runningCount);
    summaries.set(key, summary);
  }

  return [...summaries.values()];
}

function isQueuedStatus(status: Task["status"]): boolean {
  return ["QUEUED", "ISSUE_RECEIVED", "PRD_APPROVED"].includes(status);
}

function isRunningStatus(status: Task["status"]): boolean {
  return [
    "CONTEXT_COLLECTING",
    "BRAINSTORMING",
    "PRD_DRAFTED",
    "SANDBOX_PREPARING",
    "ISSUE_BRANCH_CREATED",
    "CODEBASE_INDEXING",
    "AGENTIC_SEARCHING",
    "CONTEXT_PACK_CREATED",
    "IMPLEMENTING",
    "QUALITY_GATES_RUNNING",
    "SUBAGENT_REVIEWING",
    "PR_CREATING"
  ].includes(status);
}

function formatTime(value: string): string {
  const date = new Date(value);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()] ?? "Jan";
  return `${month} ${pad2(date.getUTCDate())}, ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
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
