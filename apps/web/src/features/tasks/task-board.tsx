"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronLeft,
  Clock3,
  FileText,
  GitBranch,
  GitPullRequestDraft,
  Home,
  Languages,
  ListChecks,
  Network,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Task, TaskTrace, TraceSpan } from "@agent/shared";
import { StatusPill } from "../../components/status-pill";
import {
  approveTaskPrd,
  fetchGitHubSync,
  fetchMemories,
  fetchProjectKnowledgeGraph,
  fetchRepositoryContextFiles,
  fetchRepositoryOnboarding,
  fetchRepositoryQueues,
  fetchTasks,
  fetchTrace,
  generateProjectKnowledgeGraph,
  openProjectKnowledgeGraphDashboard,
  saveRepositoryContextFile,
  triggerGitHubSync,
  updateMemoryStatus,
} from "./api";
import { buildRepositorySummariesFromTasks } from "./repository-summary";
import { formatTime } from "./time";
import type {
  GitHubSyncState,
  KnowledgeGraphStatus,
  MemoryRecord,
  ProjectKnowledgeGraph,
  RepositoryContextFile,
  RepositoryContextFileKind,
  RepositoryOnboarding,
  RepositoryQueueSummary,
} from "./types";
import { SettingsConsole } from "../settings/settings-console";

type Locale = "zh" | "en";
type BoardView =
  | "home"
  | "repositories"
  | "repositoryDetail"
  | "repositoryConfig"
  | "modelConfig";

const text = {
  zh: {
    active: "运行中",
    agentWorkspace: "Agent 工作区",
    apiOffline: "API 离线",
    approve: "批准",
    approveBeforeReuse: "复用前审批",
    approving: "批准中",
    blocked: "阻塞",
    branchPending: "分支待创建",
    codeGraph: "Code Graph / 代码图",
    codeGraphDisabled:
      "还没有看到代码图产物。仓库完成初始化后，会显示代码索引库、项目说明文档和任务上下文。",
    codeGraphHint:
      "本地代码索引，帮助 agent 理解文件、模块、路由和测试关系，再决定该读哪些代码。",
    codeGraphDb: "代码索引库",
    codeGraphDbReady: "已建立",
    codeGraphDbMissing: "未建立",
    codeGraphOpen: "查看代码图详情",
    codeGraphSummary: "查看本地代码索引、仓库说明文档和本次任务上下文。",
    completed: "完成",
    configured: "已配置",
    configuredQueues: (count: number) => `${count} 个已配置队列`,
    close: "关闭",
    connectApi: "连接 API 后可生成并打开项目图谱。",
    draftPr: "Draft PR",
    edges: "关系",
    generatedArtifacts: "已生成产物",
    generateGraph: "生成知识图谱",
    generating: "生成中",
    graphFailed: "失败",
    graphMissing: "未生成",
    graphOverview: "图谱总览",
    graphReady: "已就绪",
    graphUnavailable: "暂无",
    githubSync: "同步 GitHub",
    githubSyncFailed: (message: string) => `同步失败：${message}`,
    githubSyncIdle: "等待同步",
    githubSyncing: "同步中",
    githubSyncSummary: (issues: number, comments: number, time: string) =>
      `${time} 导入 ${issues} 个 Issue / ${comments} 条 PR 评论`,
    issue: "Issue",
    knowledgeGraph: "Knowledge Graph / 知识图谱",
    knowledgeGraphHint: "由 Understand-Anything 官方分析和 dashboard 驱动",
    knowledgeGraphOpen: "查看知识图谱详情",
    knowledgeGraphSummary:
      "查看 Understand-Anything 是否已生成图谱、节点/关系数量，以及 dashboard 入口。",
    language: "语言",
    live: "在线",
    loading: "加载中",
    loadingTrace: "加载 trace",
    memoryInbox: "记忆审批",
    noQueuedIssues: "没有排队 Issue",
    noTaskSelected: "未选择任务",
    nodes: "节点",
    officialDashboardViewer: "官方 dashboard 视图",
    nextPage: "下一页",
    policies: "策略",
    previousPage: "上一页",
    project: "项目",
    queued: "排队",
    regenerate: "重新生成",
    reject: "拒绝",
    repositories: "仓库",
    repositoryQueues: "仓库队列",
    review: "待审",
    running: "运行",
    selectedRun: "选中运行",
    apiUnavailable: "API 不可用，未展示示例数据",
    spansFromIssueToPr: (count: number) => `${count} 个 span，覆盖 Issue 到 PR`,
    starting: "启动中",
    taskMetrics: "任务指标",
    tasks: "任务",
    tools: "工具",
    traceReplay: "Trace 回放",
    traceRecords: "执行记录",
    tracePage: (page: number, pageCount: number) =>
      `第 ${page}/${pageCount} 页`,
    trackedIssueWorkflows: (count: number) =>
      `${count} 个已跟踪 Issue workflow`,
    unavailable: "不可用",
    unconfigured: "未配置",
    updated: "更新于",
    viewFullDetails: "查看完整详情",
    indexedFiles: "已索引文件",
    indexedSymbols: "已识别符号",
    contextFiles: "上下文文件",
    generatedDocs: "生成的说明文档",
    contextPackHint:
      "ContextPack 是针对当前任务挑出的少量相关文件，Agent 会优先阅读这些文件，避免一上来扫完整仓库。",
    traceSpansHint:
      "执行记录是 Agent 运行时留下的步骤日志，用来追踪代码索引、搜索、生成和失败原因。",
    knowledgeGraphReadyHint: "",
    knowledgeGraphGeneratingHint:
      "知识图谱正在后台生成，页面会自动刷新。大型仓库可能需要几分钟到几十分钟；如果长时间停住，可以查看 generation.log 或重新生成。",
    knowledgeGraphMissingHint:
      "还没有生成知识图谱。点击生成后，系统会调用 Understand-Anything 官方流程在本地分析仓库。",
    knowledgeGraphFailedHint:
      "知识图谱生成失败。下方错误信息通常会说明是插件缺失、仓库拉取失败、超时，还是官方流程没有产出结果。",
    dashboardReadyHint: "打开图谱后可以浏览文件、模块、关系和导览。",
    dashboardMissingHint: "生成完成后，这里会显示官方 dashboard。",
    previewDocument: "预览文档",
    reopenDashboard: "重新打开",
    startingDashboard: "正在打开 dashboard",
  },
  en: {
    active: "Active",
    agentWorkspace: "Agent workspace",
    apiOffline: "API offline",
    approve: "Approve",
    approveBeforeReuse: "Approve before reuse",
    approving: "Approving",
    blocked: "Blocked",
    branchPending: "branch pending",
    codeGraph: "Code Graph",
    codeGraphDisabled:
      "No CodeGraph artifact is available yet. Index, context and navigation artifacts appear after the task reaches codebase indexing.",
    codeGraphHint:
      "Shows the local CodeGraph, Repo Navigation Graph and ContextPack the agent uses to understand the repository.",
    codeGraphDb: "CodeGraph DB",
    codeGraphDbReady: "Ready",
    codeGraphDbMissing: "Missing",
    codeGraphOpen: "View code graph",
    codeGraphSummary:
      "Review the local code index, onboarding documents, and task context.",
    completed: "Completed",
    configured: "Configured",
    configuredQueues: (count: number) => `${count} configured queues`,
    close: "Close",
    connectApi: "Connect the API to generate and open project graphs.",
    draftPr: "Draft PR",
    edges: "Edges",
    generatedArtifacts: "Generated artifacts",
    generateGraph: "Generate Graph",
    generating: "Generating",
    graphFailed: "Failed",
    graphMissing: "Missing",
    graphOverview: "Graph Overview",
    graphReady: "Ready",
    graphUnavailable: "Unavailable",
    githubSync: "Sync GitHub",
    githubSyncFailed: (message: string) => `Sync failed: ${message}`,
    githubSyncIdle: "Waiting to sync",
    githubSyncing: "Syncing",
    githubSyncSummary: (issues: number, comments: number, time: string) =>
      `${time}: imported ${issues} issues / ${comments} PR comments`,
    issue: "Issue",
    knowledgeGraph: "Knowledge Graph",
    knowledgeGraphHint:
      "Powered by Understand-Anything official analysis and dashboard",
    knowledgeGraphOpen: "View knowledge graph",
    knowledgeGraphSummary:
      "Check Understand-Anything graph status, node and edge counts, and dashboard access.",
    language: "Language",
    live: "Live",
    loading: "Loading",
    loadingTrace: "Loading trace",
    memoryInbox: "Memory Inbox",
    noQueuedIssues: "No queued issues",
    noTaskSelected: "No task selected",
    nodes: "Nodes",
    officialDashboardViewer: "Official dashboard viewer",
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
    apiUnavailable: "API unavailable, no demo data shown",
    spansFromIssueToPr: (count: number) => `${count} spans from issue to PR`,
    starting: "Starting",
    taskMetrics: "Task metrics",
    tasks: "Tasks",
    tools: "Tools",
    traceReplay: "Trace Replay",
    traceRecords: "Trace records",
    tracePage: (page: number, pageCount: number) =>
      `Page ${page} of ${pageCount}`,
    trackedIssueWorkflows: (count: number) =>
      `${count} tracked issue workflows`,
    unavailable: "Unavailable",
    unconfigured: "Unconfigured",
    updated: "updated",
    viewFullDetails: "View full details",
    indexedFiles: "Indexed files",
    indexedSymbols: "Discovered symbols",
    contextFiles: "Context files",
    generatedDocs: "Generated docs",
    contextPackHint:
      "ContextPack is the small set of files selected for the current task. The agent reads these first instead of scanning the whole repository.",
    traceSpansHint:
      "Trace records are the runtime steps left by the agent. They help explain indexing, search, generation, and failure causes.",
    knowledgeGraphReadyHint: "",
    knowledgeGraphGeneratingHint:
      "The graph is being generated in the background and this page refreshes automatically. Large repositories can take several minutes or longer.",
    knowledgeGraphMissingHint:
      "No knowledge graph exists yet. Generate it to run the official Understand-Anything analysis locally.",
    knowledgeGraphFailedHint:
      "Graph generation failed. The error below usually explains whether the plugin is missing, checkout failed, timed out, or no graph was produced.",
    dashboardReadyHint:
      "Open the graph to explore files, layers, relationships and tours.",
    dashboardMissingHint: "A generated graph will appear here.",
    previewDocument: "Preview document",
    reopenDashboard: "Reopen",
    startingDashboard: "Opening dashboard",
  },
};

export function TaskBoard() {
  const queryClient = useQueryClient();
  const [locale, setLocale] = useState<Locale>("zh");
  const [activeView, setActiveView] = useState<BoardView>("home");
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<
    string | undefined
  >();
  const t = text[locale];
  const { data, isError } = useQuery({
    queryKey: ["tasks"],
    queryFn: fetchTasks,
    refetchInterval: (query) =>
      query.state.data?.some((task) => isLiveTaskStatus(task.status))
        ? 2500
        : false,
  });
  const repositoryQuery = useQuery({
    queryKey: ["task-repositories"],
    queryFn: fetchRepositoryQueues,
  });
  const memoryQuery = useQuery({
    queryKey: ["memories", "proposed"],
    queryFn: () => fetchMemories("proposed"),
  });
  const memoryMutation = useMutation({
    mutationFn: updateMemoryStatus,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memories"] });
    },
  });
  const prdApprovalMutation = useMutation({
    mutationFn: approveTaskPrd,
    onSuccess: async (task) => {
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["task-repositories"] });
      await queryClient.invalidateQueries({
        queryKey: ["task-trace", task.id],
      });
    },
  });

  const hasLiveTasks = Array.isArray(data);
  const tasks: Task[] = data ?? [];
  const repositories = useMemo(
    () =>
      Array.isArray(repositoryQuery.data)
        ? repositoryQuery.data
        : buildRepositorySummariesFromTasks(tasks),
    [repositoryQuery.data, tasks],
  );
  const selectedRepository =
    repositories.find((repository) => repository.id === selectedRepositoryId) ??
    repositories[0];
  const hasLiveRepositories = Array.isArray(repositoryQuery.data);
  const syncQuery = useQuery({
    queryKey: ["github-sync", selectedRepository?.id],
    queryFn: () => fetchGitHubSync(selectedRepository?.id ?? ""),
    enabled: Boolean(hasLiveRepositories && selectedRepository?.configured),
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 2000 : false,
  });
  const syncMutation = useMutation({
    mutationFn: triggerGitHubSync,
    onSuccess: async (response) => {
      queryClient.setQueryData(
        ["github-sync", response.sync.repositoryId],
        response.sync,
      );
      await queryClient.invalidateQueries({
        queryKey: ["github-sync", response.sync.repositoryId],
      });
      await queryClient.invalidateQueries({ queryKey: ["task-repositories"] });
    },
  });
  const graphQuery = useQuery({
    queryKey: ["repository-knowledge-graph", selectedRepository?.id],
    queryFn: () => fetchProjectKnowledgeGraph(selectedRepository?.id ?? ""),
    enabled: Boolean(hasLiveRepositories && selectedRepository?.configured),
    refetchInterval: (query) =>
      query.state.data?.status === "generating" ? 3000 : false,
  });
  const onboardingQuery = useQuery({
    queryKey: ["repository-onboarding", selectedRepository?.id],
    queryFn: () => fetchRepositoryOnboarding(selectedRepository?.id ?? ""),
    enabled: Boolean(hasLiveRepositories && selectedRepository?.configured),
    refetchInterval: (query) =>
      query.state.data?.status === "generating" ? 3000 : false,
  });
  const contextFilesQuery = useQuery({
    queryKey: ["repository-context-files", selectedRepository?.id],
    queryFn: () => fetchRepositoryContextFiles(selectedRepository?.id ?? ""),
    enabled: Boolean(hasLiveRepositories && selectedRepository?.configured),
  });
  const graphGenerationMutation = useMutation({
    mutationFn: generateProjectKnowledgeGraph,
    onSuccess: (knowledgeGraph) => {
      queryClient.setQueryData(
        ["repository-knowledge-graph", knowledgeGraph.repositoryId],
        knowledgeGraph,
      );
    },
  });
  const contextFileMutation = useMutation({
    mutationFn: saveRepositoryContextFile,
    onSuccess: (files, input) => {
      queryClient.setQueryData(
        ["repository-context-files", input.repositoryId],
        files,
      );
    },
  });
  const dashboardMutation = useMutation({
    mutationFn: openProjectKnowledgeGraphDashboard,
    onSuccess: (knowledgeGraph) => {
      queryClient.setQueryData(
        ["repository-knowledge-graph", knowledgeGraph.repositoryId],
        knowledgeGraph,
      );
    },
  });
  const visibleTasks = useMemo(
    () =>
      selectedRepository
        ? tasks.filter(
            (task) =>
              task.issue.owner === selectedRepository.owner &&
              task.issue.repo === selectedRepository.repo,
          )
        : tasks,
    [selectedRepository, tasks],
  );
  const selectedTask =
    visibleTasks.find((task) => task.id === selectedTaskId) ?? visibleTasks[0];
  const hasLiveMemories = Array.isArray(memoryQuery.data);
  const memories: MemoryRecord[] = memoryQuery.data ?? [];
  const traceQuery = useQuery({
    queryKey: ["task-trace", selectedTask?.id],
    queryFn: () => fetchTrace(selectedTask?.id ?? ""),
    enabled: Boolean(hasLiveTasks && selectedTask?.id),
    refetchInterval: () =>
      isLiveTaskStatus(selectedTask?.status) ? 2000 : false,
  });
  const trace = selectedTask
    ? (traceQuery.data ?? emptyTrace(selectedTask))
    : undefined;
  const stats = useMemo(
    () => ({
      active: repositories.reduce(
        (sum, repository) => sum + repository.runningCount,
        0,
      ),
      queued: repositories.reduce(
        (sum, repository) => sum + repository.queuedCount,
        0,
      ),
      review: repositories.reduce(
        (sum, repository) => sum + repository.reviewCount,
        0,
      ),
      blocked: repositories.reduce(
        (sum, repository) => sum + repository.blockedCount,
        0,
      ),
      completed: repositories.reduce(
        (sum, repository) => sum + repository.completedCount,
        0,
      ),
      configuredRepositories: repositories.filter(
        (repository) => repository.configured,
      ).length,
      totalRepositories: repositories.length,
      totalTasks: tasks.length,
      totalCapacity: repositories.reduce(
        (sum, repository) => sum + repository.maxConcurrentIssues,
        0,
      ),
      availableSlots: repositories.reduce(
        (sum, repository) => sum + repository.availableSlots,
        0,
      ),
      proposedMemory: memories.length,
    }),
    [memories.length, repositories, tasks.length],
  );
  const recentTasks = useMemo(
    () =>
      [...tasks]
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        )
        .slice(0, 6),
    [tasks],
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
    if (
      visibleTasks.length > 0 &&
      !visibleTasks.some((task) => task.id === selectedTaskId)
    ) {
      setSelectedTaskId(visibleTasks[0]?.id);
    }
  }, [selectedTaskId, visibleTasks]);

  useEffect(() => {
    if (syncQuery.data?.lastFinishedAt) {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["task-repositories"] });
    }
  }, [queryClient, syncQuery.data?.lastFinishedAt]);

  const syncStatus = syncQuery.data?.status ?? "idle";
  const syncBusy = syncMutation.isPending || syncStatus === "running";

  return (
    <main className="appShell">
      <aside
        className="sidebar"
        aria-label={locale === "zh" ? "主导航" : "Primary navigation"}
      >
        <div className="brandBlock">
          <span className="brandMark">A</span>
          <div>
            <strong>Agent PRD</strong>
            <small>Automation</small>
          </div>
        </div>
        <nav className="primaryNav">
          <NavButton
            active={activeView === "home"}
            icon={<Home size={18} />}
            label={locale === "zh" ? "主页" : "Home"}
            onClick={() => setActiveView("home")}
          />
          <NavButton
            active={
              activeView === "repositories" || activeView === "repositoryDetail"
            }
            icon={<GitBranch size={18} />}
            label={locale === "zh" ? "仓库信息" : "Repositories"}
            onClick={() => setActiveView("repositories")}
          />
          <NavButton
            active={activeView === "repositoryConfig"}
            icon={<Settings size={18} />}
            label={locale === "zh" ? "仓库配置" : "Repository config"}
            onClick={() => setActiveView("repositoryConfig")}
          />
        </nav>
        <div className="sidebarFooter">
          <NavButton
            active={activeView === "modelConfig"}
            icon={<Sparkles size={18} />}
            label={locale === "zh" ? "模型配置" : "Model config"}
            onClick={() => setActiveView("modelConfig")}
          />
        </div>
      </aside>

      <section
        className="dashboardPane"
        aria-label={viewTitle(locale, activeView)}
      >
        <header className="topbar">
          <div>
            <h1>{viewTitle(locale, activeView)}</h1>
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

        {activeView === "home" ? (
          <HomeOverview
            hasLiveMemories={hasLiveMemories}
            isApiError={isError}
            locale={locale}
            memories={memories}
            memoryError={memoryQuery.isError}
            memoryPending={memoryMutation.isPending}
            onMemoryStatus={(id, status) =>
              memoryMutation.mutate({ id, status })
            }
            onOpenRepository={(repository) => {
              setSelectedRepositoryId(repository.id);
              setSelectedTaskId(repository.tasks[0]?.id);
              setActiveView("repositoryDetail");
            }}
            onOpenTask={(task) => {
              const repository = repositories.find(
                (item) =>
                  item.owner === task.issue.owner &&
                  item.repo === task.issue.repo,
              );
              setSelectedRepositoryId(
                repository?.id ?? `${task.issue.owner}/${task.issue.repo}`,
              );
              setSelectedTaskId(task.id);
              setActiveView("repositoryDetail");
            }}
            recentTasks={recentTasks}
            repositories={repositories}
            repositoryError={repositoryQuery.isError}
            stats={stats}
            tasks={tasks}
          />
        ) : null}

        {activeView === "repositories" ? (
          <RepositoryListView
            hasLiveRepositories={hasLiveRepositories}
            locale={locale}
            onOpenRepository={(repository) => {
              setSelectedRepositoryId(repository.id);
              setSelectedTaskId(repository.tasks[0]?.id);
              setActiveView("repositoryDetail");
            }}
            repositories={repositories}
            repositoryError={repositoryQuery.isError}
            selectedRepository={selectedRepository}
          />
        ) : null}

        {activeView === "repositoryDetail" ? (
          <RepositoryDetailView
            dashboardPending={dashboardMutation.isPending}
            generateError={graphGenerationMutation.error}
            generatePending={graphGenerationMutation.isPending}
            graphError={graphQuery.isError}
            graphLoading={graphQuery.isLoading}
            hasLiveRepositories={hasLiveRepositories}
            knowledgeGraph={graphQuery.data}
            locale={locale}
            onboarding={onboardingQuery.data}
            onApprovePrd={() =>
              selectedTask && prdApprovalMutation.mutate(selectedTask.id)
            }
            onBack={() => setActiveView("repositories")}
            onGenerateGraph={(full) =>
              selectedRepository &&
              graphGenerationMutation.mutate({
                repositoryId: selectedRepository.id,
                full,
              })
            }
            onOpenDashboard={() =>
              selectedRepository &&
              dashboardMutation.mutate(selectedRepository.id)
            }
            onSelectTask={setSelectedTaskId}
            onSync={() =>
              selectedRepository && syncMutation.mutate(selectedRepository.id)
            }
            openError={dashboardMutation.error}
            repository={selectedRepository}
            selectedTask={selectedTask}
            sync={syncQuery.data}
            syncBusy={syncBusy}
            syncStatus={syncStatus}
            tasks={visibleTasks}
            trace={trace}
            traceLoading={traceQuery.isLoading}
            approvalError={prdApprovalMutation.error}
            approvalPending={prdApprovalMutation.isPending}
            contextFiles={contextFilesQuery.data ?? []}
            contextFilesError={contextFilesQuery.isError}
            contextFilesLoading={contextFilesQuery.isLoading}
            contextSaveError={contextFileMutation.error}
            contextSavePending={contextFileMutation.isPending}
            onSaveContextFile={(input) =>
              selectedRepository &&
              contextFileMutation.mutate({
                repositoryId: selectedRepository.id,
                ...input,
              })
            }
          />
        ) : null}

        {activeView === "repositoryConfig" ? (
          <SettingsConsole
            description="配置仓库触发、队列、权限、沙箱、工具和策略。"
            initialSection="repositories"
            showTopline={false}
            title="仓库配置"
            visibleSections={["repositories", "tools", "policies", "sandbox"]}
          />
        ) : null}

        {activeView === "modelConfig" ? (
          <SettingsConsole
            description="配置模型供应商、API Key 测试和工作流代理路由。"
            initialSection="agents"
            showTopline={false}
            title="模型配置"
            visibleSections={["agents"]}
          />
        ) : null}
      </section>
    </main>
  );
}

type BoardStats = {
  active: number;
  queued: number;
  review: number;
  blocked: number;
  completed: number;
  configuredRepositories: number;
  totalRepositories: number;
  totalTasks: number;
  totalCapacity: number;
  availableSlots: number;
  proposedMemory: number;
};

function NavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`navButton ${active ? "navButtonActive" : ""}`}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function viewTitle(locale: Locale, activeView: BoardView): string {
  if (locale === "en") {
    if (activeView === "repositories") return "Repositories";
    if (activeView === "repositoryDetail") return "Repository detail";
    if (activeView === "repositoryConfig") return "Repository config";
    if (activeView === "modelConfig") return "Model config";
    return "Console";
  }

  if (activeView === "repositories") return "仓库信息";
  if (activeView === "repositoryDetail") return "仓库详情";
  if (activeView === "repositoryConfig") return "仓库配置";
  if (activeView === "modelConfig") return "模型配置";
  return "控制台";
}

function HomeOverview({
  hasLiveMemories,
  isApiError,
  locale,
  memories,
  memoryError,
  memoryPending,
  onMemoryStatus,
  onOpenRepository,
  onOpenTask,
  recentTasks,
  repositories,
  repositoryError,
  stats,
  tasks,
}: {
  hasLiveMemories: boolean;
  isApiError: boolean;
  locale: Locale;
  memories: MemoryRecord[];
  memoryError: boolean;
  memoryPending: boolean;
  onMemoryStatus: (id: string, status: "approved" | "rejected") => void;
  onOpenRepository: (repository: RepositoryQueueSummary) => void;
  onOpenTask: (task: Task) => void;
  recentTasks: Task[];
  repositories: RepositoryQueueSummary[];
  repositoryError: boolean;
  stats: BoardStats;
  tasks: Task[];
}) {
  const t = text[locale];
  const capacityUsed = Math.max(0, stats.totalCapacity - stats.availableSlots);
  const configuredRepositories = repositories.filter(
    (repository) => repository.configured,
  );
  const alertItems = [
    isApiError
      ? locale === "zh"
        ? "任务 API 离线，运行状态可能不是最新。"
        : "Task API is offline; run state may be stale."
      : undefined,
    repositoryError
      ? locale === "zh"
        ? "仓库队列 API 不可用，当前使用任务数据回退。"
        : "Repository queue API is unavailable; falling back to task data."
      : undefined,
    memoryError
      ? locale === "zh"
        ? "记忆审批 API 不可用。"
        : "Memory approval API is unavailable."
      : undefined,
    stats.blocked > 0
      ? locale === "zh"
        ? `${stats.blocked} 个任务阻塞，需要处理。`
        : `${stats.blocked} tasks are blocked.`
      : undefined,
    stats.review > 0
      ? locale === "zh"
        ? `${stats.review} 个任务等待人工审阅。`
        : `${stats.review} tasks are waiting for review.`
      : undefined,
  ].filter((item): item is string => Boolean(item));

  return (
    <div className="dashboardStack">
      <section
        className="homeStatsOverview"
        aria-label={locale === "zh" ? "数据纵览" : "Data overview"}
      >
        <div className="homeMetricsStrip">
          <span>
            <strong>{stats.active}</strong>
            {t.active}
          </span>
          <span>
            <strong>{stats.queued}</strong>
            {t.queued}
          </span>
          <span>
            <strong>{stats.completed}</strong>
            {t.completed}
          </span>
          <span>
            <strong>
              {capacityUsed}/{stats.totalCapacity}
            </strong>
            {locale === "zh" ? "运行容量" : "run capacity"}
          </span>
          <span>
            <strong>{stats.proposedMemory}</strong>
            {t.memoryInbox}
          </span>
        </div>
        <IssueTrendCard locale={locale} stats={stats} tasks={tasks} />
      </section>

      <section
        className="homeOperationsRow"
        aria-label={locale === "zh" ? "任务与异常" : "Tasks and alerts"}
      >
        <article className="overviewPanel">
          <div className="sectionHeader">
            <div>
              <h2>{locale === "zh" ? "最近任务" : "Recent tasks"}</h2>
              <span>{t.trackedIssueWorkflows(recentTasks.length)}</span>
            </div>
            <Clock3 size={18} aria-hidden />
          </div>
          <div className="recentTaskList">
            {recentTasks.map((task) => (
              <button
                className="recentTaskRow"
                key={task.id}
                onClick={() => onOpenTask(task)}
                type="button"
              >
                <span>
                  #{task.issue.number} {task.issue.title}
                </span>
                <small>
                  {task.issue.owner}/{task.issue.repo} ·{" "}
                  {formatTime(task.updatedAt)}
                </small>
                <StatusPill locale={locale} status={task.status} />
              </button>
            ))}
            {recentTasks.length === 0 ? (
              <EmptyState label={t.noQueuedIssues} />
            ) : null}
          </div>
        </article>

        <article className="overviewPanel">
          <div className="sectionHeader">
            <div>
              <h2>{locale === "zh" ? "异常提醒" : "Attention"}</h2>
              <span>
                {alertItems.length > 0
                  ? locale === "zh"
                    ? "需要关注"
                    : "Needs attention"
                  : locale === "zh"
                    ? "当前无明显异常"
                    : "No obvious issues"}
              </span>
            </div>
            <AlertTriangle size={18} aria-hidden />
          </div>
          {alertItems.length > 0 ? (
            <ul className="alertList">
              {alertItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <EmptyState
              label={
                locale === "zh" ? "没有需要立即处理的异常" : "No urgent issue"
              }
            />
          )}
        </article>
      </section>

      <section
        className="homeConfigRow"
        aria-label={locale === "zh" ? "配置情况" : "Configuration"}
      >
        <article className="overviewPanel homeRepositoryPanel">
          <div className="sectionHeader">
            <div>
              <h2>
                {locale === "zh" ? "配置仓库" : "Configured repositories"}
              </h2>
              <span>
                {locale === "zh"
                  ? `${stats.configuredRepositories}/${stats.totalRepositories} 个仓库已配置，${stats.totalTasks} 个任务被跟踪`
                  : `${stats.configuredRepositories}/${stats.totalRepositories} repositories configured, ${stats.totalTasks} tasks tracked`}
              </span>
            </div>
            <Activity size={18} aria-hidden />
          </div>

          <div className="overviewRepositoryList">
            {repositories.slice(0, 6).map((repository) => (
              <button
                className="overviewRepositoryRow homeRepositoryRow"
                key={repository.id}
                onClick={() => onOpenRepository(repository)}
                type="button"
              >
                <span>
                  <strong>{repository.fullName}</strong>
                  <small>
                    {repository.queuedCount} {t.queued} ·{" "}
                    {repository.reviewCount} {t.review}
                  </small>
                </span>
                <span>
                  {repository.configured ? t.configured : t.unconfigured}
                </span>
                <span>
                  {repository.runningCount}/{repository.maxConcurrentIssues}{" "}
                  {t.running}
                </span>
              </button>
            ))}
            {repositories.length === 0 ? (
              <EmptyState label={t.apiUnavailable} />
            ) : null}
          </div>
        </article>

        <article className="overviewPanel homeRulesPanel">
          <div className="sectionHeader">
            <div>
              <h2>
                {locale === "zh"
                  ? "配置的 Skill / Rule"
                  : "Configured skills / rules"}
              </h2>
              <span>
                {repositoryError
                  ? t.apiUnavailable
                  : t.configuredQueues(configuredRepositories.length)}
              </span>
            </div>
            <GitBranch size={18} aria-hidden />
          </div>
          <div className="skillRuleList">
            {repositories.slice(0, 6).map((repository) => (
              <button
                className="skillRuleRow"
                key={repository.id}
                onClick={() => onOpenRepository(repository)}
                type="button"
              >
                <strong>{repository.fullName}</strong>
                <span>
                  <small>Skill</small>
                  {repository.projectSkillPath}
                </span>
                <span>
                  <small>Rule</small>
                  {repository.projectRulePath}
                </span>
              </button>
            ))}
            {repositories.length === 0 ? (
              <EmptyState label={t.apiUnavailable} />
            ) : null}
          </div>
        </article>
      </section>

      <MemoryInboxPanel
        hasLiveMemories={hasLiveMemories}
        locale={locale}
        memories={memories}
        memoryError={memoryError}
        memoryPending={memoryPending}
        onMemoryStatus={onMemoryStatus}
      />
    </div>
  );
}

function IssueTrendCard({
  locale,
  stats,
  tasks,
}: {
  locale: Locale;
  stats: BoardStats;
  tasks: Task[];
}) {
  const t = text[locale];
  const statusBuckets = [
    { label: t.queued, value: stats.queued },
    { label: t.active, value: stats.active },
    { label: t.review, value: stats.review },
    { label: t.completed, value: stats.completed },
    { label: t.blocked, value: stats.blocked },
  ];
  const dailyBuckets = buildDailyIssueBuckets(tasks, locale);
  const dailyTotal = dailyBuckets.reduce((sum, bucket) => sum + bucket.total, 0);
  const resolvedTotal = dailyBuckets.reduce(
    (sum, bucket) => sum + bucket.resolved,
    0,
  );
  const totalIssueSignals =
    stats.queued + stats.active + stats.review + stats.completed + stats.blocked;

  return (
    <article className="issueTrendPanel">
      <div className="sectionHeader">
        <div>
          <h2>
            {locale === "zh"
              ? "Issue 使用与解决频次"
              : "Issue usage and resolution"}
          </h2>
          <span>
            {locale === "zh"
              ? `近 7 日处理 ${dailyTotal} 个 / 解决 ${resolvedTotal} 个`
              : `${dailyTotal} handled / ${resolvedTotal} resolved in 7 days`}
          </span>
        </div>
        <TrendingUp size={18} aria-hidden />
      </div>
      <div className="issueTrendChartGrid">
        <IssueLineChart
          labels={dailyBuckets.map((bucket) => bucket.label)}
          legend={[
            {
              label: locale === "zh" ? "处理" : "Handled",
              value: dailyTotal,
            },
            {
              label: locale === "zh" ? "解决" : "Resolved",
              value: resolvedTotal,
            },
          ]}
          series={[
            {
              className: "issueTrendLinePrimary",
              label: locale === "zh" ? "处理" : "Handled",
              values: dailyBuckets.map((bucket) => bucket.total),
            },
            {
              className: "issueTrendLineResolved",
              label: locale === "zh" ? "解决" : "Resolved",
              values: dailyBuckets.map((bucket) => bucket.resolved),
            },
          ]}
          subtitle={
            locale === "zh"
              ? "按日期聚合 Issue 处理量与解决量"
              : "Handled and resolved issues by date"
          }
          title={locale === "zh" ? "近 7 日解决趋势" : "7-day resolution trend"}
        />
        <IssueLineChart
          labels={statusBuckets.map((bucket) => bucket.label)}
          legend={statusBuckets}
          series={[
            {
              className: "issueTrendLinePrimary",
              label: locale === "zh" ? "状态" : "Status",
              values: statusBuckets.map((bucket) => bucket.value),
            },
          ]}
          subtitle={
            locale === "zh"
              ? `${totalIssueSignals} 个当前状态信号`
              : `${totalIssueSignals} current status signals`
          }
          title={locale === "zh" ? "当前状态分布" : "Current status distribution"}
        />
      </div>
    </article>
  );
}

function IssueLineChart({
  labels,
  legend,
  series,
  subtitle,
  title,
}: {
  labels: string[];
  legend: Array<{ label: string; value: number }>;
  series: Array<{ className: string; label: string; values: number[] }>;
  subtitle: string;
  title: string;
}) {
  const maxValue = Math.max(
    1,
    ...series.flatMap((item) => item.values),
    ...legend.map((item) => item.value),
  );

  return (
    <div className="issueTrendChart" aria-label={title}>
      <div className="issueTrendChartHeader">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <svg viewBox="0 0 260 130" role="img">
        <path d="M18 112H242" />
        <path d="M18 28V112" />
        {series.map((item) => (
          <polyline
            className={item.className}
            key={item.label}
            points={lineChartPoints(item.values, maxValue)}
          />
        ))}
        {series.map((item) =>
          item.values.map((value, index) => {
            const { x, y } = linePoint(value, index, item.values.length, maxValue);
            return (
              <circle
                className={item.className}
                cx={x}
                cy={y}
                key={`${item.label}-${labels[index]}`}
                r="2.6"
              />
            );
          }),
        )}
        {labels.map((label, index) => {
          const { x } = linePoint(0, index, labels.length, maxValue);
          return (
            <text key={label} x={x} y="124">
              {label}
            </text>
          );
        })}
      </svg>
      <div className="issueTrendLegend">
        {legend.map((item) => (
          <span key={item.label}>
            <strong>{item.value}</strong>
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function buildDailyIssueBuckets(tasks: Task[], locale: Locale) {
  const formatter = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    month: "2-digit",
    day: "2-digit",
  });
  const today = new Date();
  const buckets = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    return {
      key: localDateKey(date),
      label: formatter.format(date),
      resolved: 0,
      total: 0,
    };
  });
  const bucketByKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  for (const task of tasks) {
    const bucket = bucketByKey.get(localDateKey(new Date(task.updatedAt)));

    if (!bucket) {
      continue;
    }

    bucket.total += 1;

    if (task.status === "DONE") {
      bucket.resolved += 1;
    }
  }

  return buckets;
}

function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function lineChartPoints(values: number[], maxValue: number): string {
  return values
    .map((value, index) => {
      const { x, y } = linePoint(value, index, values.length, maxValue);
      return `${x},${y}`;
    })
    .join(" ");
}

function linePoint(
  value: number,
  index: number,
  length: number,
  maxValue: number,
): { x: number; y: number } {
  const step = length > 1 ? 224 / (length - 1) : 0;
  return {
    x: 18 + index * step,
    y: 112 - (value / Math.max(1, maxValue)) * 84,
  };
}

function RepositoryListView({
  hasLiveRepositories,
  locale,
  onOpenRepository,
  repositories,
  repositoryError,
  selectedRepository,
}: {
  hasLiveRepositories: boolean;
  locale: Locale;
  onOpenRepository: (repository: RepositoryQueueSummary) => void;
  repositories: RepositoryQueueSummary[];
  repositoryError: boolean;
  selectedRepository?: RepositoryQueueSummary;
}) {
  const t = text[locale];

  return (
    <section
      className="repositoryBoard repositoryDirectory"
      aria-label={t.repositoryQueues}
    >
      <div className="sectionHeader">
        <div>
          <h2>{t.repositories}</h2>
          <span>
            {repositoryError
              ? t.apiUnavailable
              : t.configuredQueues(repositories.length)}
          </span>
        </div>
        <div className="sectionActions">
          <span className="syncState">
            {hasLiveRepositories
              ? locale === "zh"
                ? "实时队列"
                : "Live queues"
              : t.unavailable}
          </span>
          <GitBranch size={18} aria-hidden />
        </div>
      </div>
      <div className="repositoryCards">
        {repositories.map((repository) => (
          <RepositoryCard
            key={repository.id}
            locale={locale}
            onSelect={() => onOpenRepository(repository)}
            repository={repository}
            selected={repository.id === selectedRepository?.id}
          />
        ))}
      </div>
      {repositories.length === 0 ? (
        <EmptyState label={t.apiUnavailable} />
      ) : null}
    </section>
  );
}

function RepositoryDetailView({
  approvalError,
  approvalPending,
  contextFiles,
  contextFilesError,
  contextFilesLoading,
  contextSaveError,
  contextSavePending,
  dashboardPending,
  generateError,
  generatePending,
  graphError,
  graphLoading,
  hasLiveRepositories,
  knowledgeGraph,
  locale,
  onboarding,
  onApprovePrd,
  onBack,
  onGenerateGraph,
  onOpenDashboard,
  onSelectTask,
  onSaveContextFile,
  onSync,
  openError,
  repository,
  selectedTask,
  sync,
  syncBusy,
  syncStatus,
  tasks,
  trace,
  traceLoading,
}: {
  approvalError: Error | null;
  approvalPending: boolean;
  contextFiles: RepositoryContextFile[];
  contextFilesError: boolean;
  contextFilesLoading: boolean;
  contextSaveError: Error | null;
  contextSavePending: boolean;
  dashboardPending: boolean;
  generateError: Error | null;
  generatePending: boolean;
  graphError: boolean;
  graphLoading: boolean;
  hasLiveRepositories: boolean;
  knowledgeGraph?: ProjectKnowledgeGraph;
  locale: Locale;
  onboarding?: RepositoryOnboarding;
  onApprovePrd: () => void;
  onBack: () => void;
  onGenerateGraph: (full: boolean) => void;
  onOpenDashboard: () => void;
  onSelectTask: (taskId: string) => void;
  onSaveContextFile: (input: {
    kind: RepositoryContextFileKind;
    path: string;
    content: string;
  }) => void;
  onSync: () => void;
  openError: Error | null;
  repository?: RepositoryQueueSummary;
  selectedTask?: Task;
  sync?: GitHubSyncState;
  syncBusy: boolean;
  syncStatus: GitHubSyncState["status"];
  tasks: Task[];
  trace?: TaskTrace;
  traceLoading: boolean;
}) {
  const t = text[locale];
  const [openGraphModal, setOpenGraphModal] = useState<
    "codeGraph" | "knowledgeGraph" | "repositoryContext" | null
  >(null);

  useEffect(() => {
    setOpenGraphModal(null);
  }, [repository?.id]);

  if (!repository) {
    return <EmptyState label={t.apiUnavailable} />;
  }

  return (
    <div className="dashboardStack">
      <section className="repositoryHero" aria-label={repository.fullName}>
        <button className="iconButton neutral" onClick={onBack} type="button">
          <ChevronLeft size={16} aria-hidden />
          <span>{locale === "zh" ? "返回仓库" : "Back"}</span>
        </button>
        <div>
          <p className="eyebrow">
            {repository.configured ? t.configured : t.unconfigured}
          </p>
          <h2>{repository.fullName}</h2>
          <span>
            {repository.queuedCount} {t.queued} · {repository.runningCount}/
            {repository.maxConcurrentIssues} {t.running} ·{" "}
            {repository.availableSlots}{" "}
            {locale === "zh" ? "可用槽位" : "available slots"}
          </span>
        </div>
        <div className="sectionActions">
          {hasLiveRepositories ? (
            <span className={`syncState syncState-${syncStatus}`}>
              {formatGitHubSyncLabel(locale, sync)}
            </span>
          ) : null}
          <button
            className="iconButton neutral"
            disabled={
              !repository.configured || !hasLiveRepositories || syncBusy
            }
            onClick={onSync}
            type="button"
          >
            <RotateCcw size={16} aria-hidden />
            <span>{syncBusy ? t.githubSyncing : t.githubSync}</span>
          </button>
        </div>
      </section>

      <section className="metrics repositoryMetrics" aria-label={t.taskMetrics}>
        <Metric
          icon={<Clock3 size={18} />}
          label={t.queued}
          value={repository.queuedCount}
        />
        <Metric
          icon={<Search size={18} />}
          label={t.running}
          value={`${repository.runningCount}/${repository.maxConcurrentIssues}`}
        />
        <Metric
          icon={<ShieldCheck size={18} />}
          label={t.review}
          value={repository.reviewCount}
        />
        <Metric
          icon={<AlertTriangle size={18} />}
          label={t.blocked}
          value={repository.blockedCount}
        />
        <Metric
          icon={<Check size={18} />}
          label={t.completed}
          value={repository.completedCount}
        />
      </section>

      <section className="graphDeck" aria-label={t.graphOverview}>
        <CodeGraphLaunchButton
          locale={locale}
          onboarding={onboarding}
          onOpen={() => setOpenGraphModal("codeGraph")}
          task={selectedTask}
          trace={trace}
        />

        <KnowledgeGraphLaunchButton
          knowledgeGraph={knowledgeGraph}
          locale={locale}
          loading={graphLoading}
          onOpen={() => setOpenGraphModal("knowledgeGraph")}
        />

        <RepositoryContextLaunchButton
          contextFiles={contextFiles}
          locale={locale}
          onOpen={() => setOpenGraphModal("repositoryContext")}
          repository={repository}
        />
      </section>

      {openGraphModal ? (
        <GraphModal
          closeLabel={t.close}
          label={
            openGraphModal === "codeGraph"
              ? t.codeGraph
              : openGraphModal === "knowledgeGraph"
                ? t.knowledgeGraph
                : locale === "zh"
                  ? "仓库 Skill / Rule"
                  : "Repository Skill / Rule"
          }
          onClose={() => setOpenGraphModal(null)}
        >
          {openGraphModal === "codeGraph" ? (
            <RepositoryCodeGraphPanel
              locale={locale}
              onboarding={onboarding}
              repository={repository}
              task={selectedTask}
              trace={trace}
            />
          ) : openGraphModal === "knowledgeGraph" ? (
            <KnowledgeGraphPanel
              dashboardPending={dashboardPending}
              generateError={generateError}
              generatePending={generatePending}
              knowledgeGraph={knowledgeGraph}
              locale={locale}
              loading={graphLoading}
              onGenerate={onGenerateGraph}
              onOpen={onOpenDashboard}
              openError={openError}
              repository={repository}
              unavailable={
                !hasLiveRepositories || !repository.configured || graphError
              }
            />
          ) : (
            <RepositoryContextPanel
              files={contextFiles}
              loading={contextFilesLoading}
              locale={locale}
              onSave={onSaveContextFile}
              repository={repository}
              saveError={contextSaveError}
              savePending={contextSavePending}
              unavailable={
                !hasLiveRepositories ||
                !repository.configured ||
                contextFilesError
              }
            />
          )}
        </GraphModal>
      ) : null}

      <section className="repositoryDetailGrid" aria-label={t.agentWorkspace}>
        <TaskListPanel
          locale={locale}
          onSelectTask={onSelectTask}
          repository={repository}
          selectedTask={selectedTask}
          tasks={tasks}
        />
        <section className="detailPanel" aria-label="Selected task details">
          {selectedTask && trace ? (
            <TaskDetail
              approvalError={approvalError}
              approvalPending={approvalPending}
              locale={locale}
              onApprovePrd={onApprovePrd}
              task={selectedTask}
              trace={trace}
              traceLoading={traceLoading}
            />
          ) : (
            <EmptyState label={t.noTaskSelected} />
          )}
        </section>
      </section>
    </div>
  );
}

function TaskListPanel({
  locale,
  onSelectTask,
  repository,
  selectedTask,
  tasks,
}: {
  locale: Locale;
  onSelectTask: (taskId: string) => void;
  repository: RepositoryQueueSummary;
  selectedTask?: Task;
  tasks: Task[];
}) {
  const t = text[locale];

  return (
    <section className="taskGrid" aria-label={t.tasks}>
      <div className="sectionHeader">
        <div>
          <h2>{locale === "zh" ? "排队 Issue" : "Queued issues"}</h2>
          <span>
            {repository.queuedCount} {t.queued} · {repository.runningCount}/
            {repository.maxConcurrentIssues} {t.running}
          </span>
        </div>
        <RotateCcw size={18} aria-hidden />
      </div>
      {tasks.length > 0 ? (
        tasks.map((task) => (
          <button
            className={`taskRow ${task.id === selectedTask?.id ? "taskRowSelected" : ""}`}
            key={task.id}
            onClick={() => onSelectTask(task.id)}
            type="button"
          >
            <div className="issueCell">
              <span className="issueTitle">
                #{task.issue.number} {task.issue.title}
              </span>
              <span>
                {task.issue.owner}/{task.issue.repo} · base{" "}
                {task.issue.baseBranch}
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
  );
}

function MemoryInboxPanel({
  hasLiveMemories,
  locale,
  memories,
  memoryError,
  memoryPending,
  onMemoryStatus,
}: {
  hasLiveMemories: boolean;
  locale: Locale;
  memories: MemoryRecord[];
  memoryError: boolean;
  memoryPending: boolean;
  onMemoryStatus: (id: string, status: "approved" | "rejected") => void;
}) {
  const t = text[locale];

  return (
    <section className="memoryPanel overviewMemory" aria-label={t.memoryInbox}>
      <div className="sectionHeader">
        <div>
          <h2>{t.memoryInbox}</h2>
          <span>{memoryError ? t.apiUnavailable : t.approveBeforeReuse}</span>
        </div>
        <ListChecks size={18} aria-hidden />
      </div>

      <div className="memoryList">
        {memories.map((memory) => (
          <article className="memoryItem" key={memory.id}>
            <div className="memoryMeta">
              <span>{memory.kind}</span>
              <span>
                {memory.scope === "repository"
                  ? `${memory.owner}/${memory.repo}`
                  : "global"}
              </span>
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
                disabled={memoryPending || !hasLiveMemories}
                onClick={() => onMemoryStatus(memory.id, "approved")}
                title={t.approve}
                type="button"
              >
                <Check size={16} aria-hidden />
                <span>{t.approve}</span>
              </button>
              <button
                className="iconButton danger"
                disabled={memoryPending || !hasLiveMemories}
                onClick={() => onMemoryStatus(memory.id, "rejected")}
                title={t.reject}
                type="button"
              >
                <X size={16} aria-hidden />
                <span>{t.reject}</span>
              </button>
            </div>
          </article>
        ))}
        {memories.length === 0 ? (
          <EmptyState
            label={memoryError ? t.apiUnavailable : t.approveBeforeReuse}
          />
        ) : null}
      </div>
    </section>
  );
}

function formatGitHubSyncLabel(locale: Locale, sync?: GitHubSyncState): string {
  const t = text[locale];

  if (!sync) {
    return t.githubSyncIdle;
  }

  if (sync.status === "running") {
    return sync.lastStartedAt
      ? `${t.githubSyncing} · ${formatTime(sync.lastStartedAt)}`
      : t.githubSyncing;
  }

  if (sync.status === "failed") {
    return t.githubSyncFailed(sync.lastError ?? "unknown");
  }

  if (sync.status === "finished" && sync.lastResult && sync.lastFinishedAt) {
    return t.githubSyncSummary(
      sync.lastResult.importedIssues,
      sync.lastResult.importedFeedbackComments,
      formatTime(sync.lastFinishedAt),
    );
  }

  return t.githubSyncIdle;
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
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
  selected,
}: {
  locale: Locale;
  onSelect: () => void;
  repository: RepositoryQueueSummary;
  selected: boolean;
}) {
  const utilization =
    repository.maxConcurrentIssues > 0
      ? Math.min(
          100,
          Math.round(
            (repository.runningCount / repository.maxConcurrentIssues) * 100,
          ),
        )
      : 0;
  const t = text[locale];

  return (
    <button
      className={`repositoryCard ${selected ? "repositoryCardSelected" : ""}`}
      onClick={onSelect}
      type="button"
    >
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
      <div
        className="repositoryConfigPaths"
        aria-label={
          locale === "zh"
            ? "仓库 Skill 与 Rule 配置"
            : "Repository skill and rule config"
        }
      >
        <span>
          <small>Skill</small>
          {repository.projectSkillPath}
        </span>
        <span>
          <small>Rule</small>
          {repository.projectRulePath}
        </span>
      </div>
    </button>
  );
}

function CodeGraphLaunchButton({
  locale,
  onboarding,
  onOpen,
  task,
  trace,
}: {
  locale: Locale;
  onboarding?: RepositoryOnboarding;
  onOpen: () => void;
  task?: Task;
  trace?: TaskTrace;
}) {
  const t = text[locale];
  const graphArtifacts = collectCodeGraphArtifacts(trace);
  const graphSpans = collectCodeGraphSpans(trace);
  const status = resolveCodeGraphStatus(onboarding, graphArtifacts, graphSpans);
  const stats = [
    { label: t.indexedFiles, value: onboarding?.summary?.files ?? "-" },
    {
      label: t.contextFiles,
      value: task?.contextPack?.relevantFiles.length ?? "-",
    },
  ];

  return (
    <GraphLaunchButton
      description={t.codeGraphSummary}
      icon={<GitBranch size={20} aria-hidden />}
      onOpen={onOpen}
      stats={stats}
      status={status}
      statusLabel={graphStatusLabel(locale, status)}
      title={t.codeGraph}
    />
  );
}

function KnowledgeGraphLaunchButton({
  knowledgeGraph,
  locale,
  loading,
  onOpen,
}: {
  knowledgeGraph?: ProjectKnowledgeGraph;
  locale: Locale;
  loading: boolean;
  onOpen: () => void;
}) {
  const t = text[locale];
  const status = knowledgeGraph?.status ?? (loading ? "generating" : "missing");
  const stats = [
    { label: t.nodes, value: knowledgeGraph?.graph?.nodes ?? "-" },
    { label: t.edges, value: knowledgeGraph?.graph?.edges ?? "-" },
  ];

  return (
    <GraphLaunchButton
      description={t.knowledgeGraphSummary}
      icon={<Network size={20} aria-hidden />}
      onOpen={onOpen}
      stats={stats}
      status={status}
      statusLabel={loading ? t.loading : graphStatusLabel(locale, status)}
      title={t.knowledgeGraph}
    />
  );
}

function RepositoryContextLaunchButton({
  contextFiles,
  locale,
  onOpen,
  repository,
}: {
  contextFiles: RepositoryContextFile[];
  locale: Locale;
  onOpen: () => void;
  repository: RepositoryQueueSummary;
}) {
  const skillCount = contextFiles.filter((file) => file.kind === "skill").length;
  const ruleCount = contextFiles.filter((file) => file.kind === "rule").length;

  return (
    <GraphLaunchButton
      description={
        locale === "zh"
          ? "查看、编辑或新增仓库内的 SKILL.md 与规则 md 文件。"
          : "View, edit, or add repository SKILL.md and rule markdown files."
      }
      icon={<FileText size={20} aria-hidden />}
      onOpen={onOpen}
      stats={[
        {
          label: locale === "zh" ? "Skill" : "Skills",
          value: skillCount > 0 ? skillCount : repository.projectSkillPath,
        },
        {
          label: locale === "zh" ? "Rule" : "Rules",
          value: ruleCount > 0 ? ruleCount : repository.projectRulePath,
        },
      ]}
      status={repository.configured ? "ready" : "missing"}
      statusLabel={
        repository.configured
          ? locale === "zh"
            ? "已配置"
            : "Configured"
          : locale === "zh"
            ? "未配置"
            : "Missing"
      }
      title={locale === "zh" ? "仓库 Skill / Rule" : "Repository Skill / Rule"}
    />
  );
}

function GraphLaunchButton({
  description,
  icon,
  onOpen,
  stats,
  status,
  statusLabel,
  title,
}: {
  description: string;
  icon: React.ReactNode;
  onOpen: () => void;
  stats: Array<{ label: string; value: React.ReactNode }>;
  status: KnowledgeGraphStatus;
  statusLabel: string;
  title: string;
}) {
  return (
    <button className="graphLaunchButton" onClick={onOpen} type="button">
      <span className="graphLaunchTopline">
        <span className="graphLaunchIcon">{icon}</span>
        <span className={`graphStatus graphStatus-${status}`}>
          {statusLabel}
        </span>
      </span>
      <span className="graphLaunchTitle">{title}</span>
      <span className="graphLaunchDescription">{description}</span>
      <span className="graphLaunchStats">
        {stats.map((stat) => (
          <span key={stat.label}>
            <strong>{stat.value}</strong>
            {stat.label}
          </span>
        ))}
      </span>
    </button>
  );
}

function GraphModal({
  children,
  closeLabel,
  label,
  onClose,
}: {
  children: React.ReactNode;
  closeLabel: string;
  label: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modalBackdrop" onClick={onClose} role="presentation">
      <section
        aria-label={label}
        aria-modal="true"
        className="graphModal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="graphModalHeader">
          <h2>{label}</h2>
          <button
            aria-label={closeLabel}
            className="iconButton neutral"
            onClick={onClose}
            type="button"
          >
            <X size={16} aria-hidden />
            <span>{closeLabel}</span>
          </button>
        </div>
        <div className="graphModalContent">{children}</div>
      </section>
    </div>
  );
}

function RepositoryCodeGraphPanel({
  locale,
  onboarding,
  repository,
  task,
  trace,
}: {
  locale: Locale;
  onboarding?: RepositoryOnboarding;
  repository: RepositoryQueueSummary;
  task?: Task;
  trace?: TaskTrace;
}) {
  const t = text[locale];
  const graphArtifacts = collectCodeGraphArtifacts(trace);
  const graphSpans = collectCodeGraphSpans(trace);
  const status = resolveCodeGraphStatus(onboarding, graphArtifacts, graphSpans);
  const statusLabel = graphStatusLabel(locale, status);
  const documents = onboarding?.documents ?? [];
  const [selectedDocumentPath, setSelectedDocumentPath] = useState<
    string | undefined
  >();
  const defaultDocument = pickDefaultOnboardingDocument(documents);
  const selectedDocument =
    documents.find((document) => document.path === selectedDocumentPath) ??
    defaultDocument;

  useEffect(() => {
    if (documents.length === 0) {
      setSelectedDocumentPath(undefined);
      return;
    }

    if (!selectedDocumentPath) {
      setSelectedDocumentPath(defaultDocument?.path);
      return;
    }

    if (!documents.some((document) => document.path === selectedDocumentPath)) {
      setSelectedDocumentPath(defaultDocument?.path);
    }
  }, [defaultDocument?.path, documents, selectedDocumentPath]);

  return (
    <section className="knowledgeGraphPanel" aria-label={t.codeGraph}>
      <div className="sectionHeader">
        <div>
          <h2>
            {repository.fullName} {t.codeGraph}
          </h2>
          <span>{t.codeGraphHint}</span>
        </div>
        <GitBranch size={18} aria-hidden />
      </div>
      <div className="codeGraphBody">
        <div className="knowledgeGraphInfo">
          <div className={`graphStatus graphStatus-${status}`}>
            {statusLabel}
          </div>
          <div className="graphStats">
            <span>
              <strong>{onboarding?.summary?.files ?? "-"}</strong>
              {t.indexedFiles}
            </span>
            <span>
              <strong>{task?.contextPack?.relevantFiles.length ?? "-"}</strong>
              {t.contextFiles}
            </span>
          </div>
          <p className="graphMessage">{t.contextPackHint}</p>
          <p className="graphMessage">{t.traceSpansHint}</p>
        </div>
        <div className="codeGraphArtifactPane">
          <div className="codeGraphArtifactList">
            {onboarding?.cacheDatabaseFile ? (
              <article>
                <strong>{t.codeGraphDb}</strong>
                <span>{compactArtifactPath(onboarding.cacheDatabaseFile)}</span>
                {onboarding.codeGraph ? (
                  <p>
                    {localizeCodeGraphOperation(
                      locale,
                      onboarding.codeGraph.operation,
                    )}{" "}
                    ·{" "}
                    {localizeCodeGraphChangeDetection(
                      locale,
                      onboarding.codeGraph.changeDetection,
                    )}
                  </p>
                ) : null}
              </article>
            ) : null}
            {documents.slice(0, 4).map((document) => (
              <button
                className={`codeGraphDocumentButton ${document.path === selectedDocument?.path ? "codeGraphDocumentSelected" : ""}`}
                key={document.path}
                onClick={() => setSelectedDocumentPath(document.path)}
                type="button"
              >
                <strong>
                  {localizeOnboardingDocument(locale, document.type)}
                </strong>
                <span>{document.path}</span>
              </button>
            ))}
            {!onboarding?.cacheDatabaseFile && documents.length === 0 ? (
              <p>{t.codeGraphDisabled}</p>
            ) : null}
            {onboarding?.message ? (
              <p>
                {localizeRepositoryOnboardingMessage(
                  locale,
                  onboarding.message,
                )}
              </p>
            ) : null}
          </div>
          {selectedDocument ? (
            <MarkdownPreview
              document={selectedDocument}
              title={t.previewDocument}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function pickDefaultOnboardingDocument(
  documents: RepositoryOnboarding["documents"] = [],
) {
  return (
    documents.find((document) => document.type === "project") ??
    documents.find((document) => /project|README/i.test(document.path)) ??
    documents[0]
  );
}

function MarkdownPreview({
  document,
  title,
}: {
  document: NonNullable<RepositoryOnboarding["documents"]>[number];
  title: string;
}) {
  return (
    <article className="markdownPreview">
      <div className="markdownPreviewHeader">
        <strong>{title}</strong>
        <span>{document.path}</span>
      </div>
      <pre>{document.content?.trim() || document.path}</pre>
    </article>
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
  unavailable,
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
  const displayedStatus =
    knowledgeGraph?.status ?? (loading ? "generating" : "missing");
  const knowledgeStatusLabel = loading
    ? t.loading
    : graphStatusLabel(locale, displayedStatus);
  const statusHelp = knowledgeGraphStatusHelp(
    locale,
    knowledgeGraph,
    loading,
    unavailable,
  );
  const [autoOpenAttempted, setAutoOpenAttempted] = useState(false);

  useEffect(() => {
    if (
      ready &&
      !unavailable &&
      !dashboardPending &&
      !knowledgeGraph?.dashboardUrl &&
      !autoOpenAttempted
    ) {
      setAutoOpenAttempted(true);
      onOpen();
    }
  }, [
    autoOpenAttempted,
    dashboardPending,
    knowledgeGraph?.dashboardUrl,
    onOpen,
    ready,
    unavailable,
  ]);

  return (
    <section className="knowledgeGraphPanel" aria-label={t.knowledgeGraph}>
      <div className="sectionHeader">
        <div>
          <h2>
            {repository.fullName} {t.knowledgeGraph}
          </h2>
          <span>
            <a
              href="https://github.com/Lum1104/Understand-Anything"
              rel="noreferrer"
              target="_blank"
            >
              Understand-Anything
            </a>{" "}
            {t.knowledgeGraphHint}
          </span>
        </div>
        <Network size={18} aria-hidden />
      </div>
      <div className="knowledgeGraphBody">
        <div className="knowledgeGraphInfo">
          <div className="graphStatusRow">
            <div className={`graphStatus graphStatus-${displayedStatus}`}>
              {knowledgeStatusLabel}
            </div>
            <button
              className="iconButton neutral"
              disabled={unavailable || busy}
              onClick={() => onGenerate(ready)}
              type="button"
            >
              <RotateCcw size={16} aria-hidden />
              <span>
                {busy ? t.generating : ready ? t.regenerate : t.generateGraph}
              </span>
            </button>
          </div>
          {knowledgeGraph?.graph ? (
            <div className="graphStats">
              <span>
                <strong>{knowledgeGraph.graph.nodes ?? "-"}</strong>
                {t.nodes}
              </span>
              <span>
                <strong>{knowledgeGraph.graph.edges ?? "-"}</strong>
                {t.edges}
              </span>
            </div>
          ) : (
            <LongText
              className="graphMessage"
              label={t.viewFullDetails}
              text={statusHelp}
            />
          )}
          {knowledgeGraph?.graph?.analyzedAt ? (
            <p className="graphMessage">
              {locale === "zh"
                ? `分析时间：${formatTime(knowledgeGraph.graph.analyzedAt)}`
                : `Analyzed: ${formatTime(knowledgeGraph.graph.analyzedAt)}`}
            </p>
          ) : null}
          {knowledgeGraph?.provider ? (
            <div className="graphArtifactList compactArtifactList">
              <article>
                <strong>{locale === "zh" ? "图谱文件" : "Graph file"}</strong>
                <span>{knowledgeGraph.provider.outputFile}</span>
              </article>
              <article>
                <strong>{locale === "zh" ? "分析工具" : "Provider"}</strong>
                <span>
                  {knowledgeGraph.provider.name}{" "}
                  {knowledgeGraph.provider.testedVersion}
                </span>
              </article>
            </div>
          ) : null}
          {generateError ? (
            <LongText
              className="graphError"
              label={t.viewFullDetails}
              text={generateError.message}
            />
          ) : null}
        </div>
        {knowledgeGraph?.dashboardUrl ? (
          <iframe
            className="knowledgeGraphFrame"
            src={knowledgeGraph.dashboardUrl}
            title={`${repository.fullName} Understand-Anything dashboard`}
          />
        ) : (
          <div className="graphPreviewPlaceholder">
            <Network size={36} aria-hidden />
            <strong>{t.officialDashboardViewer}</strong>
            {dashboardPending ? <span>{t.startingDashboard}</span> : null}
            {!dashboardPending && openError ? (
              <>
                <LongText
                  className="graphError"
                  label={t.viewFullDetails}
                  text={openError.message}
                />
                <button
                  className="iconButton positive"
                  disabled={unavailable || !ready}
                  onClick={onOpen}
                  type="button"
                >
                  <RotateCcw size={16} aria-hidden />
                  <span>{t.reopenDashboard}</span>
                </button>
              </>
            ) : null}
            {!dashboardPending && !openError ? (
              <span>
                {ready ? t.startingDashboard : t.dashboardMissingHint}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function RepositoryContextPanel({
  files,
  loading,
  locale,
  onSave,
  repository,
  saveError,
  savePending,
  unavailable,
}: {
  files: RepositoryContextFile[];
  loading: boolean;
  locale: Locale;
  onSave: (input: {
    kind: RepositoryContextFileKind;
    path: string;
    content: string;
  }) => void;
  repository: RepositoryQueueSummary;
  saveError: Error | null;
  savePending: boolean;
  unavailable: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [isCreating, setIsCreating] = useState(false);
  const [draftKind, setDraftKind] =
    useState<RepositoryContextFileKind>("skill");
  const [draftPath, setDraftPath] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const selectedFile = files.find((file) => file.path === selectedPath);
  const activeFile = selectedFile ?? (!isCreating ? files[0] : undefined);
  const skillFiles = files.filter((file) => file.kind === "skill");
  const ruleFiles = files.filter((file) => file.kind === "rule");
  const editorKind =
    isCreating || draftPath ? draftKind : activeFile?.kind ?? draftKind;
  const editorPath =
    isCreating || draftPath ? draftPath : activeFile?.path ?? "";
  const editorContent =
    isCreating || draftPath ? draftContent : activeFile?.content ?? "";

  useEffect(() => {
    if (isCreating) {
      if (files.some((file) => file.path === draftPath)) {
        setSelectedPath(draftPath);
        setIsCreating(false);
      }
      return;
    }

    if (files.length === 0) {
      setSelectedPath(undefined);
      return;
    }

    if (!selectedPath || !files.some((file) => file.path === selectedPath)) {
      setSelectedPath(files[0]?.path);
    }
  }, [draftPath, files, isCreating, selectedPath]);

  useLayoutEffect(() => {
    if (!activeFile || isCreating) {
      return;
    }

    setDraftKind(activeFile.kind);
    setDraftPath(activeFile.path);
    setDraftContent(activeFile.content);
  }, [activeFile?.content, activeFile?.kind, activeFile?.path, isCreating]);

  const startNewFile = (kind: RepositoryContextFileKind) => {
    const nextPath = defaultNewContextPath(kind, repository, files);
    setSelectedPath(undefined);
    setIsCreating(true);
    setDraftKind(kind);
    setDraftPath(nextPath);
    setDraftContent(defaultContextFileContent(kind, locale));
  };
  const canSave = Boolean(editorPath.trim()) && !savePending && !unavailable;

  return (
    <section
      className="knowledgeGraphPanel repositoryContextPanel"
      aria-label={locale === "zh" ? "仓库 Skill 和 Rule" : "Repository context"}
    >
      <div className="sectionHeader">
        <div>
          <h2>
            {repository.fullName}{" "}
            {locale === "zh" ? "仓库 Skill / Rule" : "Repository Skill / Rule"}
          </h2>
          <span>
            {locale === "zh"
              ? "管理这个仓库独立的业务 Skill 与项目规则。"
              : "Manage repository-specific business skills and project rules."}
          </span>
        </div>
        <FileText size={18} aria-hidden />
      </div>

      {loading ? (
        <EmptyState label={locale === "zh" ? "加载中" : "Loading"} />
      ) : (
        <div className="contextFileBody">
          <aside className="contextFileList">
            <div className="contextFileActions">
              <button
                className="iconButton neutral"
                disabled={unavailable}
                onClick={() => startNewFile("skill")}
                type="button"
              >
                <Plus size={16} aria-hidden />
                <span>{locale === "zh" ? "添加 Skill" : "Add Skill"}</span>
              </button>
              <button
                className="iconButton neutral"
                disabled={unavailable}
                onClick={() => startNewFile("rule")}
                type="button"
              >
                <Plus size={16} aria-hidden />
                <span>{locale === "zh" ? "添加 Rule" : "Add Rule"}</span>
              </button>
            </div>

            <ContextFileGroup
              files={skillFiles}
              isCreating={isCreating}
              locale={locale}
              onSelect={(file) => {
                setIsCreating(false);
                setSelectedPath(file.path);
              }}
              selectedPath={activeFile?.path}
              title={locale === "zh" ? "Skill" : "Skills"}
            />
            <ContextFileGroup
              files={ruleFiles}
              isCreating={isCreating}
              locale={locale}
              onSelect={(file) => {
                setIsCreating(false);
                setSelectedPath(file.path);
              }}
              selectedPath={activeFile?.path}
              title={locale === "zh" ? "Rule" : "Rules"}
            />
            {files.length === 0 && !isCreating ? (
              <EmptyState
                label={
                  unavailable
                    ? locale === "zh"
                      ? "无法读取仓库配置文件"
                      : "Context files unavailable"
                    : locale === "zh"
                      ? "还没有 Skill 或 Rule"
                      : "No skills or rules yet"
                }
              />
            ) : null}
          </aside>

          <form
            className="contextFileEditor"
            onSubmit={(event) => {
              event.preventDefault();

              if (canSave) {
                onSave({
                  kind: editorKind,
                  path: editorPath.trim(),
                  content: editorContent,
                });
              }
            }}
          >
            <div className="contextEditorHeader">
              <div>
                <span>{contextKindLabel(editorKind, locale)}</span>
                <strong>
                  {isCreating
                    ? locale === "zh"
                      ? "新增文件"
                      : "New file"
                    : activeFile?.name ||
                      (locale === "zh" ? "选择文件" : "Select a file")}
                </strong>
              </div>
              <button
                className="iconButton positive"
                disabled={!canSave}
                type="submit"
              >
                <Save size={16} aria-hidden />
                <span>
                  {savePending
                    ? locale === "zh"
                      ? "保存中"
                      : "Saving"
                    : locale === "zh"
                      ? "保存"
                      : "Save"}
                </span>
              </button>
            </div>
            <label className="contextPathField">
              <span>{locale === "zh" ? "文件路径" : "File path"}</span>
              <input
                disabled={savePending || unavailable}
                onChange={(event) => setDraftPath(event.target.value)}
                value={editorPath}
              />
            </label>
            <label className="contextKindToggle">
              <span>{locale === "zh" ? "类型" : "Type"}</span>
              <select
                disabled={savePending || unavailable}
                onChange={(event) =>
                  setDraftKind(event.target.value as RepositoryContextFileKind)
                }
                value={editorKind}
              >
                <option value="skill">Skill</option>
                <option value="rule">Rule</option>
              </select>
            </label>
            <textarea
              className="contextMarkdownEditor"
              disabled={savePending || unavailable}
              onChange={(event) => setDraftContent(event.target.value)}
              spellCheck={false}
              value={editorContent}
            />
            {saveError ? (
              <div className="inlineError" role="alert">
                {saveError.message}
              </div>
            ) : null}
          </form>
        </div>
      )}
    </section>
  );
}

function ContextFileGroup({
  files,
  isCreating,
  locale,
  onSelect,
  selectedPath,
  title,
}: {
  files: RepositoryContextFile[];
  isCreating: boolean;
  locale: Locale;
  onSelect: (file: RepositoryContextFile) => void;
  selectedPath?: string;
  title: string;
}) {
  return (
    <div className="contextFileGroup">
      <h3>{title}</h3>
      {files.map((file) => (
        <button
          className={`contextFileButton ${!isCreating && file.path === selectedPath ? "contextFileButtonSelected" : ""}`}
          key={file.path}
          onClick={() => onSelect(file)}
          type="button"
        >
          <strong>{file.name}</strong>
          <span>{file.path}</span>
          {file.updatedAt ? (
            <small>
              {locale === "zh" ? "更新于" : "updated"}{" "}
              {formatTime(file.updatedAt)}
            </small>
          ) : null}
        </button>
      ))}
      {files.length === 0 ? (
        <p>{locale === "zh" ? "暂无文件" : "No files"}</p>
      ) : null}
    </div>
  );
}

function defaultNewContextPath(
  kind: RepositoryContextFileKind,
  repository: RepositoryQueueSummary,
  files: RepositoryContextFile[],
): string {
  const existingPaths = new Set(files.map((file) => file.path));

  for (let index = 1; index < 100; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const candidate =
      kind === "skill"
        ? `${repository.projectSkillPath}/skills/new-skill${suffix}/SKILL.md`
        : `${repository.projectRulePath}/new-rule${suffix}.md`;

    if (!existingPaths.has(candidate)) {
      return candidate;
    }
  }

  return kind === "skill"
    ? `${repository.projectSkillPath}/skills/new-skill/SKILL.md`
    : `${repository.projectRulePath}/new-rule.md`;
}

function defaultContextFileContent(
  kind: RepositoryContextFileKind,
  locale: Locale,
): string {
  if (kind === "skill") {
    return locale === "zh"
      ? 'version: "1.0.0"\n\n# 新 Skill\n\n## 使用场景\n- 在这里描述这个仓库的业务能力或实现约束。\n\n## 执行规则\n- 在这里写 agent 执行时必须遵守的步骤。\n'
      : 'version: "1.0.0"\n\n# New Skill\n\n## When to use\n- Describe the repository-specific capability or constraint here.\n\n## Rules\n- Add the steps the agent must follow.\n';
  }

  return locale === "zh"
    ? "# 新规则\n\n- 在这里写这个仓库必须遵守的项目规则。\n"
    : "# New Rule\n\n- Add the project rule this repository must follow.\n";
}

function contextKindLabel(
  kind: RepositoryContextFileKind,
  locale: Locale,
): string {
  if (kind === "skill") {
    return locale === "zh" ? "仓库 Skill" : "Repository Skill";
  }

  return locale === "zh" ? "仓库 Rule" : "Repository Rule";
}

function TaskDetail({
  approvalError,
  approvalPending,
  locale,
  onApprovePrd,
  task,
  trace,
  traceLoading,
}: {
  approvalError: Error | null;
  approvalPending: boolean;
  locale: Locale;
  onApprovePrd: () => void;
  task: Task;
  trace: TaskTrace;
  traceLoading: boolean;
}) {
  const t = text[locale];
  const tracePageSize = 12;
  const [tracePage, setTracePage] = useState(0);
  const tracePageCount = Math.max(
    1,
    Math.ceil(trace.spans.length / tracePageSize),
  );
  const safeTracePage = Math.min(tracePage, tracePageCount - 1);
  const visibleSpans = trace.spans.slice(
    safeTracePage * tracePageSize,
    safeTracePage * tracePageSize + tracePageSize,
  );
  const activeFiles = collectActiveFiles(trace);
  const failedSpans = trace.spans
    .filter((span) => span.status === "failed" || span.status === "blocked")
    .slice(-6);

  useEffect(() => {
    setTracePage(
      Math.max(0, Math.ceil(trace.spans.length / tracePageSize) - 1),
    );
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
            {task.issue.owner}/{task.issue.repo} · {t.updated}{" "}
            {formatTime(task.updatedAt)}
          </span>
        </div>
        <div className="detailHeaderActions">
          <StatusPill locale={locale} status={task.status} />
          {task.status === "PRD_REVIEW_REQUIRED" ? (
            <button
              className="iconButton positive"
              disabled={approvalPending}
              onClick={onApprovePrd}
              type="button"
            >
              <Check size={16} aria-hidden />
              <span>{approvalPending ? t.approving : t.approve}</span>
            </button>
          ) : null}
        </div>
      </div>

      {approvalError ? (
        <div className="inlineError" role="alert">
          {approvalError.message}
        </div>
      ) : null}

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

      <TaskPhaseList task={task} />

      <div className="traceSummary" aria-label="Trace summary">
        <TraceMetric label="Spans" value={trace.summary.totalSpans} />
        <TraceMetric label={t.tools} value={trace.summary.toolCalls} />
        <TraceMetric label={t.policies} value={trace.summary.policyDecisions} />
        <TraceMetric label={t.blocked} value={trace.summary.failedOrBlocked} />
      </div>

      <TaskInsightGrid
        task={task}
        activeFiles={activeFiles}
        failedSpans={failedSpans}
      />

      <div className="sectionHeader compact">
        <div>
          <h2>{t.traceReplay}</h2>
          <span>
            {traceLoading
              ? t.loadingTrace
              : t.spansFromIssueToPr(trace.spans.length)}
          </span>
        </div>
        <Clock3 size={18} aria-hidden />
      </div>

      {trace.spans.length > tracePageSize ? (
        <div className="paginationControls" aria-label={t.traceReplay}>
          <button
            disabled={safeTracePage === 0}
            onClick={() => setTracePage((page) => Math.max(0, page - 1))}
            type="button"
          >
            {t.previousPage}
          </button>
          <span>{t.tracePage(safeTracePage + 1, tracePageCount)}</span>
          <button
            disabled={safeTracePage >= tracePageCount - 1}
            onClick={() =>
              setTracePage((page) => Math.min(tracePageCount - 1, page + 1))
            }
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

function TaskPhaseList({ task }: { task: Task }) {
  const phases: Array<{
    id: string;
    label: string;
    statuses: Task["status"][];
  }> = [
    {
      id: "plan",
      label: "Plan",
      statuses: [
        "BRAINSTORMING",
        "PRD_DRAFTED",
        "PRD_REVIEW_REQUIRED",
        "PRD_APPROVED",
      ],
    },
    {
      id: "context",
      label: "Context",
      statuses: [
        "SANDBOX_PREPARING",
        "ISSUE_BRANCH_CREATED",
        "CODEBASE_INDEXING",
        "AGENTIC_SEARCHING",
        "CONTEXT_PACK_CREATED",
      ],
    },
    { id: "implement", label: "Action", statuses: ["IMPLEMENTING"] },
    {
      id: "review",
      label: "Review",
      statuses: ["QUALITY_GATES_RUNNING", "SUBAGENT_REVIEWING"],
    },
    {
      id: "pr",
      label: "PR",
      statuses: ["PR_CREATING", "HUMAN_REVIEW", "WAITING_MERGE", "DONE"],
    },
  ];

  const currentIndex = phases.findIndex((phase) =>
    phase.statuses.includes(task.status),
  );

  return (
    <ol className="phaseList" aria-label="Task phase progress">
      {phases.map((phase, index) => (
        <li
          className={
            index < currentIndex || task.status === "DONE"
              ? "phaseDone"
              : index === currentIndex
                ? "phaseCurrent"
                : "phasePending"
          }
          key={phase.id}
        >
          <span />
          <strong>{phase.label}</strong>
        </li>
      ))}
    </ol>
  );
}

function TaskInsightGrid({
  activeFiles,
  failedSpans,
  task,
}: {
  activeFiles: string[];
  failedSpans: TraceSpan[];
  task: Task;
}) {
  const reviewFindings = [
    ...(task.reviewResult?.blockingFindings ?? []).map(
      (finding) =>
        `${finding.title}${finding.file ? ` (${finding.file})` : ""}: ${finding.body}`,
    ),
    ...(task.reviewResult?.scopeViolations ?? []).map(
      (violation) => `Scope: ${violation}`,
    ),
    ...(task.reviewResult?.missingTests ?? []).map(
      (missingTest) => `Missing test: ${missingTest}`,
    ),
  ];
  const failedGates = (task.qualityGateResults ?? []).filter(
    (result) => !result.passed,
  );

  return (
    <div className="taskInsights" aria-label="Task execution details">
      <InsightCard
        title="Plan"
        value={task.planningDocument?.title ?? "Not drafted yet"}
        details={
          task.planningDocument?.implementationPlan.acceptanceCriteria ?? []
        }
      />
      <InsightCard
        title="Files"
        value={
          activeFiles.length > 0
            ? `${activeFiles.length} active`
            : "No file activity yet"
        }
        details={activeFiles.slice(0, 6)}
      />
      <InsightCard
        title="Quality"
        value={
          failedGates.length > 0
            ? `${failedGates.length} failing`
            : task.qualityGateResults?.length
              ? "Passing"
              : "Not run yet"
        }
        details={failedGates.map((gate) => `${gate.kind}: ${gate.command}`)}
      />
      <InsightCard
        title="Review"
        value={
          task.reviewResult
            ? task.reviewResult.approved
              ? "Approved"
              : "Needs repair"
            : "Not run yet"
        }
        details={reviewFindings}
      />
      <InsightCard
        title="Errors"
        value={failedSpans.length > 0 ? `${failedSpans.length} recent` : "None"}
        details={failedSpans.map((span) => `${span.name}: ${span.message}`)}
      />
    </div>
  );
}

function InsightCard({
  details,
  title,
  value,
}: {
  details: string[];
  title: string;
  value: string;
}) {
  return (
    <article className="insightCard">
      <span>{title}</span>
      <strong>{value}</strong>
      {details.length > 0 ? (
        <ul>
          {details.slice(0, 5).map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </article>
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
  const metadata = traceMetadataEntries(span);

  return (
    <li className={`traceRow trace-${span.kind}`}>
      <div className="traceMarker" aria-hidden />
      <div>
        <div className="traceTopline">
          <strong>{span.name}</strong>
          <span>{span.kind.replaceAll("_", " ")}</span>
        </div>
        <LongText label={label} text={span.message} />
        {metadata.length > 0 ? (
          <div className="traceMeta">
            {metadata.map(([key, value]) => (
              <span key={key}>
                {key}: {value}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <span className={`traceStatus status-${span.status}`}>{span.status}</span>
    </li>
  );
}

function traceMetadataEntries(span: TraceSpan): Array<[string, string]> {
  const metadata = span.metadata ?? {};
  const keys = ["eventType", "filePath", "command", "toolName", "stream"];

  return keys
    .map((key): [string, string] | undefined => {
      const value = metadata[key];
      return typeof value === "string" && value.length > 0
        ? [key, value.length > 160 ? `${value.slice(0, 160)}...` : value]
        : undefined;
    })
    .filter((entry): entry is [string, string] => Boolean(entry));
}

function collectActiveFiles(trace: TaskTrace): string[] {
  return trace.spans
    .flatMap((span) => {
      const metadata = span.metadata ?? {};
      const filePaths = Array.isArray(metadata.filePaths)
        ? metadata.filePaths.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return [...filePaths, metadata.filePath].filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
    })
    .map((value) => value.replace(/\\/g, "/"))
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(-12);
}

function emptyTrace(task: Task): TaskTrace {
  return {
    taskId: task.id,
    status: task.status,
    issueUrl: task.issue.url,
    prUrl: task.prUrl,
    spans: [],
    artifacts: [],
    summary: {
      totalSpans: 0,
      toolCalls: 0,
      policyDecisions: 0,
      failedOrBlocked: 0,
    },
  };
}

function EmptyState({ label }: { label: string }) {
  return <div className="emptyState">{label}</div>;
}

function LongText({
  className,
  label,
  text: value,
}: {
  className?: string;
  label: string;
  text: string;
}) {
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

function isLiveTaskStatus(status: Task["status"] | undefined): boolean {
  return Boolean(
    status &&
    [
      "CONTEXT_COLLECTING",
      "BRAINSTORMING",
      "PRD_APPROVED",
      "SANDBOX_PREPARING",
      "ISSUE_BRANCH_CREATED",
      "CODEBASE_INDEXING",
      "AGENTIC_SEARCHING",
      "CONTEXT_PACK_CREATED",
      "IMPLEMENTING",
      "QUALITY_GATES_RUNNING",
      "SUBAGENT_REVIEWING",
      "PR_CREATING",
      "WAITING_MERGE",
    ].includes(status),
  );
}

function compactArtifactPath(value: string): string {
  const parts = value.split("/");
  return parts.length > 4 ? `.../${parts.slice(-4).join("/")}` : value;
}

function collectCodeGraphArtifacts(trace?: TaskTrace): TaskTrace["artifacts"] {
  return (trace?.artifacts ?? []).filter((artifact) =>
    ["repo-graph", "navigation-route", "context-pack"].includes(artifact.type),
  );
}

function collectCodeGraphSpans(trace?: TaskTrace): TraceSpan[] {
  return (trace?.spans ?? []).filter(
    (span) =>
      span.name.includes("CODEBASE_INDEXED") ||
      span.name.includes("AGENTIC_SEARCH") ||
      span.name.includes("REPO_NAVIGATION_GRAPH") ||
      span.name.includes("NAVIGATION_ROUTE"),
  );
}

function resolveCodeGraphStatus(
  onboarding: RepositoryOnboarding | undefined,
  graphArtifacts: TaskTrace["artifacts"],
  graphSpans: TraceSpan[],
): KnowledgeGraphStatus {
  const failed = graphSpans.some(
    (span) => span.status === "failed" || span.status === "blocked",
  );
  return (
    onboarding?.status ??
    (graphArtifacts.length > 0 ? "ready" : failed ? "failed" : "missing")
  );
}

function graphStatusLabel(
  locale: Locale,
  status: KnowledgeGraphStatus,
): string {
  const t = text[locale];

  if (status === "ready") return t.graphReady;
  if (status === "failed") return t.graphFailed;
  if (status === "generating") return t.generating;
  return t.graphMissing;
}

function knowledgeGraphStatusHelp(
  locale: Locale,
  knowledgeGraph: ProjectKnowledgeGraph | undefined,
  loading: boolean,
  unavailable: boolean,
): string {
  const t = text[locale];

  if (unavailable) {
    return t.connectApi;
  }

  if (loading) {
    return t.knowledgeGraphGeneratingHint;
  }

  const status = knowledgeGraph?.status ?? "missing";
  const message = knowledgeGraph?.message
    ? localizeProjectKnowledgeGraphMessage(locale, knowledgeGraph.message)
    : "";
  const base =
    status === "ready"
      ? t.knowledgeGraphReadyHint
      : status === "generating"
        ? t.knowledgeGraphGeneratingHint
        : status === "failed"
          ? t.knowledgeGraphFailedHint
          : t.knowledgeGraphMissingHint;

  return message ? `${base}\n${message}` : base;
}

function localizeOnboardingDocument(locale: Locale, type: string): string {
  if (locale === "en") {
    return type;
  }

  const labels: Record<string, string> = {
    project: "项目说明",
    "module-map": "模块说明",
    "route-map": "路由说明",
    "testing-guide": "测试指南",
    "repository-config": "仓库配置",
    policy: "策略说明",
  };

  return labels[type] ?? type;
}

function localizeCodeGraphOperation(
  locale: Locale,
  operation: NonNullable<RepositoryOnboarding["codeGraph"]>["operation"],
): string {
  if (locale === "en") {
    return operation;
  }

  return operation === "initialized" ? "首次建立索引" : "同步已有索引";
}

function localizeCodeGraphChangeDetection(
  locale: Locale,
  changeDetection: NonNullable<
    RepositoryOnboarding["codeGraph"]
  >["changeDetection"],
): string {
  if (locale === "en") {
    return changeDetection;
  }

  if (changeDetection === "initial-index") return "初次扫描";
  if (changeDetection === "restored-cache-hash-scan") return "复用缓存后校验";
  return "工作区变更同步";
}

function localizeRepositoryOnboardingMessage(
  locale: Locale,
  message: string,
): string {
  if (locale === "en") {
    return message;
  }

  if (message.includes("Repository onboarding is ready"))
    return "仓库初始化已完成。";
  if (message.includes("CodeGraph is indexing this repository"))
    return "正在为仓库建立代码索引。";
  if (message.includes("Repository onboarding is building CodeGraph"))
    return "正在生成代码图和仓库说明。";
  if (message.includes("CodeGraph onboarding failed"))
    return message.replace("CodeGraph onboarding failed", "代码图初始化失败");
  return message;
}

function localizeProjectKnowledgeGraphMessage(
  locale: Locale,
  message: string,
): string {
  if (locale === "en") {
    return message;
  }

  if (message.includes("Knowledge graph generated by Understand-Anything"))
    return "知识图谱已由 Understand-Anything 生成。";
  if (
    message.includes(
      "Preparing the repository for the official Understand-Anything analysis",
    )
  )
    return "正在准备仓库，随后会启动 Understand-Anything 官方分析。";
  if (
    message.includes(
      "The official Understand-Anything multi-agent pipeline is generating the project graph",
    )
  )
    return "Understand-Anything 官方多代理流程正在生成项目知识图谱。";
  if (message.includes("Understand-Anything is analyzing this repository"))
    return "Understand-Anything 正在分析这个仓库。";
  if (message.includes("previous Understand-Anything analysis was interrupted"))
    return "上一次 Understand-Anything 分析中断了，还没有产出图谱。可以重新生成。";
  if (message.includes("Install the official Understand-Anything Codex skill"))
    return "需要先安装官方 Understand-Anything Codex skill，才能生成知识图谱。";
  if (message.includes("No Understand-Anything knowledge graph exists"))
    return "这个仓库还没有 Understand-Anything 知识图谱，请先生成。";
  if (message.includes("Understand-Anything is not installed"))
    return "Understand-Anything 没有安装，暂时不能生成或打开官方 dashboard。";
  return message;
}
