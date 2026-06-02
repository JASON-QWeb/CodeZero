import { describe, expect, it } from "vitest";
import {
  evaluateRepositoryTrigger,
  type RepositoryConfig,
} from "@agent/config";

function repositoryWithTrigger(
  trigger: Partial<RepositoryConfig["trigger"]>,
): RepositoryConfig {
  return {
    id: "shop",
    github_owner: "acme",
    github_repo: "shop",
    default_branch: "main",
    project_skill_path: ".agent",
    project_rule_path: ".agent/rules",
    trigger: {
      mode: "auto",
      mention: "@agent-prd",
      auto_events: ["issues.opened", "issues.labeled", "issues.reopened"],
      label_allowlist: [],
      label_blocklist: [],
      actor_allowlist: [],
      ...trigger,
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
    quality_gates: {},
    frontend: { screenshot_urls: [] },
    pr: { default_draft: true },
  };
}

describe("repository trigger policy", () => {
  it("triggers automatically for configured issue events", () => {
    const decision = evaluateRepositoryTrigger({
      repository: repositoryWithTrigger({ mode: "auto" }),
      eventName: "issues",
      action: "opened",
    });

    expect(decision.shouldTrigger).toBe(true);
    expect(decision.trigger).toBe("auto");
  });

  it("uses mention mode for issue comments only", () => {
    const repository = repositoryWithTrigger({
      mode: "mention",
      mention: "@repo-agent",
    });

    expect(
      evaluateRepositoryTrigger({
        repository,
        eventName: "issues",
        action: "opened",
      }).shouldTrigger,
    ).toBe(false);

    const decision = evaluateRepositoryTrigger({
      repository,
      eventName: "issue_comment",
      action: "created",
      commentBody: "please handle this, @Repo-Agent",
    });

    expect(decision.shouldTrigger).toBe(true);
    expect(decision.mention).toBe("@repo-agent");
  });

  it("uses label mode with allowlist and blocklist", () => {
    const repository = repositoryWithTrigger({
      mode: "label",
      label_allowlist: ["agent-ready"],
      label_blocklist: ["no-agent"],
    });

    expect(
      evaluateRepositoryTrigger({
        repository,
        eventName: "issues",
        action: "labeled",
        labels: ["agent-ready"],
      }).shouldTrigger,
    ).toBe(true);

    const blocked = evaluateRepositoryTrigger({
      repository,
      eventName: "issues",
      action: "labeled",
      labels: ["agent-ready", "no-agent"],
    });

    expect(blocked.shouldTrigger).toBe(false);
    expect(blocked.reason).toContain("blocked label");
  });

  it("does not trigger disabled or unconfigured repositories", () => {
    expect(
      evaluateRepositoryTrigger({
        repository: repositoryWithTrigger({ mode: "disabled" }),
        eventName: "issues",
        action: "opened",
      }).shouldTrigger,
    ).toBe(false);

    expect(
      evaluateRepositoryTrigger({
        eventName: "issues",
        action: "opened",
      }).trigger,
    ).toBe("unconfigured");
  });
});
