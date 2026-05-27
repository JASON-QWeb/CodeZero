import { evaluateRepositoryTrigger, type RepositoryConfig } from "@agent/config";
import { GitHubClient, type GitHubIssueComment, type GitHubIssueThread } from "@agent/github";
import { createTaskEvent } from "@agent/persistence";
import type { IssueComment, Task } from "@agent/shared";
import { createAndEnqueueTask, enqueueIssueWorkflow, getServices, type ApiServices } from "./task-services.js";

export type GitHubSyncStatus = "idle" | "running" | "finished" | "failed";

export type GitHubSyncResult = {
  repositoryId: string;
  fullName: string;
  scannedIssues: number;
  importedIssues: number;
  skippedIssues: number;
  scannedFeedbackPullRequests: number;
  importedFeedbackComments: number;
  queuedFeedbackTasks: number;
  failedFeedbackQueues: number;
  skippedFeedbackComments: number;
};

export type GitHubSyncState = {
  repositoryId: string;
  status: GitHubSyncStatus;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
  lastResult?: GitHubSyncResult;
};

export type GitHubSyncClient = Pick<GitHubClient, "listOpenIssueThreads" | "listPullRequestFeedback">;

export type GitHubSyncOptions = {
  github?: GitHubSyncClient;
  enqueue?: (taskId: string, jobId?: string) => Promise<void>;
  issueLimit?: number;
};

export class GitHubSyncRepositoryNotFoundError extends Error {
  constructor(repositoryId: string) {
    super(`Repository '${repositoryId}' is not configured`);
  }
}

export class GitHubSyncRunError extends Error {
  constructor(
    message: string,
    readonly result: GitHubSyncResult
  ) {
    super(message);
  }
}

type SyncLogger = {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
};

const syncStates = new Map<string, GitHubSyncState>();
const runningSyncs = new Map<string, Promise<GitHubSyncResult>>();

export function getGitHubRepositorySyncState(repositoryId: string): GitHubSyncState {
  return syncStates.get(repositoryId) ?? { repositoryId, status: "idle" };
}

export async function triggerGitHubRepositorySync(
  repositoryId: string,
  options: GitHubSyncOptions = {}
): Promise<{ started: boolean; sync: GitHubSyncState }> {
  const services = await getServices();
  findRepositoryById(services.config.repositories, repositoryId);

  const running = runningSyncs.get(repositoryId);
  if (running) {
    return { started: false, sync: getGitHubRepositorySyncState(repositoryId) };
  }

  const promise = runGitHubRepositorySync(repositoryId, options).finally(() => {
    runningSyncs.delete(repositoryId);
  });
  runningSyncs.set(repositoryId, promise);
  void promise.catch(() => undefined);

  return { started: true, sync: getGitHubRepositorySyncState(repositoryId) };
}

export async function triggerAllGitHubRepositorySyncs(options: GitHubSyncOptions = {}): Promise<GitHubSyncState[]> {
  const services = await getServices();
  const states = await Promise.all(services.config.repositories.map((repository) => triggerGitHubRepositorySync(repository.id, options)));
  return states.map((state) => state.sync);
}

export async function runGitHubRepositorySync(repositoryId: string, options: GitHubSyncOptions = {}): Promise<GitHubSyncResult> {
  const startedAt = new Date().toISOString();
  syncStates.set(repositoryId, {
    repositoryId,
    status: "running",
    lastStartedAt: startedAt
  });

  try {
    const services = await getServices();
    const repository = findRepositoryById(services.config.repositories, repositoryId);
    const github = options.github ?? createGitHubSyncClient(services.config.github.token);
    const result = await collectGitHubUpdates(services, repository, github, options);
    syncStates.set(repositoryId, {
      repositoryId,
      status: "finished",
      lastStartedAt: startedAt,
      lastFinishedAt: new Date().toISOString(),
      lastResult: result
    });
    return result;
  } catch (error) {
    syncStates.set(repositoryId, {
      repositoryId,
      status: "failed",
      lastStartedAt: startedAt,
      lastFinishedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
      lastResult: error instanceof GitHubSyncRunError ? error.result : undefined
    });
    throw error;
  }
}

export function resetGitHubSyncStateForTests(): void {
  syncStates.clear();
  runningSyncs.clear();
}

export function startGitHubSyncScheduler(logger: SyncLogger): () => void {
  const intervalMs = Number(process.env.GITHUB_SYNC_INTERVAL_MS ?? (process.env.NODE_ENV === "test" ? 0 : 60000));

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => undefined;
  }

  const run = () => {
    void triggerAllGitHubRepositorySyncs().catch((error) => {
      logger.error("GitHub sync scheduler failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  if (process.env.GITHUB_SYNC_RUN_ON_STARTUP === "true") {
    run();
  }

  logger.info("GitHub sync scheduler started", { intervalMs });
  return () => clearInterval(timer);
}

async function collectGitHubUpdates(
  services: ApiServices,
  repository: RepositoryConfig,
  github: GitHubSyncClient,
  options: GitHubSyncOptions
): Promise<GitHubSyncResult> {
  const result: GitHubSyncResult = {
    repositoryId: repository.id,
    fullName: `${repository.github_owner}/${repository.github_repo}`,
    scannedIssues: 0,
    importedIssues: 0,
    skippedIssues: 0,
    scannedFeedbackPullRequests: 0,
    importedFeedbackComments: 0,
    queuedFeedbackTasks: 0,
    failedFeedbackQueues: 0,
    skippedFeedbackComments: 0
  };
  const tasks = await services.tasks.listTasks();
  const issueThreads = await github.listOpenIssueThreads(repository.github_owner, repository.github_repo, {
    baseBranch: repository.default_branch,
    perPage: options.issueLimit ?? Number(process.env.GITHUB_SYNC_ISSUE_LIMIT ?? 50)
  });

  for (const issue of issueThreads) {
    result.scannedIssues += 1;

    if (hasTrackedIssueTask(tasks, issue)) {
      result.skippedIssues += 1;
      continue;
    }

    const decision = findTriggerDecision(repository, issue);
    if (!decision.shouldTrigger) {
      result.skippedIssues += 1;
      continue;
    }

    const task = await createAndEnqueueTask(
      {
        provider: "github",
        owner: issue.owner,
        repo: issue.repo,
        number: issue.number,
        url: issue.url,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        comments: issue.comments,
        baseBranch: issue.baseBranch
      },
      { enqueue: options.enqueue }
    );
    tasks.push(task);
    result.importedIssues += 1;
  }

  const feedbackTasks = tasks.filter((task) => isFeedbackTaskForRepository(task, repository));
  for (const task of feedbackTasks) {
    const pullNumber = parsePullNumber(task.prUrl);

    if (!pullNumber) {
      continue;
    }

    result.scannedFeedbackPullRequests += 1;
    const comments = await github.listPullRequestFeedback(repository.github_owner, repository.github_repo, pullNumber);
    const humanComments = comments.filter((comment) => !isBotActor(comment.author));
    const newComments = humanComments.filter((comment) => !hasKnownComment(task.issue.comments, comment));
    result.skippedFeedbackComments += humanComments.length - newComments.length;

    if (newComments.length === 0) {
      continue;
    }

    const appendedComments = newComments.map(toIssueComment);
    const updated = await services.tasks.updateTask(task.id, {
      issue: {
        ...task.issue,
        comments: [...task.issue.comments, ...appendedComments]
      }
    });

    for (const comment of newComments) {
      await services.tasks.appendEvent(
        createTaskEvent({
          taskId: updated.id,
          type: "PR_REVIEW_COMMENT_RECEIVED",
          message: `PR feedback received from ${comment.author}`,
            metadata: {
              commentUrl: comment.url ?? null,
              commentId: comment.id ?? null,
              prUrl: task.prUrl ?? null,
              feedbackSource: comment.source,
              source: "github-sync"
            }
          })
      );
    }

    result.importedFeedbackComments += newComments.length;

    try {
      const lastComment = newComments[newComments.length - 1];
      await (options.enqueue ?? enqueueIssueWorkflow)(updated.id, `${updated.id}-pr-sync-${lastComment?.id ?? Date.now()}`);
      result.queuedFeedbackTasks += 1;
    } catch (error) {
      result.failedFeedbackQueues += 1;
      await services.tasks.updateTask(updated.id, { status: "BLOCKED" });
      const message = `PR feedback imported but workflow queue is unavailable: ${error instanceof Error ? error.message : String(error)}`;
      await services.tasks.appendEvent(
        createTaskEvent({
          taskId: updated.id,
          type: "TASK_BLOCKED",
          level: "warn",
          message
        })
      );
      throw new GitHubSyncRunError(message, result);
    }
  }

  return result;
}

function findTriggerDecision(repository: RepositoryConfig, issue: GitHubIssueThread): { shouldTrigger: boolean } {
  const issueActions = ["opened", "reopened", "labeled"];

  for (const action of issueActions) {
    const decision = evaluateRepositoryTrigger({
      repository,
      eventName: "issues",
      action,
      labels: issue.labels,
      actor: issue.author
    });

    if (decision.shouldTrigger) {
      return decision;
    }
  }

  for (const comment of issue.comments) {
    const decision = evaluateRepositoryTrigger({
      repository,
      eventName: "issue_comment",
      action: "created",
      labels: issue.labels,
      commentBody: comment.body,
      actor: comment.author,
      fallbackMention: process.env.AGENT_TRIGGER_MENTION ?? "@agent-prd"
    });

    if (decision.shouldTrigger) {
      return decision;
    }
  }

  return { shouldTrigger: false };
}

function findRepositoryById(repositories: RepositoryConfig[], repositoryId: string): RepositoryConfig {
  const repository = repositories.find((entry) => entry.id === repositoryId);

  if (!repository) {
    throw new GitHubSyncRepositoryNotFoundError(repositoryId);
  }

  return repository;
}

function createGitHubSyncClient(token?: string): GitHubSyncClient {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to sync GitHub issues and PR comments");
  }

  return new GitHubClient({ token });
}

function hasTrackedIssueTask(tasks: Task[], issue: Pick<GitHubIssueThread, "owner" | "repo" | "number">): boolean {
  return tasks.some((task) => task.issue.owner === issue.owner && task.issue.repo === issue.repo && task.issue.number === issue.number);
}

function isFeedbackTaskForRepository(task: Task, repository: RepositoryConfig): boolean {
  return (
    task.issue.owner === repository.github_owner &&
    task.issue.repo === repository.github_repo &&
    Boolean(task.prUrl) &&
    ["HUMAN_REVIEW", "BLOCKED"].includes(task.status)
  );
}

function parsePullNumber(prUrl?: string): number | undefined {
  const match = prUrl?.match(/\/pull\/(\d+)(?:$|[?#])/);
  return match ? Number(match[1]) : undefined;
}

function hasKnownComment(existing: IssueComment[], comment: GitHubIssueComment): boolean {
  return existing.some((entry) => entry.author === comment.author && entry.body === comment.body && entry.createdAt === comment.createdAt);
}

function toIssueComment(comment: GitHubIssueComment): IssueComment {
  return {
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt
  };
}

function isBotActor(actor: string): boolean {
  return actor.endsWith("[bot]") || actor === "github-actions" || actor === "dependabot";
}
