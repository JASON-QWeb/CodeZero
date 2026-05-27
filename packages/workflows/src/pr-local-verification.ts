import { access } from "node:fs/promises";
import path from "node:path";
import type { Artifact, IssueContext, JsonValue, QualityGateResult, Task } from "@agent/shared";

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
  screenshotArtifacts?: Array<Pick<Artifact, "path" | "url" | "metadata">>;
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

const installCommandCandidates = [
  { file: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
  { file: "package-lock.json", command: "npm ci" },
  { file: "yarn.lock", command: "yarn install --frozen-lockfile" },
  { file: "bun.lockb", command: "bun install --frozen-lockfile" },
  { file: "bun.lock", command: "bun install --frozen-lockfile" },
  { file: "uv.lock", command: "uv sync" },
  { file: "poetry.lock", command: "poetry install" },
  { file: "requirements.txt", command: "python -m pip install -r requirements.txt" },
  { file: "package.json", command: "npm install" }
] as const;

export async function detectInstallCommand(repoDir: string): Promise<string | undefined> {
  for (const candidate of installCommandCandidates) {
    const exists = await access(path.join(repoDir, candidate.file)).then(
      () => true,
      () => false
    );

    if (exists) {
      return candidate.command;
    }
  }

  return undefined;
}

export function createPrLocalVerificationPlan(input: PrLocalVerificationInput): PrLocalVerificationPlan {
  const cloneUrl = input.cloneUrl ?? `https://github.com/${input.owner}/${input.repo}.git`;
  const qualityGates = dedupeQualityGateResults(input.qualityGateResults ?? []);
  const postCheckoutCommands = [
    input.installCommand,
    ...qualityGates.map((result) => result.command),
    input.devCommand
  ].filter((command): command is string => Boolean(command));

  return {
    repository: {
      owner: input.owner,
      repo: input.repo,
      cloneUrl
    },
    branches: {
      base: input.baseBranch,
      baseSha: input.baseSha,
      agent: input.agentBranch
    },
    commands: {
      githubCli: [`gh repo clone ${input.owner}/${input.repo}`, `cd ${input.repo}`, `gh pr checkout ${input.agentBranch}`, ...postCheckoutCommands],
      plainGit: [`git clone ${cloneUrl}`, `cd ${input.repo}`, `git fetch origin ${input.agentBranch}`, `git checkout ${input.agentBranch}`, ...postCheckoutCommands],
      install: input.installCommand,
      qualityGates,
      dev: input.devCommand
    },
    screenshots: (input.screenshotArtifacts ?? []).map((artifact) => ({
      url: metadataString(artifact.metadata?.url),
      viewport: metadataString(artifact.metadata?.viewport),
      artifact: artifact.url ?? artifact.path ?? "task artifact"
    })),
    sandbox: input.sandbox ?? {}
  };
}

export function createAgentPrBody(input: AgentPrBodyInput): string {
  const task = input.task;
  const locale = input.locale ?? detectIssueLocale(task.issue);
  const qualityGateLines =
    task.qualityGateResults && task.qualityGateResults.length > 0
      ? task.qualityGateResults.map((result) => `- ${result.kind}: ${result.passed ? copy(locale).passed : copy(locale).failed} (${result.command})`)
      : [`- ${copy(locale).notRecorded}`];
  const reviewNotes = task.reviewResult?.prDescriptionNotes ?? [];

  return [
    `${copy(locale).closes} ${task.issue.url}`,
    "",
    `## ${copy(locale).summary}`,
    goalsToMarkdown(task),
    ...(input.updateReason ? ["", `## ${copy(locale).latestFeedback}`, input.updateReason] : []),
    "",
    formatPrLocalVerificationMarkdown(input.verification, locale),
    "",
    `## ${copy(locale).qualityGates}`,
    ...qualityGateLines,
    "",
    `## ${copy(locale).reviewSubagent}`,
    `- ${copy(locale).approved}: ${task.reviewResult?.approved ?? false}`,
    `- ${copy(locale).risk}: ${task.reviewResult?.riskLevel ?? "unknown"}`,
    ...(reviewNotes.length > 0 ? reviewNotes.map((note) => `- ${note}`) : [`- ${copy(locale).noAdditionalNotes}`])
  ].join("\n");
}

export function formatPrLocalVerificationMarkdown(plan: PrLocalVerificationPlan, locale: ConversationLocale = "en"): string {
  const text = copy(locale);
  const commandSummary =
    plan.commands.qualityGates.length > 0
      ? plan.commands.qualityGates.map((gate) => `- ${gate.kind}: ${gate.passed ? text.passed : text.failed} (${gate.command})`)
      : [`- ${text.noQualityGateCommands}`];
  const screenshots =
    plan.screenshots.length > 0
      ? plan.screenshots.map((screenshot) => {
          const target = screenshot.url ? `${screenshot.url}${screenshot.viewport ? ` ${screenshot.viewport}` : ""}` : "screenshot";
          if (isEmbeddableImageUrl(screenshot.artifact)) {
            return `![${target}](${screenshot.artifact})`;
          }
          return `- ${target}: ${screenshot.artifact}`;
        })
      : [`- ${text.none}`];

  return [
    `## ${text.localVerification}`,
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
    `- ${text.commandsRunByAgent}:`,
    ...commandSummary,
    `- ${text.screenshotArtifacts}:`,
    ...screenshots
  ].join("\n");
}

export function detectIssueLocale(issue: IssueContext): ConversationLocale {
  const text = [issue.title, issue.body, ...issue.comments.map((comment) => comment.body)].join("\n");
  return /[\u3400-\u9fff]/.test(text) ? "zh" : "en";
}

export function languageInstruction(locale: ConversationLocale): string {
  return locale === "zh"
    ? "用户使用中文。所有面向用户的字段、说明、PRD、计划、review notes、PR 正文和 GitHub 回复都必须使用中文；代码标识符和命令保持原文。"
    : "The user is using English. Write all user-facing fields, notes, PR text, and GitHub replies in English; keep code identifiers and commands unchanged.";
}

function goalsToMarkdown(task: Task): string {
  if (!task.prd || task.prd.goals.length === 0) {
    return `- ${copy(detectIssueLocale(task.issue)).seePrdArtifact}`;
  }

  return task.prd.goals.map((goal) => `- ${goal}`).join("\n");
}

function dedupeQualityGateResults(results: QualityGateResult[]): PrLocalVerificationPlan["commands"]["qualityGates"] {
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
      exitCode: result.exitCode
    });
  }

  return deduped;
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
        agentVerification: "机器人自检",
        agentBranch: "机器人分支",
        approved: "已批准",
        baseBranch: "基线分支",
        baseCommit: "基线提交",
        closes: "关联",
        commandsRunByAgent: "机器人已运行命令",
        failed: "失败",
        githubCliOption: "方式 A：GitHub CLI",
        latestFeedback: "本轮用户反馈",
        localVerification: "本地验证",
        noAdditionalNotes: "无额外说明。",
        noQualityGateCommands: "没有记录质量门禁命令。",
        none: "无。",
        notRecorded: "未记录",
        passed: "通过",
        plainGitOption: "方式 B：普通 Git",
        qualityGates: "质量门禁",
        reviewSubagent: "机器人自检 Review",
        risk: "风险",
        sandboxImage: "沙箱镜像",
        sandboxMode: "沙箱模式",
        screenshotArtifacts: "截图",
        seePrdArtifact: "见 PRD 产物。",
        summary: "摘要",
        unknown: "未知"
      }
    : {
        agentVerification: "Agent Verification",
        agentBranch: "Agent branch",
        approved: "approved",
        baseBranch: "Base branch",
        baseCommit: "Base commit",
        closes: "Closes",
        commandsRunByAgent: "Commands run by agent",
        failed: "failed",
        githubCliOption: "Option A: GitHub CLI",
        latestFeedback: "Latest User Feedback",
        localVerification: "Local Verification",
        noAdditionalNotes: "No additional notes.",
        noQualityGateCommands: "No quality gate commands were recorded.",
        none: "None.",
        notRecorded: "not recorded",
        passed: "passed",
        plainGitOption: "Option B: Plain Git",
        qualityGates: "Quality Gates",
        reviewSubagent: "Review Subagent",
        risk: "risk",
        sandboxImage: "Sandbox image",
        sandboxMode: "Sandbox mode",
        screenshotArtifacts: "Screenshot artifacts",
        seePrdArtifact: "See PRD artifact.",
        summary: "Summary",
        unknown: "unknown"
      };
}
