import type { RepositoryConfig } from "@agent/config";
import { computeRepositoryQueueState } from "@agent/orchestrator";
import type { Task } from "@agent/shared";

export type RepositoryQueueSummary = {
  id: string;
  owner: string;
  repo: string;
  fullName: string;
  configured: boolean;
  maxConcurrentIssues: number;
  runningCount: number;
  queuedCount: number;
  reviewCount: number;
  blockedCount: number;
  completedCount: number;
  totalCount: number;
  availableSlots: number;
  tasks: Task[];
};

export function buildRepositoryQueueSummaries(tasks: Task[], repositories: RepositoryConfig[]): RepositoryQueueSummary[] {
  const summaries = new Map<string, RepositoryQueueSummary>();

  for (const repository of repositories) {
    const key = repositoryKey(repository.github_owner, repository.github_repo);
    const state = computeRepositoryQueueState(tasks, repository);
    summaries.set(key, {
      id: repository.id,
      owner: repository.github_owner,
      repo: repository.github_repo,
      fullName: `${repository.github_owner}/${repository.github_repo}`,
      configured: true,
      ...state,
      tasks: []
    });
  }

  for (const task of tasks) {
    const key = repositoryKey(task.issue.owner, task.issue.repo);
    let summary = summaries.get(key);

    if (!summary) {
      const inferredRepository = {
        id: key,
        github_owner: task.issue.owner,
        github_repo: task.issue.repo,
        queue: {
          max_concurrent_issues: 1
        }
      };
      const state = computeRepositoryQueueState(tasks, inferredRepository);
      summary = {
        id: key,
        owner: task.issue.owner,
        repo: task.issue.repo,
        fullName: `${task.issue.owner}/${task.issue.repo}`,
        configured: false,
        ...state,
        tasks: []
      };
      summaries.set(key, summary);
    }

    summary.tasks.push(task);
  }

  return [...summaries.values()].sort((left, right) => {
    const activityDelta = right.runningCount + right.queuedCount - (left.runningCount + left.queuedCount);

    if (activityDelta !== 0) {
      return activityDelta;
    }

    return left.fullName.localeCompare(right.fullName);
  });
}

function repositoryKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}
