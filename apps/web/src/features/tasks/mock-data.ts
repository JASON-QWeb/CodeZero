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
    id: "demo-task-128",
    owner: "demo-labs",
    repo: "nova-commerce",
    number: 128,
    title: "优化订单详情页的退款状态提示",
    status: "QUALITY_GATES_RUNNING",
    branchName: "agent/issue-128-refund-status-copy",
    prUrl: "https://github.com/demo-labs/nova-commerce/pull/136",
    labels: ["frontend", "agent-ready", "checkout"],
    updatedAt: now,
    taskType: "frontend",
    riskLevel: "medium",
  }),
  createTask({
    id: "demo-task-129",
    owner: "demo-labs",
    repo: "nova-commerce",
    number: 129,
    title: "为结账失败增加风控限流说明",
    status: "PRD_REVIEW_REQUIRED",
    branchName: "agent/issue-129-checkout-rate-limit-copy",
    labels: ["fullstack", "prd-review"],
    updatedAt: "2026-06-02T07:10:00.000Z",
    taskType: "fullstack",
    riskLevel: "medium",
  }),
  createTask({
    id: "demo-task-130",
    owner: "demo-labs",
    repo: "nova-commerce",
    number: 130,
    title: "补齐移动端支付失败页截图校验",
    status: "WAITING_MERGE",
    branchName: "agent/issue-130-mobile-payment-screenshot",
    prUrl: "https://github.com/demo-labs/nova-commerce/pull/139",
    labels: ["frontend", "visual-qa"],
    updatedAt: "2026-06-02T05:58:00.000Z",
    taskType: "frontend",
    riskLevel: "low",
  }),
  createTask({
    id: "demo-task-204",
    owner: "demo-labs",
    repo: "atlas-crm",
    number: 204,
    title: "修复客户详情页最近活动排序",
    status: "IMPLEMENTING",
    branchName: "agent/issue-204-activity-order",
    labels: ["backend", "data"],
    updatedAt: earlier,
    taskType: "backend",
    riskLevel: "low",
  }),
  createTask({
    id: "demo-task-205",
    owner: "demo-labs",
    repo: "atlas-crm",
    number: 205,
    title: "导入销售线索时提示重复邮箱",
    status: "QUEUED",
    branchName: "agent/issue-205-lead-import-duplicates",
    labels: ["fullstack"],
    updatedAt: "2026-06-02T04:33:00.000Z",
    taskType: "fullstack",
    riskLevel: "medium",
  }),
  createTask({
    id: "demo-task-88",
    owner: "demo-labs",
    repo: "docs-hub",
    number: 88,
    title: "更新新成员 onboarding 文档结构",
    status: "DONE",
    branchName: "agent/issue-88-onboarding-docs",
    prUrl: "https://github.com/demo-labs/docs-hub/pull/91",
    labels: ["docs", "knowledge-base"],
    updatedAt: yesterday,
    taskType: "docs",
    riskLevel: "low",
  }),
];

let tasksState = clone(seededTasks);

const seededMemories: MemoryRecord[] = [
  {
    id: "demo-memory-verification",
    kind: "procedural",
    status: "proposed",
    scope: "repository",
    owner: "demo-labs",
    repo: "nova-commerce",
    title: "前端任务的稳定验证顺序",
    content:
      "类似结账和订单详情 UI 改动，先跑 pnpm lint、pnpm typecheck、pnpm test，再补桌面和移动端截图证据。",
    tags: ["verification", "frontend", "screenshots"],
    confidence: 0.86,
    sourceTaskId: "demo-task-128",
    createdAt: earlier,
    updatedAt: now,
  },
  {
    id: "demo-memory-policy",
    kind: "policy",
    status: "proposed",
    scope: "repository",
    owner: "demo-labs",
    repo: "atlas-crm",
    title: "客户数据字段不得出现在截图中",
    content:
      "演示录屏只展示脱敏公司名、模拟邮箱和固定时间戳；不要使用真实客户名称、合同编号或内部 owner。",
    tags: ["privacy", "demo", "crm"],
    confidence: 0.91,
    sourceTaskId: "demo-task-204",
    createdAt: earlier,
    updatedAt: now,
  },
  {
    id: "demo-memory-contextpack",
    kind: "semantic",
    status: "proposed",
    scope: "global",
    title: "ContextPack 面板的讲解重点",
    content:
      "录制 demo 时先展示 CodeGraph，再切到 ContextPack，说明 agent 只读取少量高相关文件来控制上下文成本。",
    tags: ["demo", "context-pack", "knowledge-graph"],
    confidence: 0.79,
    sourceTaskId: "demo-task-128",
    createdAt: yesterday,
    updatedAt: earlier,
  },
];

let memoriesState = clone(seededMemories);

const seededContextFiles = new Map<string, RepositoryContextFile[]>([
  [
    "demo-labs/nova-commerce",
    [
      {
        kind: "skill",
        path: ".agent/skills/checkout-copy/SKILL.md",
        name: "checkout-copy",
        content:
          "# Checkout Copy\n\nUse short, user-facing Chinese copy for checkout failures. Mention the next action before internal error details.\n",
        updatedAt: now,
      },
      {
        kind: "rule",
        path: ".agent/rules/privacy.md",
        name: "privacy",
        content:
          "# Privacy Rule\n\nDemo screenshots must use masked customer names, test order ids, and fixed example timestamps.\n",
        updatedAt: now,
      },
      {
        kind: "rule",
        path: ".agent/rules/visual-qa.md",
        name: "visual-qa",
        content:
          "# Visual QA\n\nCapture desktop and mobile screenshots for checkout, order detail, and payment failure flows before opening PRs.\n",
        updatedAt: earlier,
      },
    ],
  ],
  [
    "demo-labs/atlas-crm",
    [
      {
        kind: "skill",
        path: ".agent/skills/crm-activity/SKILL.md",
        name: "crm-activity",
        content:
          "# CRM Activity\n\nSort recent activity by server event time, then use client display time only for rendering.\n",
        updatedAt: earlier,
      },
      {
        kind: "rule",
        path: ".agent/rules/demo-data.md",
        name: "demo-data",
        content:
          "# Demo Data\n\nUse fictional company names and non-routable emails for demo recordings.\n",
        updatedAt: earlier,
      },
    ],
  ],
]);

const contextFilesState = cloneContextFiles(seededContextFiles);

export async function demoFetchTasks(): Promise<Task[]> {
  return clone(tasksState);
}

export async function demoFetchRepositoryQueues(): Promise<
  RepositoryQueueSummary[]
> {
  return buildDemoRepositorySummaries(tasksState);
}

export async function demoFetchGitHubSync(
  repositoryId: string,
): Promise<GitHubSyncState> {
  return clone(githubSyncState(repositoryId, "finished"));
}

export async function demoTriggerGitHubSync(
  repositoryId: string,
): Promise<GitHubSyncResponse> {
  return {
    started: true,
    sync: clone(githubSyncState(repositoryId, "finished")),
  };
}

export async function demoFetchProjectKnowledgeGraph(
  repositoryId: string,
): Promise<ProjectKnowledgeGraph> {
  return clone(knowledgeGraphFor(repositoryId));
}

export async function demoGenerateProjectKnowledgeGraph(input: {
  repositoryId: string;
}): Promise<ProjectKnowledgeGraph> {
  return clone(knowledgeGraphFor(input.repositoryId));
}

export async function demoOpenProjectKnowledgeGraphDashboard(
  repositoryId: string,
): Promise<ProjectKnowledgeGraph> {
  return clone({
    ...knowledgeGraphFor(repositoryId),
    dashboardUrl: `http://localhost:8787/demo/${repositorySlug(repositoryId)}`,
  });
}

export async function demoFetchRepositoryOnboarding(
  repositoryId: string,
): Promise<RepositoryOnboarding> {
  return clone(onboardingFor(repositoryId));
}

export async function demoFetchRepositoryContextFiles(
  repositoryId: string,
): Promise<RepositoryContextFile[]> {
  return clone(contextFilesState.get(repositoryId) ?? []);
}

export async function demoSaveRepositoryContextFile(input: {
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

export async function demoFetchTrace(taskId: string): Promise<TaskTrace> {
  const task = tasksState.find((item) => item.id === taskId) ?? tasksState[0];

  if (!task) {
    throw new Error("Demo task trace is unavailable");
  }

  return clone(traceFor(task));
}

export async function demoApproveTaskPrd(taskId: string): Promise<Task> {
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
    throw new Error("Demo task is unavailable");
  }

  return clone(task);
}

export async function demoFetchMemories(
  status: MemoryStatus,
): Promise<MemoryRecord[]> {
  return clone(memoriesState.filter((memory) => memory.status === status));
}

export async function demoUpdateMemoryStatus(input: {
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
    throw new Error("Demo memory is unavailable");
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
        "Demo issue generated for screenshots and GIF capture.",
        "No customer data, real repository path, or personal account data is included.",
      ].join("\n"),
      labels: input.labels,
      comments: [
        {
          author: "product-demo",
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
      risks: ["真实数据不得进入 demo 截图", "图谱生成状态需要有可解释文案"],
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
        "所有截图使用 demo-labs 虚构组织。",
        "涉及订单、客户、邮箱的字段必须脱敏。",
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
        "Demo 数据已脱敏。",
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
  const kinds: Array<[QualityGateKind, string, boolean, number]> = [
    ["lint", "pnpm lint", true, 18_420],
    ["typecheck", "pnpm typecheck", true, 31_870],
    ["unit_test", "pnpm test", !running, running ? 0 : 25_110],
    [
      "frontend_screenshot",
      "pnpm screenshot -- dashboard",
      status !== "FAILED",
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

function buildDemoRepositorySummaries(
  tasks: Task[],
): RepositoryQueueSummary[] {
  const byRepository = new Map<string, RepositoryQueueSummary>();
  const maxConcurrency = new Map([
    ["demo-labs/nova-commerce", 3],
    ["demo-labs/atlas-crm", 2],
    ["demo-labs/docs-hub", 1],
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
  const [owner = "demo-labs", repo = "nova-commerce"] = repositoryId.split("/");

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
      nodes: slug === "nova-commerce" ? 1842 : 936,
      edges: slug === "nova-commerce" ? 4210 : 1886,
    },
    dashboardUrl: `http://localhost:8787/demo/${slug}`,
  };
}

function onboardingFor(repositoryId: string): RepositoryOnboarding {
  const slug = repositorySlug(repositoryId);

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
      durationMs: slug === "nova-commerce" ? 82_440 : 41_220,
      displayCommand: "codegraph --index --demo",
    },
    summary: {
      files: slug === "nova-commerce" ? 1284 : 712,
      symbols: slug === "nova-commerce" ? 6420 : 2915,
      routes: slug === "docs-hub" ? 18 : 43,
      tests: slug === "nova-commerce" ? 218 : 96,
      packageManager: "pnpm",
    },
    documents: [
      {
        path: "project.md",
        type: "project",
        content:
          "# Demo Project\n\nThis repository is a fictional product surface used to demonstrate CodeZero task automation without private data.\n",
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
          "# Testing Guide\n\nRun lint, typecheck, unit tests, and focused Playwright screenshots before publishing a demo PR.\n",
      },
    ],
  };
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
  return repositoryId.split("/").at(-1) ?? "demo-repository";
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
