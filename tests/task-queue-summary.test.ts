import { describe, expect, it } from "vitest";
import type { RepositoryConfig } from "@agent/config";
import { createTask } from "@agent/orchestrator";
import type { IssueContext, Task } from "@agent/shared";
import { buildRepositoryQueueSummaries } from "../apps/api/src/routes/task-queue-summary.js";

describe("task queue summaries", () => {
  it("summarizes configured and unconfigured repository queues", () => {
    const configuredQueued = taskFor("acme", "shop", "QUEUED");
    const configuredRunning = taskFor("acme", "shop", "IMPLEMENTING");
    const unconfiguredBlocked = taskFor("other", "api", "BLOCKED");

    const summaries = buildRepositoryQueueSummaries(
      [configuredQueued, configuredRunning, unconfiguredBlocked],
      [repositoryConfig()],
    );
    const configured = summaries.find(
      (summary) => summary.fullName === "acme/shop",
    );
    const unconfigured = summaries.find(
      (summary) => summary.fullName === "other/api",
    );

    expect(configured).toMatchObject({
      configured: true,
      projectSkillPath: ".agent",
      projectRulePath: ".agent/rules",
      runningCount: 1,
      queuedCount: 1,
      maxConcurrentIssues: 2,
      availableSlots: 1,
    });
    expect(configured?.tasks.map((task) => task.status)).toEqual([
      "QUEUED",
      "IMPLEMENTING",
    ]);
    expect(unconfigured).toMatchObject({
      configured: false,
      blockedCount: 1,
      maxConcurrentIssues: 1,
    });
  });

  it("sorts active repositories before quiet repositories and then by name", () => {
    const summaries = buildRepositoryQueueSummaries(
      [taskFor("beta", "api", "QUEUED")],
      [
        {
          ...repositoryConfig(),
          id: "alpha",
          github_owner: "alpha",
          github_repo: "web",
        },
        {
          ...repositoryConfig(),
          id: "beta",
          github_owner: "beta",
          github_repo: "api",
        },
      ],
    );

    expect(summaries.map((summary) => summary.fullName)).toEqual([
      "beta/api",
      "alpha/web",
    ]);
  });
});

function taskFor(owner: string, repo: string, status: Task["status"]): Task {
  return {
    ...createTask(issue(owner, repo)),
    status,
  };
}

function issue(owner: string, repo: string): IssueContext {
  return {
    provider: "github",
    owner,
    repo,
    number: 1,
    url: `https://github.com/${owner}/${repo}/issues/1`,
    title: "Demo issue",
    body: "",
    labels: [],
    comments: [],
    baseBranch: "main",
  };
}

function repositoryConfig(): RepositoryConfig {
  return {
    id: "shop",
    github_owner: "acme",
    github_repo: "shop",
    default_branch: "main",
    project_skill_path: ".agent",
    project_rule_path: ".agent/rules",
    trigger: {
      mode: "manual",
      mention: "@agent-prd",
      auto_events: [],
      label_allowlist: [],
      label_blocklist: [],
      actor_allowlist: [],
    },
    codebase_intelligence: {
      codegraph: {
        enabled: true,
        package: "@colbymchenry/codegraph@0.9.3",
        init_args: ["--index"],
        timeout_ms: 600_000,
        fail_on_error: true,
      },
      navigation_graph: {
        enabled: true,
        include_git_history: true,
        include_codeowners: true,
        max_depth: 4,
      },
    },
    queue: {
      max_concurrent_issues: 2,
    },
    permissions: {
      allowed_tools: [],
      blocked_tools: [],
      allowed_permissions: [],
      blocked_permissions: [],
    },
    quality_gates: {},
    frontend: {
      screenshot_urls: [],
    },
    pr: {
      default_draft: true,
    },
  };
}
