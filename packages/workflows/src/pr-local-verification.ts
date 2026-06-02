import { access } from "node:fs/promises";
import path from "node:path";
import type {
  Artifact,
  IssueContext,
  JsonValue,
  MinimalChangePlan,
  PlanningDocument,
  QualityGateResult,
  Task,
} from "@agent/shared";

export type ConversationLocale = "zh" | "en";

export type PrLocalVerificationInput = {
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  agentBranch: string;
  cloneUrl?: string;
  installCommand?: string;
  qualityGateResults?: QualityGateResult[];
  devCommand?: string;
  screenshotArtifacts?: Array<
    Pick<Artifact, "id" | "path" | "url" | "metadata">
  >;
  sandbox?: {
    mode?: "docker" | "worktree";
    image?: string;
    repoDir?: string;
    artifactDir?: string;
  };
};

export type PrLocalVerificationPlan = {
  repository: {
    owner: string;
    repo: string;
    cloneUrl: string;
  };
  branches: {
    base: string;
    baseSha: string;
    agent: string;
  };
  commands: {
    githubCli: string[];
    plainGit: string[];
    install?: string;
    qualityGates: Array<{
      kind: QualityGateResult["kind"];
      command: string;
      passed: boolean;
      exitCode: number | null;
    }>;
    dev?: string;
  };
  screenshots: Array<{
    url?: string;
    viewport?: string;
    artifact: string;
  }>;
  sandbox: {
    mode?: "docker" | "worktree";
    image?: string;
    repoDir?: string;
    artifactDir?: string;
  };
};

export type AgentPrBodyInput = {
  task: Task;
  verification: PrLocalVerificationPlan;
  locale?: ConversationLocale;
  updateReason?: string;
};

export type PrBodyCompletenessResult = {
  passed: boolean;
  errors: string[];
};

const installCommandCandidates = [
  { file: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
  { file: "package-lock.json", command: "npm ci" },
  { file: "yarn.lock", command: "yarn install --frozen-lockfile" },
  { file: "bun.lockb", command: "bun install --frozen-lockfile" },
  { file: "bun.lock", command: "bun install --frozen-lockfile" },
  { file: "uv.lock", command: "uv sync" },
  { file: "poetry.lock", command: "poetry install" },
  {
    file: "requirements.txt",
    command: "python -m pip install -r requirements.txt",
  },
  { file: "package.json", command: "npm install" },
] as const;

export async function detectInstallCommand(
  repoDir: string,
): Promise<string | undefined> {
  for (const candidate of installCommandCandidates) {
    const exists = await access(path.join(repoDir, candidate.file)).then(
      () => true,
      () => false,
    );

    if (exists) {
      return candidate.command;
    }
  }

  return undefined;
}

export function createPrLocalVerificationPlan(
  input: PrLocalVerificationInput,
): PrLocalVerificationPlan {
  const cloneUrl =
    input.cloneUrl ?? `https://github.com/${input.owner}/${input.repo}.git`;
  const qualityGates = dedupeQualityGateResults(input.qualityGateResults ?? []);
  const postCheckoutCommands = dedupeCommands([
    input.installCommand,
    ...qualityGates.map((result) => result.command),
    input.devCommand,
  ].filter((command): command is string => Boolean(command)));

  return {
    repository: {
      owner: input.owner,
      repo: input.repo,
      cloneUrl,
    },
    branches: {
      base: input.baseBranch,
      baseSha: input.baseSha,
      agent: input.agentBranch,
    },
    commands: {
      githubCli: [
        `gh repo clone ${input.owner}/${input.repo}`,
        `cd ${input.repo}`,
        `gh pr checkout ${input.agentBranch}`,
        ...postCheckoutCommands,
      ],
      plainGit: [
        `git clone ${cloneUrl}`,
        `cd ${input.repo}`,
        `git fetch origin ${input.agentBranch}`,
        `git checkout ${input.agentBranch}`,
        ...postCheckoutCommands,
      ],
      install: input.installCommand,
      qualityGates,
      dev: input.devCommand,
    },
    screenshots: (input.screenshotArtifacts ?? []).map((artifact) => ({
      url: metadataString(artifact.metadata?.url),
      viewport: metadataString(artifact.metadata?.viewport),
      artifact:
        artifact.url ??
        (artifact.id ? `CodeZero artifact ${artifact.id}` : undefined) ??
        artifact.path ??
        "task artifact",
    })),
    sandbox: input.sandbox ?? {},
  };
}

export function createAgentPrBody(input: AgentPrBodyInput): string {
  const task = input.task;
  const locale = input.locale ?? detectIssueLocale(task.issue);
  const text = copy(locale);
  const reviewNotes = task.reviewResult?.prDescriptionNotes ?? [];

  return [
    `${text.closes} ${task.issue.url}`,
    "",
    `## ${text.summary}`,
    goalsToMarkdown(task),
    ...(input.updateReason
      ? ["", `## ${text.latestFeedback}`, input.updateReason]
      : []),
    "",
    `## ${text.changeScope}`,
    ...formatPlainList(
      task.planningDocument?.implementationPlan.filesExpectedToChange ?? [],
      text.none,
    ),
    "",
    `## ${text.qualityGates}`,
    ...formatQualityGateTable(task.qualityGateResults ?? [], locale),
    "",
    `## ${text.reviewSubagent}`,
    `- ${text.approved}: ${task.reviewResult?.approved ?? false}`,
    `- ${text.risk}: ${task.reviewResult?.riskLevel ?? "unknown"}`,
    ...(reviewNotes.length > 0
      ? reviewNotes.map((note) => `- ${note}`)
      : [`- ${text.noAdditionalNotes}`]),
    "",
    `## ${text.frontendScreenshotVerification}`,
    ...formatVisibleScreenshotMarkdown(input.verification, locale),
    "",
    `## ${text.prContentCompleteness}`,
    ...formatPrContentChecklist(input, locale),
    "",
    formatPrLocalVerificationMarkdown(input.verification, locale),
  ].join("\n");
}

export function formatPrLocalVerificationMarkdown(
  plan: PrLocalVerificationPlan,
  locale: ConversationLocale = "en",
): string {
  const text = copy(locale);

  return [
    `## ${text.localVerification}`,
    "",
    "<details>",
    `<summary>${text.localVerificationSummary}</summary>`,
    "",
    `### ${text.githubCliOption}`,
    "",
    "```bash",
    ...plan.commands.githubCli,
    "```",
    "",
    `### ${text.plainGitOption}`,
    "",
    "```bash",
    ...plan.commands.plainGit,
    "```",
    "",
    `### ${text.agentVerification}`,
    "",
    `- ${text.baseBranch}: ${plan.branches.base}`,
    `- ${text.baseCommit}: ${plan.branches.baseSha}`,
    `- ${text.agentBranch}: ${plan.branches.agent}`,
    `- ${text.sandboxMode}: ${plan.sandbox.mode ?? text.unknown}`,
    `- ${text.sandboxImage}: ${plan.sandbox.image ?? text.notRecorded}`,
    "",
    "</details>",
  ].join("\n");
}

export function detectIssueLocale(issue: IssueContext): ConversationLocale {
  const text = [
    issue.title,
    issue.body,
    ...issue.comments.map((comment) => comment.body),
  ]
    .join("\n")
    .trim();
  if (/[\u3400-\u9fff]/.test(text)) {
    return "zh";
  }

  const latinLetters = text.match(/[A-Za-z]/g)?.length ?? 0;
  return latinLetters >= 8 ? "en" : "zh";
}

export function languageInstruction(locale: ConversationLocale): string {
  return locale === "zh"
    ? "用户使用中文。所有面向用户的字段、说明、PRD、计划、review notes、PR 正文和 GitHub 回复都必须使用中文；代码标识符和命令保持原文。"
    : "The user is using English. Write all user-facing fields, notes, PR text, and GitHub replies in English; keep code identifiers and commands unchanged.";
}

export function createPrdIssueComment(input: {
  task: Task;
  planningDocument: PlanningDocument;
  requiresHumanReview: boolean;
  mention: string;
  locale?: ConversationLocale;
}): string {
  const locale = input.locale ?? detectIssueLocale(input.task.issue);
  const text = prdCopy(locale);
  const prd = input.planningDocument;
  const statusLine = input.requiresHumanReview
    ? text.requiresReviewStatus
    : text.autoApprovedStatus;
  const nextStep = input.requiresHumanReview
    ? text.requiresReview(input.mention)
    : text.autoApproved;
  const acceptanceFocus =
    prd.implementationPlan.acceptanceCriteria.length > 0
      ? prd.implementationPlan.acceptanceCriteria
      : prd.acceptanceCriteria;
  const riskAndUnknowns = [...prd.risks, ...prd.unknowns];

  return [
    `## ${text.title}: ${prd.title}`,
    "",
    `**${text.status}**: ${statusLine}`,
    `**${text.planGoal}**: ${prd.implementationPlan.goal}`,
    `**${text.scope}**: ${compactInlineList(prd.implementationPlan.filesExpectedToChange, text.none)}`,
    "",
    `### ${text.acceptanceFocus}`,
    ...formatPlainList(acceptanceFocus, text.none),
    "",
    `### ${text.riskAndUnknowns}`,
    ...formatPlainList(riskAndUnknowns, text.none),
    "",
    `### ${text.nextStep}`,
    nextStep,
    "",
    "<details>",
    `<summary>${text.detailedPlan}</summary>`,
    "",
    `### ${text.background}`,
    prd.background || text.none,
    "",
    markdownList(text.goals, prd.goals, text.none),
    "",
    markdownList(text.nonGoals, prd.nonGoals, text.none),
    "",
    markdownList(text.userStories, prd.userStories, text.none),
    "",
    markdownList(text.acceptanceCriteria, prd.acceptanceCriteria, text.none),
    "",
    formatMinimalChangePlan(prd.implementationPlan, text),
    "",
    markdownList(text.risks, prd.risks, text.none),
    "",
    markdownList(text.unknowns, prd.unknowns, text.none),
    "",
    `### ${text.complexity}`,
    `- ${text.taskType}: ${prd.taskType}`,
    `- ${text.score}: ${prd.complexity.score}`,
    `- ${text.humanReview}: ${prd.complexity.requiresHumanReview ? text.yes : text.no}`,
    ...prd.complexity.reasons.map((reason) => `- ${reason}`),
    "",
    "</details>",
  ].join("\n");
}

function formatMinimalChangePlan(
  plan: MinimalChangePlan,
  text: ReturnType<typeof prdCopy>,
): string {
  return [
    `### ${text.implementationPlan}`,
    `- ${text.planGoal}: ${plan.goal}`,
    "",
    markdownList(
      text.planAcceptanceCriteria,
      plan.acceptanceCriteria,
      text.none,
    ),
    "",
    markdownList(text.filesToRead, plan.filesToRead, text.none),
    "",
    markdownList(
      text.filesExpectedToChange,
      plan.filesExpectedToChange,
      text.none,
    ),
    "",
    markdownList(text.testsToAddOrUpdate, plan.testsToAddOrUpdate, text.none),
    "",
    markdownList(text.commandsToRun, plan.commandsToRun, text.none),
    "",
    markdownList(text.planNonGoals, plan.explicitNonGoals, text.none),
    "",
    markdownList(text.planRiskNotes, plan.riskNotes, text.none),
  ].join("\n");
}

function markdownList(
  title: string,
  values: string[],
  fallback: string,
): string {
  return [
    `### ${title}`,
    ...(values.length > 0
      ? values.map((value) => `- ${value}`)
      : [`- ${fallback}`]),
  ].join("\n");
}

function formatPlainList(values: string[], fallback: string): string[] {
  return values.length > 0
    ? values.map((value) => `- ${value}`)
    : [`- ${fallback}`];
}

function compactInlineList(
  values: string[],
  fallback: string,
  maxItems = 4,
): string {
  if (values.length === 0) {
    return fallback;
  }

  const visible = values.slice(0, maxItems).join(", ");
  const remaining = values.length - maxItems;
  return remaining > 0 ? `${visible} (+${remaining})` : visible;
}

export function validateAgentPrBodyCompleteness(
  input: AgentPrBodyInput & { body: string },
): PrBodyCompletenessResult {
  const locale = input.locale ?? detectIssueLocale(input.task.issue);
  const text = copy(locale);
  const errors: string[] = [];

  const requiredSections = [
    text.summary,
    text.localVerification,
    text.prContentCompleteness,
    text.qualityGates,
    text.reviewSubagent,
  ];
  for (const section of requiredSections) {
    if (!input.body.includes(`## ${section}`)) {
      errors.push(`${text.missingPrSection}: ${section}`);
    }
  }

  if (
    !input.task.qualityGateResults ||
    input.task.qualityGateResults.length === 0
  ) {
    errors.push(text.missingQualityGates);
  } else if (input.task.qualityGateResults.some((result) => !result.passed)) {
    errors.push(text.failedQualityGates);
  }

  if (!input.task.reviewResult?.approved) {
    errors.push(text.reviewNotApproved);
  }

  const screenshotArtifacts = input.verification.screenshots;
  if (screenshotArtifacts.length > 0) {
    const missingReferencedScreenshots = screenshotArtifacts.filter(
      (screenshot) => !input.body.includes(screenshot.artifact),
    );
    if (missingReferencedScreenshots.length > 0) {
      errors.push(text.screenshotNotReferenced);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

export function assertAgentPrBodyComplete(
  input: AgentPrBodyInput & { body: string },
): void {
  const result = validateAgentPrBodyCompleteness(input);
  if (!result.passed) {
    throw new Error(
      `PR content completeness check failed: ${result.errors.join("; ")}`,
    );
  }
}

export function createPrReadyIssueComment(input: {
  task: Task;
  verification: PrLocalVerificationPlan;
  prUrl: string;
  locale?: ConversationLocale;
}): string {
  const locale = input.locale ?? detectIssueLocale(input.task.issue);
  const text = copy(locale);
  return [
    text.issueReady(input.prUrl),
    "",
    `- ${text.agentVerification}: ${text.passed}`,
    `- ${text.qualityGates}: ${summarizeQualityGates(input.task.qualityGateResults ?? [], locale)}`,
    `- ${text.reviewSubagent}: ${input.task.reviewResult?.approved ? text.passed : text.failed}`,
    "",
    `### ${text.frontendScreenshotVerification}`,
    ...formatVisibleScreenshotMarkdown(input.verification, locale),
  ].join("\n");
}

export function createPrFeedbackUpdateComment(input: {
  task: Task;
  verification: PrLocalVerificationPlan;
  updateReason: string;
  locale?: ConversationLocale;
}): string {
  const locale = input.locale ?? detectIssueLocale(input.task.issue);
  const text = copy(locale);
  return [
    text.prFeedbackUpdated,
    "",
    `> ${input.updateReason.replace(/\n/g, "\n> ")}`,
    "",
    `- ${text.qualityGates}: ${summarizeQualityGates(input.task.qualityGateResults ?? [], locale)}`,
    `- ${text.reviewSubagent}: ${input.task.reviewResult?.approved ? text.passed : text.failed}`,
    "",
    `### ${text.frontendScreenshotVerification}`,
    ...formatVisibleScreenshotMarkdown(input.verification, locale),
  ].join("\n");
}

function goalsToMarkdown(task: Task): string {
  const goals = task.planningDocument?.goals ?? [];
  if (goals.length === 0) {
    return `- ${copy(detectIssueLocale(task.issue)).seePrdArtifact}`;
  }

  return goals.map((goal) => `- ${goal}`).join("\n");
}

function formatPrContentChecklist(
  input: AgentPrBodyInput,
  locale: ConversationLocale,
): string[] {
  const text = copy(locale);
  const screenshotStatus =
    input.verification.screenshots.length === 0
      ? text.none
      : text.referencedArtifacts;
  return [
    `- ${text.languageMatched}: ${locale === "zh" ? "中文" : "English"}`,
    `- ${text.selfChecksBeforePr}: ${allRecordedChecksPassed(input.task) ? text.passed : text.failed}`,
    `- ${text.reviewSubagent}: ${input.task.reviewResult?.approved ? text.passed : text.failed}`,
    `- ${text.screenshotArtifacts}: ${screenshotStatus}`,
  ];
}

function formatQualityGateTable(
  results: QualityGateResult[],
  locale: ConversationLocale,
): string[] {
  const text = copy(locale);
  if (results.length === 0) {
    return [`- ${text.notRecorded}`];
  }

  return [
    `| ${text.check} | ${text.result} | ${text.command} |`,
    "|---|---|---|",
    ...results.map(
      (result) =>
        `| ${escapeTableCell(result.kind)} | ${result.passed ? text.passed : text.failed} | ${inlineCode(result.command)} |`,
    ),
  ];
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function allRecordedChecksPassed(task: Task): boolean {
  const results = task.qualityGateResults ?? [];
  return results.length > 0 && results.every((result) => result.passed);
}

function formatScreenshotMarkdown(
  screenshot: PrLocalVerificationPlan["screenshots"][number],
): string[] {
  const target = screenshot.url
    ? `${screenshot.url}${screenshot.viewport ? ` ${screenshot.viewport}` : ""}`
    : "screenshot";
  if (isEmbeddableImageUrl(screenshot.artifact)) {
    return [`- ${target}`, `![${target}](${screenshot.artifact})`];
  }
  return [`- ${target}: ${screenshot.artifact}`];
}

function formatVisibleScreenshotMarkdown(
  plan: PrLocalVerificationPlan,
  locale: ConversationLocale,
): string[] {
  const images = plan.screenshots
    .flatMap((screenshot) => formatScreenshotMarkdown(screenshot))
    .filter((line) => line.startsWith("![") || line.startsWith("- "));
  return images.length > 0 ? images : [`- ${copy(locale).none}`];
}

function summarizeQualityGates(
  results: QualityGateResult[],
  locale: ConversationLocale,
): string {
  const text = copy(locale);
  if (results.length === 0) {
    return text.notRecorded;
  }

  const passed = results.filter((result) => result.passed).length;
  return `${passed}/${results.length} ${passed === results.length ? text.passed : text.failed}`;
}

function dedupeQualityGateResults(
  results: QualityGateResult[],
): PrLocalVerificationPlan["commands"]["qualityGates"] {
  const seen = new Set<string>();
  const deduped: PrLocalVerificationPlan["commands"]["qualityGates"] = [];

  for (const result of results) {
    const key = `${result.kind}:${result.command}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      kind: result.kind,
      command: result.command,
      passed: result.passed,
      exitCode: result.exitCode,
    });
  }

  return deduped;
}

function dedupeCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command)) {
      return false;
    }
    seen.add(command);
    return true;
  });
}

function metadataString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isEmbeddableImageUrl(value: string): boolean {
  return /^https?:\/\/.+\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(value);
}

function copy(locale: ConversationLocale) {
  return locale === "zh"
    ? {
        agentVerification: "Agent 自检",
        agentBranch: "Agent 分支",
        approved: "已批准",
        baseBranch: "基线分支",
        baseCommit: "基线提交",
        changeScope: "改动范围",
        check: "检查",
        command: "命令",
        closes: "关联",
        failed: "失败",
        failedQualityGates: "存在失败的质量门禁",
        frontendScreenshotVerification: "截图",
        githubCliOption: "方式 A：GitHub CLI",
        latestFeedback: "本轮用户反馈",
        languageMatched: "Issue/PR 语言匹配",
        localVerification: "本地验证",
        localVerificationSummary: "查看本地复现命令和 Agent 环境",
        missingPrSection: "PR 缺少章节",
        missingQualityGates: "缺少质量门禁结果",
        noAdditionalNotes: "无额外说明。",
        none: "无。",
        notRecorded: "未记录",
        passed: "通过",
        plainGitOption: "方式 B：普通 Git",
        prContentCompleteness: "提交检查",
        prFeedbackUpdated:
          "已根据最新 PR 评论更新同一个分支，并重新完成 Agent 自检。PR 正文已刷新为最新验证结果和截图产物引用。",
        qualityGates: "质量门禁",
        referencedArtifacts: "已记录为任务产物（不提交到代码分支）",
        result: "结果",
        reviewNotApproved: "Agent Review 尚未批准",
        reviewSubagent: "Agent Review",
        risk: "风险",
        sandboxImage: "沙箱镜像",
        sandboxMode: "沙箱模式",
        screenshotArtifacts: "截图",
        screenshotNotReferenced: "截图产物没有在 PR 正文中引用",
        seePrdArtifact: "见 PRD 产物。",
        selfChecksBeforePr: "创建 PR 前自检",
        summary: "摘要",
        unknown: "未知",
        issueReady: (prUrl: string) => `Agent 自检已完成并创建 PR：${prUrl}`,
      }
    : {
        agentVerification: "Agent Verification",
        agentBranch: "Agent branch",
        approved: "approved",
        baseBranch: "Base branch",
        baseCommit: "Base commit",
        changeScope: "Change Scope",
        check: "Check",
        command: "Command",
        closes: "Closes",
        failed: "failed",
        failedQualityGates: "One or more quality gates failed",
        frontendScreenshotVerification: "Frontend Screenshot Verification",
        githubCliOption: "Option A: GitHub CLI",
        latestFeedback: "Latest User Feedback",
        languageMatched: "Issue/PR language match",
        localVerification: "Local Verification",
        localVerificationSummary:
          "View local reproduction commands and Agent environment",
        missingPrSection: "PR body is missing section",
        missingQualityGates: "Missing quality gate results",
        noAdditionalNotes: "No additional notes.",
        none: "None.",
        notRecorded: "not recorded",
        passed: "passed",
        plainGitOption: "Option B: Plain Git",
        prContentCompleteness: "PR Content Completeness Check",
        prFeedbackUpdated:
          "Updated the same PR branch from the latest PR comment and reran Agent verification. The PR body now contains the latest checks and screenshot artifact references.",
        qualityGates: "Quality Gates",
        referencedArtifacts: "recorded as task artifacts (not committed to the code branch)",
        result: "Result",
        reviewNotApproved: "Agent Review has not approved the changes",
        reviewSubagent: "Agent Review",
        risk: "risk",
        sandboxImage: "Sandbox image",
        sandboxMode: "Sandbox mode",
        screenshotArtifacts: "Screenshot artifacts",
        screenshotNotReferenced:
          "Screenshot artifacts are not referenced in the PR body",
        seePrdArtifact: "See PRD artifact.",
        selfChecksBeforePr: "Self-checks before PR creation",
        summary: "Summary",
        unknown: "unknown",
        issueReady: (prUrl: string) =>
          `Agent self-checks completed and created the PR: ${prUrl}`,
      };
}

function prdCopy(locale: ConversationLocale) {
  return locale === "zh"
    ? {
        acceptanceCriteria: "验收标准",
        acceptanceFocus: "验收重点",
        autoApproved:
          "PRD 风险较低，已自动通过；CodeZero 会继续进入实现和自检阶段。",
        autoApprovedStatus: "已自动通过",
        background: "背景",
        complexity: "复杂度与审核",
        commandsToRun: "计划运行命令",
        detailedPlan: "详细计划",
        filesExpectedToChange: "预计修改文件",
        filesToRead: "计划阅读文件",
        goals: "目标",
        humanReview: "需要人工审核",
        implementationPlan: "PRD 执行计划",
        nextStep: "下一步",
        no: "否",
        nonGoals: "非目标",
        none: "无。",
        planAcceptanceCriteria: "计划验收点",
        planGoal: "计划目标",
        planNonGoals: "计划不做",
        planRiskNotes: "计划风险说明",
        requiresReviewStatus: "需要人工审核",
        requiresReview: (mention: string) =>
          `PRD 需要人工审核。确认可执行后，请在本 issue 回复 \`${mention} approve prd\` 或 \`${mention} 批准 PRD\`，也可以在看板点击批准。`,
        risks: "风险",
        riskAndUnknowns: "风险/未知项",
        score: "复杂度分数",
        scope: "改动范围",
        status: "状态",
        taskType: "任务类型",
        testsToAddOrUpdate: "计划新增或更新测试",
        title: "CodeZero PRD",
        unknowns: "未知项",
        userStories: "用户故事",
        yes: "是",
      }
    : {
        acceptanceCriteria: "Acceptance Criteria",
        acceptanceFocus: "Acceptance Focus",
        autoApproved:
          "The PRD is low risk and has been auto-approved; CodeZero will continue to implementation and self-checks.",
        autoApprovedStatus: "auto-approved",
        background: "Background",
        complexity: "Complexity And Review",
        commandsToRun: "Commands To Run",
        detailedPlan: "Detailed Plan",
        filesExpectedToChange: "Files Expected To Change",
        filesToRead: "Files To Read",
        goals: "Goals",
        humanReview: "Requires human review",
        implementationPlan: "PRD Execution Plan",
        nextStep: "Next Step",
        no: "no",
        nonGoals: "Non-Goals",
        none: "None.",
        planAcceptanceCriteria: "Plan Acceptance Criteria",
        planGoal: "Plan goal",
        planNonGoals: "Plan Non-Goals",
        planRiskNotes: "Plan Risk Notes",
        requiresReviewStatus: "requires human review",
        requiresReview: (mention: string) =>
          `The PRD requires human review. Reply with \`${mention} approve prd\` on this issue, or approve it from the dashboard, when it is ready to implement.`,
        risks: "Risks",
        riskAndUnknowns: "Risks / Unknowns",
        score: "Complexity score",
        scope: "Scope",
        status: "Status",
        taskType: "Task type",
        testsToAddOrUpdate: "Tests To Add Or Update",
        title: "CodeZero PRD",
        unknowns: "Unknowns",
        userStories: "User Stories",
        yes: "yes",
      };
}
