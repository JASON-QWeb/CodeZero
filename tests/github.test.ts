import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, createGitHubRemoteUrl, redactRemoteUrl, type GitHubApiClient } from "@agent/github";

const issuesGet = vi.fn();
const listComments = vi.fn();
const issuesUpdate = vi.fn();
const createComment = vi.fn();
const pullsCreate = vi.fn();
const pullsUpdate = vi.fn();

function fakeOctokit(): GitHubApiClient {
  return {
    issues: {
      get: issuesGet,
      listComments,
      update: issuesUpdate,
      createComment
    },
    pulls: {
      create: pullsCreate,
      update: pullsUpdate
    }
  } as unknown as GitHubApiClient;
}

describe("github client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds and redacts token-authenticated remote URLs", () => {
    const remote = createGitHubRemoteUrl("acme", "shop", "ghp_token/value");

    expect(remote).toBe("https://x-access-token:ghp_token%2Fvalue@github.com/acme/shop.git");
    expect(redactRemoteUrl(remote)).toBe("https://x-access-token:***@github.com/acme/shop.git");
    expect(createGitHubRemoteUrl("acme", "shop")).toBe("https://github.com/acme/shop.git");
  });

  it("normalizes GitHub issue payloads into IssueContext", async () => {
    issuesGet.mockResolvedValue({
      data: {
        html_url: "https://github.com/acme/shop/issues/12",
        title: "Fix checkout",
        body: null,
        labels: ["bug", { name: "frontend" }, { name: null }]
      }
    });
    listComments.mockResolvedValue({
      data: [{ user: { login: "alice" }, body: "please fix", created_at: "2026-01-01T00:00:00Z" }]
    });

    const issue = await new GitHubClient({ token: "token" }, fakeOctokit()).getIssue("acme", "shop", 12, "develop");

    expect(issue).toMatchObject({
      owner: "acme",
      repo: "shop",
      number: 12,
      title: "Fix checkout",
      body: "",
      labels: ["bug", "frontend"],
      baseBranch: "develop"
    });
    expect(issue.comments[0]?.author).toBe("alice");
  });

  it("creates draft pull requests and returns the HTML URL", async () => {
    pullsCreate.mockResolvedValue({ data: { html_url: "https://github.com/acme/shop/pull/5" } });

    await expect(
      new GitHubClient({ token: "token" }, fakeOctokit()).createDraftPullRequest({
        owner: "acme",
        repo: "shop",
        title: "Agent PR",
        body: "Body",
        head: "agent/issue-1",
        base: "main"
      })
    ).resolves.toBe("https://github.com/acme/shop/pull/5");
    expect(pullsCreate).toHaveBeenCalledWith(expect.objectContaining({ draft: true, head: "agent/issue-1" }));
  });

  it("updates pull requests and comments on the PR conversation", async () => {
    pullsUpdate.mockResolvedValue({ data: { html_url: "https://github.com/acme/shop/pull/5" } });
    createComment.mockResolvedValue({ data: { html_url: "https://github.com/acme/shop/pull/5#issuecomment-1" } });

    const client = new GitHubClient({ token: "token" }, fakeOctokit());

    await expect(
      client.updatePullRequest({
        owner: "acme",
        repo: "shop",
        pullNumber: 5,
        body: "updated"
      })
    ).resolves.toBe("https://github.com/acme/shop/pull/5");
    await expect(client.createIssueComment({ owner: "acme", repo: "shop", issueNumber: 5, body: "done" })).resolves.toContain("#issuecomment-1");
    expect(pullsUpdate).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 5, body: "updated" }));
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 5, body: "done" }));
  });
});
