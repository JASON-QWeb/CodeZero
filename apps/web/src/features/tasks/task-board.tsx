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
import type { Task, TaskTrace, TraceSpan } from "@agent/shared";
import { StatusPill } from "../../components/status-pill";
import { fetchMemories, fetchRepositoryQueues, fetchTasks, fetchTrace, updateMemoryStatus } from "./api";
import { mockMemories, mockTasks, mockTrace } from "./demo-data";
import { buildRepositorySummariesFromTasks } from "./repository-summary";
import { formatTime } from "./time";
import type { MemoryRecord, RepositoryQueueSummary } from "./types";

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
        <span>
          <strong>{repository.completedCount}</strong>
          Completed
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
