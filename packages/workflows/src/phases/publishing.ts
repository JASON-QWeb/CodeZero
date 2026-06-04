import {
  createGitHubRemoteUrl,
  gitHubAuthRequiredMessage,
} from "@agent/github";
import type { RepositoryConfig } from "@agent/config";
import { createTaskMemoryProposal } from "@agent/memory";
import {
  commitAll,
  getCurrentCommitSha,
  pushBranch,
  type Sandbox,
} from "@agent/sandbox";
import type { Task } from "@agent/shared";
import {
  assertAgentPrBodyComplete,
  createAgentPrBody,
  createPrFeedbackUpdateComment,
  createPrLocalVerificationPlan,
  createPrReadyIssueComment,
  detectInstallCommand,
  detectIssueLocale,
} from "../pr-local-verification.js";
import {
  collectScreenshotArtifactsForPr,
  githubClient,
  hasGitHubAuth,
  parseGitHubIssueNumber,
  refreshOriginRemote,
} from "./github-utils.js";
import { createConfiguredMemoryStore } from "./memory-store.js";
import type { PublishingHost } from "./types.js";

export async function createDraftPr(
  host: PublishingHost,
  task: Task,
  sandbox: Sandbox,
  repositoryConfig: RepositoryConfig,
): Promise<string> {
  if (!hasGitHubAuth(host)) {
    throw new Error(
      `${gitHubAuthRequiredMessage} to push branch and create draft PR`,
    );
  }

  await host.updateStatus(task.id, "PR_CREATING");
  const agentBranch = task.branchName ?? `agent/issue-${task.issue.number}`;
  const baseSha = await getCurrentCommitSha(sandbox.repoDir);
  const installCommand = await detectInstallCommand(sandbox.repoDir);
  const artifacts = await host.tasks.listArtifacts(task.id);
  const screenshotArtifacts = collectScreenshotArtifactsForPr(artifacts);
  const verification = createPrLocalVerificationPlan({
    owner: repositoryConfig.github_owner,
    repo: repositoryConfig.github_repo,
    baseBranch: repositoryConfig.default_branch,
    baseSha,
    agentBranch,
    cloneUrl: createGitHubRemoteUrl(
      repositoryConfig.github_owner,
      repositoryConfig.github_repo,
    ),
    installCommand,
    qualityGateResults: task.qualityGateResults ?? [],
    devCommand: repositoryConfig.frontend.dev_command,
    screenshotArtifacts,
    sandbox: {
      mode: sandbox.mode,
      image: host.config.sandbox.image,
      repoDir: sandbox.repoDir,
      artifactDir: sandbox.artifactDir,
    },
  });
  await host.writeArtifact(
    task.id,
    "pr-verification",
    "pr-local-verification.json",
    JSON.stringify(verification, null, 2),
  );
  await host.event(
    task.id,
    "PR_VERIFICATION_CREATED",
    "PR local verification handoff created",
  );

  const commitResults = await commitAll(
    sandbox.repoDir,
    `Agent: ${task.issue.title}`,
  );

  if (commitResults.some((result) => result.exitCode !== 0)) {
    throw new Error("Commit failed");
  }

  await refreshOriginRemote(host, task.id, sandbox.repoDir, repositoryConfig);
  const pushResult = await pushBranch(sandbox.repoDir, agentBranch);

  if (pushResult.exitCode !== 0) {
    throw new Error(`Push failed: ${pushResult.stderr || pushResult.stdout}`);
  }

  const github = githubClient(host);
  const locale = detectIssueLocale(task.issue);
  const body = createAgentPrBody({ task, verification, locale });
  assertAgentPrBodyComplete({ task, verification, locale, body });
  const prUrl = await github.createDraftPullRequest({
    owner: repositoryConfig.github_owner,
    repo: repositoryConfig.github_repo,
    title: `Agent: ${task.issue.title}`,
    body,
    head: agentBranch,
    base: repositoryConfig.default_branch,
  });
  await github.createIssueComment({
    owner: repositoryConfig.github_owner,
    repo: repositoryConfig.github_repo,
    issueNumber: task.issue.number,
    body: createPrReadyIssueComment({ task, verification, prUrl, locale }),
  });
  const memoryProposal = createTaskMemoryProposal({
    task: { ...task, prUrl },
    artifacts: await host.tasks.listArtifacts(task.id),
  });
  await createConfiguredMemoryStore(host.config).propose(
    memoryProposal.records,
  );
  await host.writeArtifact(
    task.id,
    "memory-proposal",
    "memory-proposal.json",
    JSON.stringify(memoryProposal, null, 2),
  );
  await host.event(
    task.id,
    "MEMORY_PROPOSAL_CREATED",
    `Memory proposal created with ${memoryProposal.records.length} records`,
  );
  await host.event(task.id, "PR_CREATED", `Draft PR created: ${prUrl}`);
  return prUrl;
}

export async function updateExistingPullRequest(
  host: PublishingHost,
  task: Task,
  sandbox: Sandbox,
  repositoryConfig: RepositoryConfig,
  reviewerFeedback: string,
): Promise<void> {
  if (!hasGitHubAuth(host)) {
    throw new Error(`${gitHubAuthRequiredMessage} to update the pull request`);
  }

  const pullNumber = parseGitHubIssueNumber(task.prUrl ?? "");
  if (!pullNumber) {
    throw new Error(
      `Cannot parse pull request number from ${task.prUrl ?? "missing PR URL"}`,
    );
  }

  const agentBranch = task.branchName ?? `agent/issue-${task.issue.number}`;
  const baseSha = await getCurrentCommitSha(sandbox.repoDir);
  const artifacts = await host.tasks.listArtifacts(task.id);
  const screenshotArtifacts = collectScreenshotArtifactsForPr(artifacts);
  const installCommand = await detectInstallCommand(sandbox.repoDir);
  const verification = createPrLocalVerificationPlan({
    owner: repositoryConfig.github_owner,
    repo: repositoryConfig.github_repo,
    baseBranch: repositoryConfig.default_branch,
    baseSha,
    agentBranch,
    cloneUrl: createGitHubRemoteUrl(
      repositoryConfig.github_owner,
      repositoryConfig.github_repo,
    ),
    installCommand,
    qualityGateResults: task.qualityGateResults ?? [],
    devCommand: repositoryConfig.frontend.dev_command,
    screenshotArtifacts,
    sandbox: {
      mode: sandbox.mode,
      image: host.config.sandbox.image,
      repoDir: sandbox.repoDir,
      artifactDir: sandbox.artifactDir,
    },
  });

  await host.writeArtifact(
    task.id,
    "pr-verification",
    `pr-local-verification-${Date.now()}.json`,
    JSON.stringify(verification, null, 2),
  );
  await host.updateStatus(task.id, "PR_CREATING");

  const commitResults = await commitAll(
    sandbox.repoDir,
    `Agent feedback: ${task.issue.title}`,
  );

  if (commitResults.some((result) => result.exitCode !== 0)) {
    throw new Error("Feedback commit failed");
  }

  await refreshOriginRemote(host, task.id, sandbox.repoDir, repositoryConfig);
  const pushResult = await pushBranch(sandbox.repoDir, agentBranch);

  if (pushResult.exitCode !== 0) {
    throw new Error(
      `Feedback push failed: ${pushResult.stderr || pushResult.stdout}`,
    );
  }

  const github = githubClient(host);
  const locale = detectIssueLocale(task.issue);
  const body = createAgentPrBody({
    task,
    verification,
    locale,
    updateReason: reviewerFeedback,
  });
  assertAgentPrBodyComplete({
    task,
    verification,
    locale,
    updateReason: reviewerFeedback,
    body,
  });
  await github.updatePullRequest({
    owner: repositoryConfig.github_owner,
    repo: repositoryConfig.github_repo,
    pullNumber,
    title: `Agent: ${task.issue.title}`,
    body,
  });
  await github.createIssueComment({
    owner: repositoryConfig.github_owner,
    repo: repositoryConfig.github_repo,
    issueNumber: pullNumber,
    body: createPrFeedbackUpdateComment({
      task,
      verification,
      updateReason: reviewerFeedback,
      locale,
    }),
  });
  await host.event(
    task.id,
    "PR_UPDATED",
    `Draft PR updated after reviewer feedback: ${task.prUrl}`,
  );
}
