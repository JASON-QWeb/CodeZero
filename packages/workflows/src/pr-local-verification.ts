import { access } from "node:fs/promises";
import path from "node:path";
import type { Artifact, JsonValue, QualityGateResult, Task } from "@agent/shared";

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
  const qualityGateLines =
    task.qualityGateResults && task.qualityGateResults.length > 0
      ? task.qualityGateResults.map((result) => `- ${result.kind}: ${result.passed ? "passed" : "failed"} (${result.command})`)
      : ["- Not recorded."];
  const reviewNotes = task.reviewResult?.prDescriptionNotes ?? [];

  return [
    `Closes ${task.issue.url}`,
    "",
    "## Summary",
    goalsToMarkdown(task),
    "",
    formatPrLocalVerificationMarkdown(input.verification),
    "",
    "## Quality Gates",
    ...qualityGateLines,
    "",
    "## Review Subagent",
    `- approved: ${task.reviewResult?.approved ?? false}`,
    `- risk: ${task.reviewResult?.riskLevel ?? "unknown"}`,
    ...(reviewNotes.length > 0 ? reviewNotes.map((note) => `- ${note}`) : ["- No additional notes."])
  ].join("\n");
}

export function formatPrLocalVerificationMarkdown(plan: PrLocalVerificationPlan): string {
  const commandSummary =
    plan.commands.qualityGates.length > 0
      ? plan.commands.qualityGates.map((gate) => `- ${gate.kind}: ${gate.passed ? "passed" : "failed"} (${gate.command})`)
      : ["- No quality gate commands were recorded."];
  const screenshots =
    plan.screenshots.length > 0
      ? plan.screenshots.map((screenshot) => {
          const target = screenshot.url ? `${screenshot.url}${screenshot.viewport ? ` ${screenshot.viewport}` : ""}` : "screenshot";
          return `- ${target}: ${screenshot.artifact}`;
        })
      : ["- None."];

  return [
    "## Local Verification",
    "",
    "### Option A: GitHub CLI",
    "",
    "```bash",
    ...plan.commands.githubCli,
    "```",
    "",
    "### Option B: Plain Git",
    "",
    "```bash",
    ...plan.commands.plainGit,
    "```",
    "",
    "### Agent Verification",
    "",
    `- Base branch: ${plan.branches.base}`,
    `- Base commit: ${plan.branches.baseSha}`,
    `- Agent branch: ${plan.branches.agent}`,
    `- Sandbox mode: ${plan.sandbox.mode ?? "unknown"}`,
    `- Sandbox image: ${plan.sandbox.image ?? "not recorded"}`,
    "- Commands run by agent:",
    ...commandSummary,
    "- Screenshot artifacts:",
    ...screenshots
  ].join("\n");
}

function goalsToMarkdown(task: Task): string {
  if (!task.prd || task.prd.goals.length === 0) {
    return "- See PRD artifact.";
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
