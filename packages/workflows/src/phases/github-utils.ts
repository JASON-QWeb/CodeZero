import { runCommand } from "@agent/sandbox";
import type { RepositoryConfig } from "@agent/config";
import {
  createGitHubRemoteUrl,
  GitHubClient,
  getGitHubAuthToken,
  hasGitHubAuthConfig,
  redactRemoteUrl,
} from "@agent/github";
import { shellQuote } from "@agent/shared";
import type { Artifact, Task } from "@agent/shared";
import type { WorkflowServices } from "./types.js";

export function hasGitHubAuth(host: WorkflowServices): boolean {
  return hasGitHubAuthConfig(host.config.github);
}

export function githubClient(host: WorkflowServices): GitHubClient {
  return new GitHubClient(host.config.github);
}

export async function authenticatedRemoteUrl(
  host: WorkflowServices,
  repositoryConfig: RepositoryConfig,
): Promise<string> {
  const token = await getGitHubAuthToken(host.config.github);
  return createGitHubRemoteUrl(
    repositoryConfig.github_owner,
    repositoryConfig.github_repo,
    token,
  );
}

export async function refreshOriginRemote(
  host: WorkflowServices,
  taskId: string,
  repoDir: string,
  repositoryConfig: RepositoryConfig,
): Promise<void> {
  const remoteUrl = await authenticatedRemoteUrl(host, repositoryConfig);
  const result = await runCommand({
    cwd: repoDir,
    command: `git remote set-url origin ${shellQuote(remoteUrl)}`,
    timeoutMs: 60_000,
  });
  await host.event(
    taskId,
    "COMMAND_FINISHED",
    `${redactRemoteUrl(result.command)} exited ${result.exitCode}`,
    result.exitCode === 0 ? "info" : "error",
  );

  if (result.exitCode !== 0) {
    throw new Error("Failed to refresh GitHub remote credentials");
  }
}

export function collectScreenshotArtifactsForPr(
  artifacts: Artifact[],
): Array<Pick<Artifact, "id" | "path" | "url" | "metadata">> {
  return artifacts
    .filter(
      (artifact) =>
        artifact.type === "screenshot" && (artifact.path || artifact.url),
    )
    .map((artifact) => ({
      id: artifact.id,
      path: artifact.path,
      url: artifact.url,
      metadata: artifact.metadata,
    }));
}

export function latestReviewerFeedback(task: Task): string {
  const latest = task.issue.comments.at(-1);
  return latest
    ? `${latest.author} at ${latest.createdAt}:\n${latest.body}`
    : "";
}

export function parseGitHubIssueNumber(url: string): number | undefined {
  const match = /\/(?:pull|issues)\/(\d+)(?:$|[?#])/.exec(url);
  return match?.[1] ? Number(match[1]) : undefined;
}
