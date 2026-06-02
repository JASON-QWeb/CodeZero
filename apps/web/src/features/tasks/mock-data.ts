import type {
  Artifact,
  QualityGateKind,
  Task,
  TaskStatus,
  TaskTrace,
  TraceSpan,
  TraceSpanKind,
  TraceSpanStatus,
} from "@agent/shared";
import { isQueuedStatus, isRunningStatus } from "./repository-summary";
import type {
  GitHubSyncResponse,
  GitHubSyncState,
  MemoryRecord,
  MemoryStatus,
  ProjectKnowledgeGraph,
  RepositoryContextFile,
  RepositoryContextFileKind,
  RepositoryOnboarding,
  RepositoryQueueSummary,
} from "./types";

const now = "2026-06-02T07:45:00.000Z";
const earlier = "2026-06-02T06:28:00.000Z";
const yesterday = "2026-06-01T14:20:00.000Z";

const seededTasks: Task[] = [
  createTask({
    id: "mock-task-128",
    owner: "JASON-QWeb",
    repo: "CodeZero",
    number: 128,
    title: "将项目规则目录纳入 agent 上下文",
    status: "QUALITY_GATES_RUNNING",
    branchName: "agent/issue-128-project-rule-context",
    prUrl: "https://github.com/JASON-QWeb/CodeZero/pull/136",
    labels: ["workflow", "agent-ready", "project-rules"],
    updatedAt: now,
    taskType: "fullstack",
    riskLevel: "medium",
  }),
  createTask({
    id: "mock-task-129",
    owner: "JASON-QWeb",
    repo: "CodeZero",
    number: 129,
    title: "设置控制台保存仓库规则路径后刷新摘要",
    status: "PRD_REVIEW_REQUIRED",
    branchName: "agent/issue-129-refresh-rule-path-summary",
    labels: ["frontend", "settings", "prd-review"],
    updatedAt: "2026-06-02T07:10:00.000Z",
    taskType: "fullstack",
    riskLevel: "medium",
  }),
  createTask({
    id: "mock-task-130",
    owner: "JASON-QWeb",
    repo: "CodeZero",
    number: 130,
    title: "PR 本地验证说明补充截图证据分组",
    status: "WAITING_MERGE",
    branchName: "agent/issue-130-pr-verification-screenshots",
    prUrl: "https://github.com/JASON-QWeb/CodeZero/pull/139",
    labels: ["workflow", "verification"],
    updatedAt: "2026-06-02T05:58:00.000Z",
    taskType: "docs",
    riskLevel: "low",
  }),
  createTask({
    id: "mock-task-204",
    owner: "JASON-QWeb",
    repo: "BeautySkillsHub",
    number: 204,
    title: "仓库 onboarding 文档预览补充规则文件",
    status: "IMPLEMENTING",
    branchName: "agent/issue-204-onboarding-rule-preview",
    labels: ["codegraph", "docs"],
    updatedAt: earlier,
    taskType: "fullstack",
    riskLevel: "low",
  }),
  createTask({
    id: "mock-task-205",
    owner: "JASON-QWeb",
    repo: "BeautySkillsHub",
    number: 205,
    title: "同步 GitHub 评论时识别 Agent 自检回复",
    status: "QUEUED",
    branchName: "agent/issue-205-agent-self-check-sync",
    labels: ["github-sync", "feedback-loop"],
    updatedAt: "2026-06-02T04:33:00.000Z",
    taskType: "backend",
    riskLevel: "medium",
  }),
  createTask({
    id: "mock-task-88",
    owner: "JASON-QWeb",
    repo: "CodeZero",
    number: 88,
    title: "中文 README 补齐设置控制台说明",
    status: "DONE",
    branchName: "agent/issue-88-zh-readme-settings-console",
    prUrl: "https://github.com/JASON-QWeb/CodeZero/pull/91",
    labels: ["docs", "zh-CN"],
    updatedAt: yesterday,
    taskType: "docs",
    riskLevel: "low",
  }),
  createTask({
    id: "mock-task-206",
    owner: "JASON-QWeb",
    repo: "BeautySkillsHub",
    number: 206,
    title: "主页滚动改成连续加载",
    status: "PRD_REVIEW_REQUIRED",
    branchName: "agent/issue-206-home-continuous-scroll",
    labels: ["frontend", "agent-ready", "ux"],
    updatedAt: "2026-06-01T09:30:00.000Z",
    taskType: "frontend",
    riskLevel: "medium",
  }),
  createTask({
    id: "mock-task-42",
    owner: "JASON-QWeb",
    repo: "agent-prd-automation",
    number: 42,
    title: "自管理工作流补充仓库运行摘要",
    status: "CODEBASE_INDEXING",
    branchName: "agent/issue-42-self-managed-run-summary",
    labels: ["codegraph", "workflow", "agent-ready"],
    updatedAt: "2026-05-31T18:10:00.000Z",
    taskType: "fullstack",
    riskLevel: "medium",
  }),
  createTask({
    id: "mock-task-43",
    owner: "JASON-QWeb",
    repo: "agent-prd-automation",
    number: 43,
    title: "PRD 审批后自动回填任务看板事件",
    status: "PR_CREATING",
    branchName: "agent/issue-43-prd-approval-board-events",
    labels: ["workflow", "observability"],
    updatedAt: "2026-06-01T12:10:00.000Z",
    taskType: "backend",
    riskLevel: "low",
  }),
  createTask({
    id: "mock-task-61",
    owner: "JASON-QWeb",
    repo: "SeeMusic",
    number: 61,
    title: "Mac 播放列表支持长内容连续滚动",
    status: "CONTEXT_PACK_CREATED",
    branchName: "agent/issue-61-playlist-continuous-scroll",
    labels: ["macos", "frontend", "agent-ready"],
    updatedAt: "2026-06-01T22:40:00.000Z",
    taskType: "frontend",
    riskLevel: "medium",
  }),
  createTask({
    id: "mock-task-62",
    owner: "JASON-QWeb",
    repo: "SeeMusic",
    number: 62,
    title: "本地播放状态截图补充键盘操作说明",
    status: "HUMAN_REVIEW",
    branchName: "agent/issue-62-local-playback-screenshot-notes",
    labels: ["macos", "verification"],
    updatedAt: "2026-05-30T10:15:00.000Z",
    taskType: "docs",
    riskLevel: "low",
  }),
  createTask({
    id: "mock-task-63",
    owner: "JASON-QWeb",
    repo: "SeeMusic",
    number: 63,
    title: "窗口恢复后记住上次播放面板",
    status: "DONE",
    branchName: "agent/issue-63-restore-player-panel",
    prUrl: "https://github.com/JASON-QWeb/SeeMusic/pull/64",
    labels: ["macos", "state"],
    updatedAt: "2026-05-29T15:25:00.000Z",
    taskType: "frontend",
    riskLevel: "low",
  }),
  createTask({
    id: "mock-task-17",
    owner: "JASON-QWeb",
    repo: "Didicall",
    number: 17,
    title: "滴滴 MCP 工具权限校验失败后给出可读原因",
    status: "BLOCKED",
    branchName: "agent/issue-17-mcp-permission-readable-error",
    labels: ["mcp", "permissions", "needs-review"],
    updatedAt: "2026-06-02T03:20:00.000Z",
    taskType: "backend",
    riskLevel: "high",
  }),
  createTask({
    id: "mock-task-18",
    owner: "JASON-QWeb",
    repo: "Didicall",
    number: 18,
    title: "浏览器联动调用前展示工具参数预览",
    status: "QUEUED",
    branchName: "agent/issue-18-browser-tool-argument-preview",
    labels: ["mcp", "browser", "agent-ready"],
    updatedAt: "2026-05-31T08:45:00.000Z",
    taskType: "fullstack",
    riskLevel: "medium",
  }),
  createTask({
    id: "mock-task-19",
    owner: "JASON-QWeb",
    repo: "Didicall",
    number: 19,
    title: "MCP 服务健康检查写入任务 Trace",
    status: "SUBAGENT_REVIEWING",
    branchName: "agent/issue-19-mcp-health-trace",
    labels: ["mcp", "observability"],
    updatedAt: "2026-05-28T13:55:00.000Z",
    taskType: "backend",
    riskLevel: "low",
  }),
  createTask({
    id: "mock-task-33",
    owner: "JASON-QWeb",
    repo: "mcp-tool-gateway",
    number: 33,
    title: "工具网关按仓库规则收敛可用 MCP 能力",
    status: "AGENTIC_SEARCHING",
    branchName: "agent/issue-33-repository-mcp-tool-scope",
    labels: ["mcp", "rules", "agent-ready"],
    updatedAt: "2026-06-01T16:05:00.000Z",
    taskType: "backend",
    riskLevel: "medium",
  }),
  createTask({
    id: "mock-task-34",
    owner: "JASON-QWeb",
    repo: "mcp-tool-gateway",
    number: 34,
    title: "PR 验证里补充工具调用审计摘要",
    status: "WAITING_MERGE",
    branchName: "agent/issue-34-tool-call-audit-pr-notes",
    prUrl: "https://github.com/JASON-QWeb/mcp-tool-gateway/pull/35",
    labels: ["mcp", "verification"],
    updatedAt: "2026-05-27T11:40:00.000Z",
    taskType: "docs",
    riskLevel: "low",
  }),
  createTask({
    id: "mock-task-35",
    owner: "JASON-QWeb",
    repo: "mcp-tool-gateway",
    number: 35,
    title: "浏览器工具超时后自动降级为只读摘要",
    status: "FAILED",
    branchName: "agent/issue-35-browser-tool-timeout-summary",
    labels: ["mcp", "browser", "resilience"],
    updatedAt: "2026-05-27T09:20:00.000Z",
    taskType: "backend",
    riskLevel: "medium",
  }),
];

let tasksState = clone(seededTasks);

const seededMemories: MemoryRecord[] = [
  {
    id: "mock-memory-verification",
    kind: "procedural",
    status: "proposed",
    scope: "repository",
    owner: "JASON-QWeb",
    repo: "CodeZero",
    title: "控制台改动的稳定验证顺序",
    content:
      "涉及任务看板、设置控制台或截图证据的改动，先跑 pnpm lint、pnpm typecheck、pnpm test，再补桌面和移动端截图。",
    tags: ["verification", "frontend", "screenshots", "settings-console"],
    confidence: 0.86,
    sourceTaskId: "mock-task-128",
    createdAt: earlier,
    updatedAt: now,
  },
  {
    id: "mock-memory-policy",
    kind: "policy",
    status: "proposed",
    scope: "repository",
    owner: "JASON-QWeb",
    repo: "CodeZero",
    title: "截图素材不得暴露本地路径和凭据",
    content:
      "录屏和截图只展示公开仓库名、脱敏路径和固定时间戳；不要出现 API key、GitHub token、个人邮箱或 /Users 本地路径。",
    tags: ["privacy", "screenshots", "local-data"],
    confidence: 0.91,
    sourceTaskId: "mock-task-204",
    createdAt: earlier,
    updatedAt: now,
  },
  {
    id: "mock-memory-contextpack",
    kind: "semantic",
    status: "proposed",
    scope: "global",
    title: "ContextPack 面板的讲解重点",
    content:
      "录制素材时先展示 CodeGraph，再切到 ContextPack，说明 agent 只读取少量高相关文件来控制上下文成本。",
    tags: ["context-pack", "knowledge-graph", "recording"],
    confidence: 0.79,
    sourceTaskId: "mock-task-128",
    createdAt: yesterday,
    updatedAt: earlier,
  },
];

let memoriesState = clone(seededMemories);

const seededContextFiles = new Map<string, RepositoryContextFile[]>([
  [
    "JASON-QWeb/CodeZero",
    [
      {
        kind: "skill",
        path: ".agent/skills/settings-console/SKILL.md",
        name: "settings-console",
        content:
          "# Settings Console\n\nWhen changing runtime configuration, keep repository quick settings, YAML validation, and saved section summaries in sync.\n",
        updatedAt: now,
      },
      {
        kind: "rule",
        path: ".agent/rules/chinese-docs.md",
        name: "chinese-docs",
        content:
          "# Chinese Docs\n\n文档默认使用中文；README 保持英文和中文两份，并且两边都要覆盖新增配置入口。\n",
        updatedAt: now,
      },
      {
        kind: "rule",
        path: ".agent/rules/screenshot-safety.md",
        name: "screenshot-safety",
        content:
          "# Screenshot Safety\n\nBefore publishing screenshots, remove local paths, personal account details, tokens, and raw runtime output.\n",
        updatedAt: earlier,
      },
    ],
  ],
  [
    "JASON-QWeb/BeautySkillsHub",
    [
      {
        kind: "skill",
        path: ".agent/skills/repository-onboarding/SKILL.md",
        name: "repository-onboarding",
        content:
          "# Repository Onboarding\n\nUse generated project documents, rule files, and code graph summaries before planning implementation work.\n",
        updatedAt: earlier,
      },
      {
        kind: "rule",
        path: ".agent/rules/agent-review.md",
        name: "agent-review",
        content:
          "# Agent Review\n\nEvery agent-authored PR needs local verification notes, review risk, and a concise change scope.\n",
        updatedAt: earlier,
      },
    ],
  ],
  [
    "JASON-QWeb/agent-prd-automation",
    [
      {
        kind: "skill",
        path: ".agent/skills/self-managed-workflow/SKILL.md",
        name: "self-managed-workflow",
        content:
          "# Self Managed Workflow\n\nWhen CodeZero updates its own workflow, preserve task state continuity, PRD approval history, and verification artifacts.\n",
        updatedAt: earlier,
      },
      {
        kind: "rule",
        path: ".agent/rules/dashboard-screenshots.md",
        name: "dashboard-screenshots",
        content:
          "# Dashboard Screenshots\n\n截图素材只展示公开仓库、固定时间戳、脱敏配置和可复现验证命令。\n",
        updatedAt: now,
      },
    ],
  ],
  [
    "JASON-QWeb/SeeMusic",
    [
      {
        kind: "skill",
        path: ".agent/skills/macos-playback-ui/SKILL.md",
        name: "macos-playback-ui",
        content:
          "# macOS Playback UI\n\nFor SeeMusic, verify long lists, playback state, keyboard shortcuts, and window restoration before proposing UI changes.\n",
        updatedAt: now,
      },
      {
        kind: "rule",
        path: ".agent/rules/local-media-privacy.md",
        name: "local-media-privacy",
        content:
          "# Local Media Privacy\n\n截图和日志不得展示本地音乐文件路径、用户目录、播放历史或未公开曲库名称。\n",
        updatedAt: earlier,
      },
    ],
  ],
  [
    "JASON-QWeb/Didicall",
    [
      {
        kind: "skill",
        path: ".agent/skills/didicall-mcp/SKILL.md",
        name: "didicall-mcp",
        content:
          "# Didicall MCP\n\nBefore changing MCP behavior, inspect tool schemas, permission gates, browser handoff, and timeout fallback paths.\n",
        updatedAt: now,
      },
      {
        kind: "rule",
        path: ".agent/rules/mcp-permission-review.md",
        name: "mcp-permission-review",
        content:
          "# MCP Permission Review\n\n涉及外部调用、浏览器联动或写入型工具时，PRD 必须说明权限边界、失败降级和审计记录。\n",
        updatedAt: now,
      },
    ],
  ],
  [
    "JASON-QWeb/mcp-tool-gateway",
    [
      {
        kind: "skill",
        path: ".agent/skills/tool-gateway-policy/SKILL.md",
        name: "tool-gateway-policy",
        content:
          "# Tool Gateway Policy\n\nRoute MCP tools through repository policy, keep read-only fallbacks available, and summarize tool calls in PR verification.\n",
        updatedAt: earlier,
      },
      {
        kind: "rule",
        path: ".agent/rules/tool-audit.md",
        name: "tool-audit",
        content:
          "# Tool Audit\n\n工具调用审计摘要需要包含工具名、权限、触发原因、失败路径和用户可复现命令。\n",
        updatedAt: now,
      },
    ],
  ],
]);

const contextFilesState = cloneContextFiles(seededContextFiles);

export async function mockFetchTasks(): Promise<Task[]> {
  return clone(tasksState);
}

export async function mockFetchRepositoryQueues(): Promise<
  RepositoryQueueSummary[]
> {
  return buildMockRepositorySummaries(tasksState);
}

export async function mockFetchGitHubSync(
  repositoryId: string,
): Promise<GitHubSyncState> {
  return clone(githubSyncState(repositoryId, "finished"));
}

export async function mockTriggerGitHubSync(
  repositoryId: string,
): Promise<GitHubSyncResponse> {
  return {
    started: true,
    sync: clone(githubSyncState(repositoryId, "finished")),
  };
}

export async function mockFetchProjectKnowledgeGraph(
  repositoryId: string,
): Promise<ProjectKnowledgeGraph> {
  return clone(knowledgeGraphFor(repositoryId));
}

export async function mockGenerateProjectKnowledgeGraph(input: {
  repositoryId: string;
}): Promise<ProjectKnowledgeGraph> {
  return clone(knowledgeGraphFor(input.repositoryId));
}

export async function mockOpenProjectKnowledgeGraphDashboard(
  repositoryId: string,
): Promise<ProjectKnowledgeGraph> {
  return clone({
    ...knowledgeGraphFor(repositoryId),
    dashboardUrl: `http://localhost:8787/snapshot/${repositorySlug(repositoryId)}`,
  });
}

export async function mockFetchRepositoryOnboarding(
  repositoryId: string,
): Promise<RepositoryOnboarding> {
  return clone(onboardingFor(repositoryId));
}

export async function mockFetchRepositoryContextFiles(
  repositoryId: string,
): Promise<RepositoryContextFile[]> {
  return clone(contextFilesState.get(repositoryId) ?? []);
}

export async function mockSaveRepositoryContextFile(input: {
  repositoryId: string;
  kind: RepositoryContextFileKind;
  path: string;
  content: string;
}): Promise<RepositoryContextFile[]> {
  const existing = contextFilesState.get(input.repositoryId) ?? [];
  const nextFile = {
    kind: input.kind,
    path: input.path,
    name: fileNameFromPath(input.path),
    content: input.content,
    updatedAt: now,
  } satisfies RepositoryContextFile;
  const next = [
    nextFile,
    ...existing.filter((file) => file.path !== input.path),
  ].sort((left, right) => left.path.localeCompare(right.path));
  contextFilesState.set(input.repositoryId, next);
  return clone(next);
}

export async function mockFetchTrace(taskId: string): Promise<TaskTrace> {
  const task = tasksState.find((item) => item.id === taskId) ?? tasksState[0];

  if (!task) {
    throw new Error("Mock task trace is unavailable");
  }

  return clone(traceFor(task));
}

export async function mockApproveTaskPrd(taskId: string): Promise<Task> {
  tasksState = tasksState.map((task) =>
    task.id === taskId
      ? {
          ...task,
          status: "PRD_APPROVED",
          updatedAt: now,
        }
      : task,
  );
  const task = tasksState.find((item) => item.id === taskId);

  if (!task) {
    throw new Error("Mock task is unavailable");
  }

  return clone(task);
}

export async function mockFetchMemories(
  status: MemoryStatus,
): Promise<MemoryRecord[]> {
  return clone(memoriesState.filter((memory) => memory.status === status));
}

export async function mockUpdateMemoryStatus(input: {
  id: string;
  status: Extract<MemoryStatus, "approved" | "rejected">;
}): Promise<MemoryRecord> {
  let updated: MemoryRecord | undefined;
  memoriesState = memoriesState.map((memory) => {
    if (memory.id !== input.id) {
      return memory;
    }

    updated = {
      ...memory,
      status: input.status,
      updatedAt: now,
    };
    return updated;
  });

  if (!updated) {
    throw new Error("Mock memory is unavailable");
  }

  return clone(updated);
}

function createTask(input: {
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  status: TaskStatus;
  branchName: string;
  prUrl?: string;
  labels: string[];
  updatedAt: string;
  taskType: "frontend" | "backend" | "fullstack" | "docs";
  riskLevel: "low" | "medium" | "high";
}): Task {
  return {
    id: input.id,
    issue: {
      provider: "github",
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      url: `https://github.com/${input.owner}/${input.repo}/issues/${input.number}`,
      title: input.title,
      body: [
        "用于截图数据模式的固定 Issue 内容。",
        "不包含 token、个人账号信息或本地运行路径。",
      ].join("\n"),
      labels: input.labels,
      comments: [
        {
          author: "product-ops",
          body: "请按当前 PRD 流程产出计划，并补充可截图的验证证据。",
          createdAt: earlier,
        },
      ],
      baseBranch: "main",
    },
    status: input.status,
    branchName: input.branchName,
    planningDocument: {
      title: input.title,
      background:
        "产品团队希望用一个可回放的 agent workflow 展示从 Issue 到 PR 的自动化过程。",
      goals: [
        "生成可审批的 PRD 和实现计划",
        "只读取与任务相关的上下文文件",
        "在 PR 中附带本地验证和截图证据",
      ],
      nonGoals: ["不接入真实客户数据", "不展示真实仓库 token 或本地路径"],
      userStories: [
        "作为工程负责人，我希望快速看到 agent 当前卡在哪个阶段。",
        "作为产品同学，我希望能在 PRD 审批前看到风险和验收标准。",
      ],
      acceptanceCriteria: [
        "任务行展示状态、分支、PR 和更新时间",
        "Trace 面板展示从 Issue 到验证的关键步骤",
        "质量门禁列表展示命令、耗时和结果",
      ],
      risks: ["真实凭据不得进入截图", "图谱生成状态需要有可解释文案"],
      unknowns: ["是否需要单独录制移动端视口"],
      taskType: input.taskType,
      complexity: {
        score: input.riskLevel === "low" ? 2 : input.riskLevel === "medium" ? 5 : 8,
        requiresHumanReview: input.riskLevel !== "low",
        reasons: ["跨越规划、实现和验证多个阶段", "需要人工确认对外文案"],
      },
      implementationPlan: {
        goal: input.title,
        acceptanceCriteria: [
          "UI 状态清晰可截图",
          "命令验证结果进入 PR 说明",
          "上下文文件和规则可在详情页预览",
        ],
        filesToRead: [
          "apps/web/src/features/tasks/task-board.tsx",
          "apps/api/src/routes/task-queue-summary.ts",
          ".agent/rules/privacy.md",
        ],
        filesExpectedToChange: [
          "apps/web/src/features/tasks/task-board.tsx",
          "tests/web-task-board-utils.test.ts",
        ],
        testsToAddOrUpdate: ["tests/web-task-board-utils.test.ts"],
        commandsToRun: ["pnpm lint", "pnpm typecheck", "pnpm test"],
        explicitNonGoals: ["不修改真实凭据配置", "不提交本地截图产物"],
        riskNotes: ["PR 文案需要避免真实客户名称"],
      },
    },
    contextPack: {
      id: `context-${input.id}`,
      taskId: input.id,
      taskSummary: input.title,
      businessRules: [
        "截图只展示公开仓库名和脱敏路径。",
        "涉及 token、本地路径、个人邮箱的字段必须脱敏。",
      ],
      memories: [],
      relevantFiles: [
        {
          path: "apps/web/src/features/tasks/task-board.tsx",
          reason: "任务详情、trace 和仓库上下文的主要呈现入口。",
          evidence: [
            {
              kind: "symbol",
              score: 0.92,
              summary: "TaskBoard renders repository detail panels.",
            },
          ],
          readMode: "excerpt",
        },
        {
          path: "tests/web-task-board-utils.test.ts",
          reason: "覆盖前端 API 包装和任务聚合逻辑。",
          evidence: [
            {
              kind: "path",
              score: 0.86,
              summary: "Existing tests already exercise board data helpers.",
            },
          ],
          readMode: "summary",
        },
      ],
      symbols: ["TaskBoard", "RepositoryDetailView", "TraceReplay"],
      tests: ["pnpm test -- tests/web-task-board-utils.test.ts"],
      similarChanges: ["agent/issue-101-dashboard-empty-state"],
      nonRelevantAreas: ["packages/model-runtime", "infra/docker"],
      openQuestions: ["是否需要录制英文 UI 版本？"],
      tokenBudget: 18_000,
      createdAt: earlier,
    },
    qualityGateResults: qualityGatesFor(input.status),
    reviewResult: {
      approved: input.riskLevel !== "high",
      blockingFindings: [],
      nonBlockingFindings:
        input.riskLevel === "medium"
          ? [
              {
                title: "补充移动端截图",
                body: "PR 说明里应包含一个移动端视口截图，便于审核响应式状态。",
                blocking: false,
                file: "apps/web/src/features/tasks/task-board.tsx",
              },
            ]
          : [],
      missingTests: [],
      scopeViolations: [],
      riskLevel: input.riskLevel,
      prDescriptionNotes: [
        "截图数据已脱敏。",
        "建议录制主页、仓库详情、上下文文件和 trace 四段。",
      ],
    },
    prUrl: input.prUrl,
    createdAt: yesterday,
    updatedAt: input.updatedAt,
  };
}

function qualityGatesFor(status: TaskStatus): Task["qualityGateResults"] {
  const running = status === "QUALITY_GATES_RUNNING";
  const blocked = status === "BLOCKED" || status === "FAILED";
  const kinds: Array<[QualityGateKind, string, boolean, number]> = [
    ["lint", "pnpm lint", true, 18_420],
    ["typecheck", "pnpm typecheck", true, 31_870],
    ["unit_test", "pnpm test", !running && !blocked, running ? 0 : 25_110],
    [
      "frontend_screenshot",
      "pnpm screenshot -- dashboard",
      !blocked,
      running ? 0 : 12_450,
    ],
  ];

  return kinds.map(([kind, command, passed, durationMs]) => ({
    kind,
    command,
    passed,
    exitCode: running && durationMs === 0 ? null : passed ? 0 : 1,
    durationMs,
    output:
      running && durationMs === 0
        ? "running..."
        : passed
          ? "completed successfully"
          : "screenshot diff exceeded threshold",
  }));
}

function buildMockRepositorySummaries(
  tasks: Task[],
): RepositoryQueueSummary[] {
  const byRepository = new Map<string, RepositoryQueueSummary>();
  const maxConcurrency = new Map([
    ["JASON-QWeb/CodeZero", 3],
    ["JASON-QWeb/BeautySkillsHub", 2],
    ["JASON-QWeb/agent-prd-automation", 2],
    ["JASON-QWeb/SeeMusic", 2],
    ["JASON-QWeb/Didicall", 1],
    ["JASON-QWeb/mcp-tool-gateway", 2],
  ]);

  for (const task of tasks) {
    const key = `${task.issue.owner}/${task.issue.repo}`;
    const summary =
      byRepository.get(key) ??
      ({
        id: key,
        owner: task.issue.owner,
        repo: task.issue.repo,
        fullName: key,
        configured: true,
        projectSkillPath: ".agent",
        projectRulePath: ".agent/rules",
        maxConcurrentIssues: maxConcurrency.get(key) ?? 1,
        runningCount: 0,
        queuedCount: 0,
        reviewCount: 0,
        blockedCount: 0,
        completedCount: 0,
        totalCount: 0,
        availableSlots: 0,
        tasks: [],
      } satisfies RepositoryQueueSummary);

    summary.tasks.push(task);
    summary.totalCount += 1;

    if (isRunningStatus(task.status)) {
      summary.runningCount += 1;
    } else if (isQueuedStatus(task.status)) {
      summary.queuedCount += 1;
    } else if (
      ["PRD_REVIEW_REQUIRED", "HUMAN_REVIEW", "WAITING_MERGE"].includes(
        task.status,
      )
    ) {
      summary.reviewCount += 1;
    } else if (["BLOCKED", "FAILED"].includes(task.status)) {
      summary.blockedCount += 1;
    } else if (["DONE", "CANCELLED"].includes(task.status)) {
      summary.completedCount += 1;
    }

    summary.availableSlots = Math.max(
      0,
      summary.maxConcurrentIssues - summary.runningCount,
    );
    byRepository.set(key, summary);
  }

  return [...byRepository.values()].sort((left, right) =>
    left.fullName.localeCompare(right.fullName),
  );
}

function githubSyncState(
  repositoryId: string,
  status: GitHubSyncState["status"],
): GitHubSyncState {
  const [owner = "JASON-QWeb", repo = "CodeZero"] = repositoryId.split("/");

  return {
    repositoryId,
    status,
    lastStartedAt: earlier,
    lastFinishedAt: now,
    lastResult: {
      repositoryId,
      fullName: `${owner}/${repo}`,
      scannedIssues: 24,
      importedIssues: 6,
      skippedIssues: 18,
      scannedFeedbackPullRequests: 9,
      importedFeedbackComments: 4,
      queuedFeedbackTasks: 2,
      failedFeedbackQueues: 0,
      skippedFeedbackComments: 5,
    },
  };
}

function knowledgeGraphFor(repositoryId: string): ProjectKnowledgeGraph {
  const slug = repositorySlug(repositoryId);
  const graphStats = graphStatsFor(slug);

  return {
    repositoryId,
    fullName: repositoryId,
    status: "ready",
    graphAvailable: true,
    pluginInstalled: true,
    provider: {
      name: "Understand-Anything",
      projectUrl: "https://github.com/Lum1104/Understand-Anything",
      testedVersion: "v2.7.3",
      outputFile: ".understand-anything/knowledge-graph.json",
    },
    graph: {
      projectName: slug,
      analyzedAt: now,
      nodes: graphStats.nodes,
      edges: graphStats.edges,
    },
    dashboardUrl: `http://localhost:8787/snapshot/${slug}`,
  };
}

function onboardingFor(repositoryId: string): RepositoryOnboarding {
  const slug = repositorySlug(repositoryId);
  const graphStats = graphStatsFor(slug);

  return {
    repositoryId,
    fullName: repositoryId,
    status: "ready",
    codeGraphAvailable: true,
    cacheDatabaseFile: `data/codegraph/${slug}/codegraph.db`,
    updatedAt: now,
    codeGraph: {
      operation: "synced",
      changeDetection: "working-tree-sync",
      databaseFile: `data/codegraph/${slug}/codegraph.db`,
      indexDir: `data/codegraph/${slug}`,
      durationMs: graphStats.durationMs,
      displayCommand: "codegraph --index --preview",
    },
    summary: {
      files: graphStats.files,
      symbols: graphStats.symbols,
      routes: graphStats.routes,
      tests: graphStats.tests,
      packageManager: "pnpm",
    },
    documents: [
      {
        path: "project.md",
        type: "project",
        content:
          "# Project Context\n\nThis repository runs CodeZero issue-to-PR automation with project rules, memory, and local verification evidence.\n",
      },
      {
        path: "architecture.md",
        type: "architecture",
        content:
          "# Architecture\n\nThe app uses a typed API layer, deterministic state transitions, and screenshot-backed frontend verification.\n",
      },
      {
        path: "testing-guide.md",
        type: "testing",
        content:
          "# Testing Guide\n\nRun lint, typecheck, unit tests, and focused Playwright screenshots before publishing a screenshot-ready PR.\n",
      },
    ],
  };
}

function graphStatsFor(slug: string): {
  durationMs: number;
  edges: number;
  files: number;
  nodes: number;
  routes: number;
  symbols: number;
  tests: number;
} {
  const stats = new Map<
    string,
    {
      durationMs: number;
      edges: number;
      files: number;
      nodes: number;
      routes: number;
      symbols: number;
      tests: number;
    }
  >([
    [
      "CodeZero",
      {
        durationMs: 82_440,
        edges: 4210,
        files: 1284,
        nodes: 1842,
        routes: 43,
        symbols: 6420,
        tests: 218,
      },
    ],
    [
      "BeautySkillsHub",
      {
        durationMs: 64_800,
        edges: 1886,
        files: 712,
        nodes: 936,
        routes: 18,
        symbols: 2915,
        tests: 96,
      },
    ],
    [
      "agent-prd-automation",
      {
        durationMs: 58_340,
        edges: 2540,
        files: 684,
        nodes: 1216,
        routes: 21,
        symbols: 3520,
        tests: 141,
      },
    ],
    [
      "SeeMusic",
      {
        durationMs: 36_900,
        edges: 1420,
        files: 438,
        nodes: 704,
        routes: 9,
        symbols: 2188,
        tests: 74,
      },
    ],
    [
      "Didicall",
      {
        durationMs: 44_210,
        edges: 1694,
        files: 506,
        nodes: 812,
        routes: 14,
        symbols: 2460,
        tests: 83,
      },
    ],
    [
      "mcp-tool-gateway",
      {
        durationMs: 39_650,
        edges: 1320,
        files: 392,
        nodes: 648,
        routes: 11,
        symbols: 1964,
        tests: 69,
      },
    ],
  ]);

  return (
    stats.get(slug) ?? {
      durationMs: 41_220,
      edges: 1886,
      files: 712,
      nodes: 936,
      routes: 18,
      symbols: 2915,
      tests: 96,
    }
  );
}

function traceFor(task: Task): TaskTrace {
  const live = isRunningStatus(task.status);
  const spans: TraceSpan[] = [
    span(task, "workflow", "Issue imported", "GitHub issue matched @agent trigger."),
    span(task, "github", "Context collected", "Fetched issue body, labels and latest comments."),
    span(task, "navigation", "Repo graph route", "Selected task-board, API routes and focused tests."),
    span(task, "memory", "Memory search", "Matched 3 approved memories and 2 proposed memories."),
    span(task, "model", "PRD drafted", "Generated goals, non-goals, risks and implementation plan."),
    span(task, "tool", "ContextPack created", "Packed 2 source files, 1 test file and project rules."),
    span(
      task,
      "quality_gate",
      live ? "Quality gates running" : "Quality gates completed",
      live ? "pnpm test is still running in the sandbox." : "All required checks passed.",
      live ? "running" : "success",
    ),
    span(
      task,
      "artifact",
      "Screenshot evidence",
      "Captured desktop and mobile dashboard views for PR evidence.",
      task.status === "QUEUED" ? "info" : "success",
    ),
  ];
  const artifacts: Artifact[] = [
    {
      id: `artifact-prd-${task.id}`,
      taskId: task.id,
      type: "prd",
      path: "artifacts/prd.md",
      createdAt: earlier,
    },
    {
      id: `artifact-context-${task.id}`,
      taskId: task.id,
      type: "context-pack",
      path: "artifacts/context-pack.json",
      createdAt: earlier,
    },
    {
      id: `artifact-screenshot-${task.id}`,
      taskId: task.id,
      type: "screenshot",
      path: "artifacts/screenshots/dashboard-desktop.png",
      createdAt: now,
    },
  ];

  return {
    taskId: task.id,
    status: task.status,
    issueUrl: task.issue.url,
    prUrl: task.prUrl,
    spans,
    artifacts,
    summary: {
      totalSpans: spans.length,
      toolCalls: spans.filter((item) => item.kind === "tool").length,
      policyDecisions: spans.filter((item) => item.kind === "policy").length,
      failedOrBlocked: spans.filter((item) =>
        ["failed", "blocked"].includes(item.status),
      ).length,
    },
  };
}

function span(
  task: Task,
  kind: TraceSpanKind,
  name: string,
  message: string,
  status: TraceSpanStatus = "success",
): TraceSpan {
  return {
    id: `${task.id}-${kind}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    taskId: task.id,
    name,
    kind,
    status,
    level: status === "failed" || status === "blocked" ? "warn" : "info",
    message,
    startedAt: earlier,
    endedAt: status === "running" ? now : earlier,
    durationMs: status === "running" ? 65_000 : 8_400,
  };
}

function repositorySlug(repositoryId: string): string {
  return repositoryId.split("/").at(-1) ?? "CodeZero";
}

function fileNameFromPath(filePath: string): string {
  return filePath.split("/").at(-1)?.replace(/\.[^.]+$/, "") || "context";
}

function cloneContextFiles(
  input: Map<string, RepositoryContextFile[]>,
): Map<string, RepositoryContextFile[]> {
  return new Map([...input.entries()].map(([key, value]) => [key, clone(value)]));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
