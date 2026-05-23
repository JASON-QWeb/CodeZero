import type { Task } from "@agent/shared";
import type { RepositoryQueueSummary } from "./types";

export function buildRepositorySummariesFromTasks(tasks: Task[]): RepositoryQueueSummary[] {
  const summaries = new Map<string, RepositoryQueueSummary>();

  for (const task of tasks) {
    const key = `${task.issue.owner}/${task.issue.repo}`;
    const summary =
      summaries.get(key) ??
      ({
        id: key,
        owner: task.issue.owner,
        repo: task.issue.repo,
        fullName: key,
        configured: true,
        maxConcurrentIssues: task.issue.repo === "commerce" ? 2 : 1,
        runningCount: 0,
        queuedCount: 0,
        reviewCount: 0,
        blockedCount: 0,
        completedCount: 0,
        totalCount: 0,
        availableSlots: 0,
        tasks: []
      } satisfies RepositoryQueueSummary);

    summary.tasks.push(task);
    summary.totalCount += 1;

    if (isRunningStatus(task.status)) {
      summary.runningCount += 1;
    } else if (isQueuedStatus(task.status)) {
      summary.queuedCount += 1;
    } else if (["PRD_REVIEW_REQUIRED", "HUMAN_REVIEW"].includes(task.status)) {
      summary.reviewCount += 1;
    } else if (["BLOCKED", "FAILED"].includes(task.status)) {
      summary.blockedCount += 1;
    } else if (["DONE", "CANCELLED"].includes(task.status)) {
      summary.completedCount += 1;
    }

    summary.availableSlots = Math.max(0, summary.maxConcurrentIssues - summary.runningCount);
    summaries.set(key, summary);
  }

  return [...summaries.values()];
}

export function isQueuedStatus(status: Task["status"]): boolean {
  return ["QUEUED", "ISSUE_RECEIVED", "PRD_APPROVED"].includes(status);
}

export function isRunningStatus(status: Task["status"]): boolean {
  return [
    "CONTEXT_COLLECTING",
    "BRAINSTORMING",
    "PRD_DRAFTED",
    "SANDBOX_PREPARING",
    "ISSUE_BRANCH_CREATED",
    "CODEBASE_INDEXING",
    "AGENTIC_SEARCHING",
    "CONTEXT_PACK_CREATED",
    "IMPLEMENTING",
    "QUALITY_GATES_RUNNING",
    "SUBAGENT_REVIEWING",
    "PR_CREATING"
  ].includes(status);
}
