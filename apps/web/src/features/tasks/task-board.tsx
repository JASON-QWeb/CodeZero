"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Clock3,
  ExternalLink,
  GitBranch,
  GitPullRequestDraft,
  Languages,
  ListChecks,
  Network,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Task, TaskTrace, TraceSpan } from "@agent/shared";
import { StatusPill } from "../../components/status-pill";
import {
  fetchMemories,
  fetchProjectKnowledgeGraph,
  fetchRepositoryQueues,
  fetchTasks,
  fetchTrace,
  generateProjectKnowledgeGraph,
  openProjectKnowledgeGraphDashboard,
  updateMemoryStatus
} from "./api";
import { mockMemories, mockTasks, mockTrace } from "./demo-data";
import { buildRepositorySummariesFromTasks } from "./repository-summary";
import { formatTime } from "./time";
import type { MemoryRecord, ProjectKnowledgeGraph, RepositoryQueueSummary } from "./types";

type Locale = "zh" | "en";

const text = {
  zh: {
    active: "运行中",
    agentWorkspace: "机器人工作区",
    apiOffline: "API 离线",
    approve: "批准",
    approveBeforeReuse: "复用前审批",
    blocked: "阻塞",
    branchPending: "分支待创建",
    codeGraph: "Code Graph / 代码图",
    codeGraphDisabled: "尚未看到 CodeGraph 产物。任务进入代码建图阶段后会显示索引、上下文和导航图产物。",
    codeGraphHint: "展示机器人用于理解仓库的本地 CodeGraph、Repo Navigation Graph 和 ContextPack。",
    completed: "完成",
    configured: "已配置",
    configuredQueues: (count: number) => `${count} 个已配置队列`,
    connectApi: "连接 API 后可生成并打开项目图谱。",
    draftPr: "Draft PR",
    generatedArtifacts: "已生成产物",
    generateGraph: "生成知识图谱",
    generating: "生成中",
    graphFailed: "失败",
    graphMissing: "未生成",
    graphOverview: "图谱总览",
    graphReady: "已就绪",
    issue: "Issue",
    knowledgeGraph: "Knowledge Graph / 知识图谱",
    knowledgeGraphHint: "由 Understand-Anything 官方分析和 dashboard 驱动",
    language: "语言",
    live: "在线",
    loading: "加载中",
    loadingTrace: "加载 trace",
    memoryInbox: "记忆审批",
    noQueuedIssues: "没有排队 Issue",
    noTaskSelected: "未选择任务",
    officialDashboardViewer: "官方 dashboard 视图",
    openDashboard: "打开 Dashboard",
    nextPage: "下一页",
    policies: "策略",
    previousPage: "上一页",
    project: "项目",
    queued: "排队",
    regenerate: "重新生成",
    reject: "拒绝",
    repositories: "仓库",
    repositoryQueues: "仓库队列",
    review: "Review",
    running: "运行",
    selectedRun: "选中运行",
    settingsDemo: "API 离线，显示示例",
    spansFromIssueToPr: (count: number) => `${count} 个 span，覆盖 Issue 到 PR`,
    starting: "启动中",
    taskMetrics: "任务指标",
    tasks: "任务",
    tools: "工具",
    traceReplay: "Trace 回放",
    tracePage: (page: number, pageCount: number) => `第 ${page}/${pageCount} 页`,
    trackedIssueWorkflows: (count: number) => `${count} 个已跟踪 Issue workflow`,
    unavailable: "不可用",
    unconfigured: "未配置",
    updated: "更新于",
    viewFullDetails: "查看完整详情"
  },
  en: {
    active: "Active",
    agentWorkspace: "Agent workspace",
    apiOffline: "API offline",
    approve: "Approve",
    approveBeforeReuse: "Approve before reuse",
    blocked: "Blocked",
    branchPending: "branch pending",
    codeGraph: "Code Graph",
    codeGraphDisabled: "No CodeGraph artifact is available yet. Index, context and navigation artifacts appear after the task reaches codebase indexing.",
    codeGraphHint: "Shows the local CodeGraph, Repo Navigation Graph and ContextPack the agent uses to understand the repository.",
    completed: "Completed",
    configured: "Configured",
    configuredQueues: (count: number) => `${count} configured queues`,
    connectApi: "Connect the API to generate and open project graphs.",
    draftPr: "Draft PR",
    generatedArtifacts: "Generated artifacts",
    generateGraph: "Generate Graph",
    generating: "Generating",
    graphFailed: "Failed",
    graphMissing: "Missing",
    graphOverview: "Graph Overview",
    graphReady: "Ready",
    issue: "Issue",
    knowledgeGraph: "Knowledge Graph",
    knowledgeGraphHint: "Powered by Understand-Anything official analysis and dashboard",
    language: "Language",
    live: "Live",
    loading: "Loading",
    loadingTrace: "Loading trace",
    memoryInbox: "Memory Inbox",
    noQueuedIssues: "No queued issues",
    noTaskSelected: "No task selected",
    officialDashboardViewer: "Official dashboard viewer",
    openDashboard: "Open Dashboard",
    nextPage: "Next",
    policies: "Policies",
    previousPage: "Previous",
    project: "Project",
    queued: "Queued",
    regenerate: "Regenerate",
    reject: "Reject",
    repositories: "Repositories",
    repositoryQueues: "Repository queues",
    review: "Review",
    running: "Running",
    selectedRun: "Selected Run",
    settingsDemo: "API offline, showing demo",
    spansFromIssueToPr: (count: number) => `${count} spans from issue to PR`,
    starting: "Starting",
    taskMetrics: "Task metrics",
    tasks: "Tasks",
    tools: "Tools",
    traceReplay: "Trace Replay",
    tracePage: (page: number, pageCount: number) => `Page ${page} of ${pageCount}`,
    trackedIssueWorkflows: (count: number) => `${count} tracked issue workflows`,
    unavailable: "Unavailable",
    unconfigured: "Unconfigured",
    updated: "updated",
    viewFullDetails: "View full details"
  }
};

export function TaskBoard() {
  const queryClient = useQueryClient();
  const [locale, setLocale] = useState<Locale>("zh");
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | undefined>();
  const t = text[locale];
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
  const hasLiveRepositories = Boolean(repositoryQuery.data?.length);
  const graphQuery = useQuery({
    queryKey: ["repository-knowledge-graph", selectedRepository?.id],
    queryFn: () => fetchProjectKnowledgeGraph(selectedRepository?.id ?? ""),
    enabled: Boolean(hasLiveRepositories && selectedRepository?.configured),
    refetchInterval: (query) => (query.state.data?.status === "generating" ? 3000 : false)
  });
  const graphGenerationMutation = useMutation({
    mutationFn: generateProjectKnowledgeGraph,
    onSuccess: (knowledgeGraph) => {
      queryClient.setQueryData(["repository-knowledge-graph", knowledgeGraph.repositoryId], knowledgeGraph);
    }
  });
  const dashboardMutation = useMutation({
    mutationFn: openProjectKnowledgeGraphDashboard,
    onSuccess: (knowledgeGraph) => {
      queryClient.setQueryData(["repository-knowledge-graph", knowledgeGraph.repositoryId], knowledgeGraph);
    }
  });
  const visibleTasks = useMemo(
    () => (selectedRepository ? tasks.filter((task) => task.issue.owner === selectedRepository.owner && task.issue.repo === selectedRepository.repo) : tasks),
    [selectedRepository, tasks]
  );
  const selectedTask = visibleTasks.find((task) => task.id === selectedTaskId) ?? visibleTasks[0];
  const fallbackTask = selectedTask ?? tasks[0] ?? mockTasks[0]!;
  const hasLiveMemories = Array.isArray(memoryQuery.data);
  const memories: MemoryRecord[] = Array.isArray(memoryQuery.data) ? memoryQuery.data : mockMemories;
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
    const saved = window.localStorage.getItem("agent-dashboard-locale");
    if (saved === "zh" || saved === "en") {
      setLocale(saved);
    }
  }, []);

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
          <h1>{locale === "zh" ? "运行看板" : "Run Console"}</h1>
        </div>
        <div className="topbarActions">
          <label className="languageSwitch">
            <Languages size={16} aria-hidden />
            <span>{t.language}</span>
            <select
              onChange={(event) => {
                const next = event.target.value as Locale;
                setLocale(next);
                window.localStorage.setItem("agent-dashboard-locale", next);
              }}
              value={locale}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <div className="health">
            <Activity size={18} aria-hidden />
            <span>{isError ? t.apiOffline : t.live}</span>
          </div>
        </div>
      </header>

      <section className="metrics" aria-label={t.taskMetrics}>
        <Metric icon={<Search size={18} />} label={t.active} value={stats.active} />
        <Metric icon={<Clock3 size={18} />} label={t.queued} value={stats.queued} />
        <Metric icon={<ShieldCheck size={18} />} label={t.review} value={stats.review} />
        <Metric icon={<AlertTriangle size={18} />} label={t.blocked} value={stats.blocked} />
        <Metric icon={<Sparkles size={18} />} label={t.memoryInbox} value={stats.proposedMemory} />
      </section>

      <section className="graphDeck" aria-label={t.graphOverview}>
        {selectedTask ? <CodeGraphPanel locale={locale} task={selectedTask} trace={trace} /> : null}

        {selectedRepository ? (
          <KnowledgeGraphPanel
            dashboardPending={dashboardMutation.isPending}
            generateError={graphGenerationMutation.error}
            generatePending={graphGenerationMutation.isPending}
            knowledgeGraph={graphQuery.data}
            locale={locale}
            loading={graphQuery.isLoading}
            onGenerate={(full) =>
              graphGenerationMutation.mutate({
                repositoryId: selectedRepository.id,
                full
              })
            }
            onOpen={() => dashboardMutation.mutate(selectedRepository.id)}
            openError={dashboardMutation.error}
            repository={selectedRepository}
            unavailable={!hasLiveRepositories || !selectedRepository.configured || graphQuery.isError}
          />
        ) : null}
      </section>

      <section className="repositoryBoard" aria-label={t.repositoryQueues}>
        <div className="sectionHeader">
          <div>
            <h2>{t.repositories}</h2>
            <span>{repositoryQuery.isError ? t.settingsDemo : t.configuredQueues(repositories.length)}</span>
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
              locale={locale}
              repository={repository}
              selected={repository.id === selectedRepository?.id}
            />
          ))}
        </div>
      </section>

      <section className="workspaceGrid" aria-label={t.agentWorkspace}>
        <section className="taskGrid" aria-label={t.tasks}>
          <div className="sectionHeader">
            <div>
              <h2>{selectedRepository?.fullName ?? t.tasks}</h2>
              <span>
                {selectedRepository
                  ? `${selectedRepository.queuedCount} ${t.queued} · ${selectedRepository.runningCount}/${selectedRepository.maxConcurrentIssues} ${t.running}`
                  : t.trackedIssueWorkflows(visibleTasks.length)}
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
                <StatusPill locale={locale} status={task.status} />
                <div className="branchCell">
                  <GitPullRequestDraft size={16} aria-hidden />
                  <span>{task.branchName ?? t.branchPending}</span>
                </div>
              </button>
            ))
          ) : (
            <EmptyState label={t.noQueuedIssues} />
          )}
        </section>

        <section className="detailPanel" aria-label="Selected task details">
          {selectedTask ? <TaskDetail locale={locale} task={selectedTask} trace={trace} traceLoading={traceQuery.isLoading} /> : <EmptyState label={t.noTaskSelected} />}
        </section>

        <section className="memoryPanel" aria-label={t.memoryInbox}>
          <div className="sectionHeader">
            <div>
              <h2>{t.memoryInbox}</h2>
              <span>{memoryQuery.isError ? t.settingsDemo : t.approveBeforeReuse}</span>
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
                <LongText label={t.viewFullDetails} text={memory.content} />
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
                    title={t.approve}
                    type="button"
                  >
                    <Check size={16} aria-hidden />
                    <span>{t.approve}</span>
                  </button>
                  <button
                    className="iconButton danger"
                    disabled={memoryMutation.isPending || !hasLiveMemories}
                    onClick={() => memoryMutation.mutate({ id: memory.id, status: "rejected" })}
                    title={t.reject}
                    type="button"
                  >
                    <X size={16} aria-hidden />
                    <span>{t.reject}</span>
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
  locale,
  onSelect,
  repository,
  selected
}: {
  locale: Locale;
  onSelect: () => void;
  repository: RepositoryQueueSummary;
  selected: boolean;
}) {
  const utilization = repository.maxConcurrentIssues > 0 ? Math.min(100, Math.round((repository.runningCount / repository.maxConcurrentIssues) * 100)) : 0;
  const t = text[locale];

  return (
    <button className={`repositoryCard ${selected ? "repositoryCardSelected" : ""}`} onClick={onSelect} type="button">
      <div className="repositoryCardTopline">
        <strong>{repository.fullName}</strong>
        <span>{repository.configured ? t.configured : t.unconfigured}</span>
      </div>
      <div className="queueBar" aria-hidden>
        <span style={{ width: `${utilization}%` }} />
      </div>
      <div className="repositoryStats">
        <span>
          <strong>{repository.queuedCount}</strong>
          {t.queued}
        </span>
        <span>
          <strong>
            {repository.runningCount}/{repository.maxConcurrentIssues}
          </strong>
          {t.running}
        </span>
        <span>
          <strong>{repository.reviewCount}</strong>
          {t.review}
        </span>
        <span>
          <strong>{repository.blockedCount}</strong>
          {t.blocked}
        </span>
        <span>
          <strong>{repository.completedCount}</strong>
          {t.completed}
        </span>
      </div>
    </button>
  );
}

function CodeGraphPanel({ locale, task, trace }: { locale: Locale; task: Task; trace: TaskTrace }) {
  const t = text[locale];
  const graphArtifacts = trace.artifacts.filter((artifact) => ["repo-graph", "navigation-route", "context-pack"].includes(artifact.type));
  const graphSpans = trace.spans.filter(
    (span) =>
      span.name.includes("CODEBASE_INDEXED") ||
      span.name.includes("AGENTIC_SEARCH") ||
      span.name.includes("REPO_NAVIGATION_GRAPH") ||
      span.name.includes("NAVIGATION_ROUTE")
  );
  const failed = graphSpans.some((span) => span.status === "failed" || span.status === "blocked");
  const status = graphArtifacts.length > 0 ? "ready" : failed ? "failed" : "missing";
  const statusLabel = status === "ready" ? t.graphReady : status === "failed" ? t.graphFailed : t.graphMissing;

  return (
    <section className="knowledgeGraphPanel" aria-label={t.codeGraph}>
      <div className="sectionHeader">
        <div>
          <h2>{t.codeGraph}</h2>
          <span>{t.codeGraphHint}</span>
        </div>
        <GitBranch size={18} aria-hidden />
      </div>
      <div className="codeGraphBody">
        <div className="knowledgeGraphInfo">
          <div className={`graphStatus graphStatus-${status}`}>{statusLabel}</div>
          <div className="graphStats">
            <span>
              <strong>{graphArtifacts.length}</strong>
              {t.generatedArtifacts}
            </span>
            <span>
              <strong>{task.contextPack?.relevantFiles.length ?? "-"}</strong>
              ContextPack
            </span>
            <span>
              <strong>{graphSpans.length}</strong>
              Trace spans
            </span>
          </div>
        </div>
        <div className="graphArtifactList">
          {graphArtifacts.length > 0 ? (
            graphArtifacts.map((artifact) => (
              <article key={artifact.id}>
                <strong>{artifact.type}</strong>
                <span>{compactArtifactPath(artifact.path ?? artifact.url ?? artifact.type)}</span>
              </article>
            ))
          ) : (
            <p>{t.codeGraphDisabled}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function KnowledgeGraphPanel({
  dashboardPending,
  generateError,
  generatePending,
  knowledgeGraph,
  locale,
  loading,
  onGenerate,
  onOpen,
  openError,
  repository,
  unavailable
}: {
  dashboardPending: boolean;
  generateError: Error | null;
  generatePending: boolean;
  knowledgeGraph?: ProjectKnowledgeGraph;
  locale: Locale;
  loading: boolean;
  onGenerate: (full: boolean) => void;
  onOpen: () => void;
  openError: Error | null;
  repository: RepositoryQueueSummary;
  unavailable: boolean;
}) {
  const t = text[locale];
  const busy = generatePending || knowledgeGraph?.status === "generating";
  const ready = Boolean(knowledgeGraph?.graphAvailable);
  const knowledgeStatus = loading ? t.loading : (knowledgeGraph?.status ?? "missing");
  const knowledgeStatusLabel =
    knowledgeStatus === "ready"
      ? t.graphReady
      : knowledgeStatus === "failed"
        ? t.graphFailed
        : knowledgeStatus === "missing"
          ? t.graphMissing
          : knowledgeStatus === "generating"
            ? t.generating
            : knowledgeStatus;

  return (
    <section className="knowledgeGraphPanel" aria-label={t.knowledgeGraph}>
      <div className="sectionHeader">
        <div>
          <h2>{repository.fullName} {t.knowledgeGraph}</h2>
          <span>
            <a href="https://github.com/Lum1104/Understand-Anything" rel="noreferrer" target="_blank">
              Understand-Anything
            </a>{" "}
            {t.knowledgeGraphHint}
          </span>
        </div>
        <Network size={18} aria-hidden />
      </div>
      <div className="knowledgeGraphBody">
        <div className="knowledgeGraphInfo">
          <div className={`graphStatus graphStatus-${knowledgeGraph?.status ?? "missing"}`}>{knowledgeStatusLabel}</div>
          {knowledgeGraph?.graph ? (
            <div className="graphStats">
              <span>
                <strong>{knowledgeGraph.graph.nodes ?? "-"}</strong>
                Nodes
              </span>
              <span>
                <strong>{knowledgeGraph.graph.edges ?? "-"}</strong>
                Edges
              </span>
              <span>
                <strong>{knowledgeGraph.graph.projectName ?? repository.repo}</strong>
                {t.project}
              </span>
            </div>
          ) : (
            <LongText
              className="graphMessage"
              label={t.viewFullDetails}
              text={unavailable ? t.connectApi : (knowledgeGraph?.message ?? "Generate this project's graph with the official Understand-Anything pipeline.")}
            />
          )}
          {knowledgeGraph?.message && ready ? <LongText className="graphMessage" label={t.viewFullDetails} text={knowledgeGraph.message} /> : null}
          {generateError ? <LongText className="graphError" label={t.viewFullDetails} text={generateError.message} /> : null}
          {openError ? <LongText className="graphError" label={t.viewFullDetails} text={openError.message} /> : null}
          <div className="graphActions">
            <button className="iconButton neutral" disabled={unavailable || busy} onClick={() => onGenerate(ready)} type="button">
              <RotateCcw size={16} aria-hidden />
              <span>{busy ? t.generating : ready ? t.regenerate : t.generateGraph}</span>
            </button>
            <button className="iconButton positive" disabled={unavailable || !ready || dashboardPending} onClick={onOpen} type="button">
              <ExternalLink size={16} aria-hidden />
              <span>{dashboardPending ? t.starting : t.openDashboard}</span>
            </button>
          </div>
        </div>
        {knowledgeGraph?.dashboardUrl ? (
          <iframe className="knowledgeGraphFrame" src={knowledgeGraph.dashboardUrl} title={`${repository.fullName} Understand-Anything dashboard`} />
        ) : (
          <div className="graphPreviewPlaceholder">
            <Network size={36} aria-hidden />
            <strong>{t.officialDashboardViewer}</strong>
            <span>{ready ? "Open the graph to explore files, layers, relationships and tours." : "A generated graph will appear here."}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function TaskDetail({ locale, task, trace, traceLoading }: { locale: Locale; task: Task; trace: TaskTrace; traceLoading: boolean }) {
  const t = text[locale];
  const tracePageSize = 12;
  const [tracePage, setTracePage] = useState(0);
  const tracePageCount = Math.max(1, Math.ceil(trace.spans.length / tracePageSize));
  const safeTracePage = Math.min(tracePage, tracePageCount - 1);
  const visibleSpans = trace.spans.slice(safeTracePage * tracePageSize, safeTracePage * tracePageSize + tracePageSize);

  useEffect(() => {
    setTracePage(0);
  }, [task.id, trace.spans.length]);

  return (
    <>
      <div className="detailHeader">
        <div>
          <p className="eyebrow">{t.selectedRun}</p>
          <h2>
            #{task.issue.number} {task.issue.title}
          </h2>
          <span>
            {task.issue.owner}/{task.issue.repo} · {t.updated} {formatTime(task.updatedAt)}
          </span>
        </div>
        <StatusPill locale={locale} status={task.status} />
      </div>

      <div className="linkRow">
        <a href={task.issue.url} target="_blank" rel="noreferrer">
          {t.issue}
        </a>
        {task.prUrl ? (
          <a href={task.prUrl} target="_blank" rel="noreferrer">
            {t.draftPr}
          </a>
        ) : null}
        <span>{task.branchName ?? t.branchPending}</span>
      </div>

      <div className="traceSummary" aria-label="Trace summary">
        <TraceMetric label="Spans" value={trace.summary.totalSpans} />
        <TraceMetric label={t.tools} value={trace.summary.toolCalls} />
        <TraceMetric label={t.policies} value={trace.summary.policyDecisions} />
        <TraceMetric label={t.blocked} value={trace.summary.failedOrBlocked} />
      </div>

      <div className="sectionHeader compact">
        <div>
          <h2>{t.traceReplay}</h2>
          <span>{traceLoading ? t.loadingTrace : t.spansFromIssueToPr(trace.spans.length)}</span>
        </div>
        <Clock3 size={18} aria-hidden />
      </div>

      {trace.spans.length > tracePageSize ? (
        <div className="paginationControls" aria-label={t.traceReplay}>
          <button disabled={safeTracePage === 0} onClick={() => setTracePage((page) => Math.max(0, page - 1))} type="button">
            {t.previousPage}
          </button>
          <span>{t.tracePage(safeTracePage + 1, tracePageCount)}</span>
          <button
            disabled={safeTracePage >= tracePageCount - 1}
            onClick={() => setTracePage((page) => Math.min(tracePageCount - 1, page + 1))}
            type="button"
          >
            {t.nextPage}
          </button>
        </div>
      ) : null}

      <ol className="traceTimeline">
        {visibleSpans.map((span) => (
          <TraceRow key={span.id} label={t.viewFullDetails} span={span} />
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

function TraceRow({ label, span }: { label: string; span: TraceSpan }) {
  return (
    <li className={`traceRow trace-${span.kind}`}>
      <div className="traceMarker" aria-hidden />
      <div>
        <div className="traceTopline">
          <strong>{span.name}</strong>
          <span>{span.kind.replaceAll("_", " ")}</span>
        </div>
        <LongText label={label} text={span.message} />
      </div>
      <span className={`traceStatus status-${span.status}`}>{span.status}</span>
    </li>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="emptyState">{label}</div>;
}

function LongText({ className, label, text: value }: { className?: string; label: string; text: string }) {
  const textValue = value.trim();

  if (textValue.length < 220) {
    return <p className={className}>{textValue}</p>;
  }

  const preview = `${textValue.slice(0, 180)}...`;

  return (
    <details className={`longText ${className ?? ""}`}>
      <summary>
        <span>{label}</span>
        <small>{preview}</small>
      </summary>
      <pre>{textValue}</pre>
    </details>
  );
}

function compactArtifactPath(value: string): string {
  const parts = value.split("/");
  return parts.length > 4 ? `.../${parts.slice(-4).join("/")}` : value;
}
