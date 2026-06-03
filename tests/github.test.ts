import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, createGitHubRemoteUrl, hasGitHubAuthConfig, redactRemoteUrl, type GitHubApiClient } from "@agent/github";

const issuesGet = vi.fn();
const listComments = vi.fn();
const listForRepo = vi.fn();
const issuesUpdate = vi.fn();
const issuesCreate = vi.fn();
const createComment = vi.fn();
const pullsCreate = vi.fn();
const pullsUpdate = vi.fn();
const listReviewComments = vi.fn();
const listReviews = vi.fn();

function fakeOctokit(): GitHubApiClient {
  return {
    issues: {
      get: issuesGet,
      listComments,
      listForRepo,
      update: issuesUpdate,
      create: issuesCreate,
      createComment
    },
    pulls: {
      create: pullsCreate,
      update: pullsUpdate,
      listReviewComments,
      listReviews
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

  it("recognizes token and complete GitHub App auth configs", () => {
    expect(hasGitHubAuthConfig({ token: "ghp_token" })).toBe(true);
    expect(
      hasGitHubAuthConfig({
        app: {
          appId: "123",
          installationId: "456",
          privateKeyPath: "/tmp/app.pem"
        }
      })
    ).toBe(true);
    expect(hasGitHubAuthConfig({ app: { appId: "123", installationId: "456" } })).toBe(false);
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
      data: [{ id: 1, user: { login: "alice" }, body: "please fix", created_at: "2026-01-01T00:00:00Z" }]
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

  it("paginates issue comments so late trigger comments are not missed", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      user: { login: "alice" },
      body: `comment ${index + 1}`,
      created_at: `2026-05-27T00:${String(index % 60).padStart(2, "0")}:00Z`,
      html_url: `https://github.com/acme/shop/issues/14#issuecomment-${index + 1}`
    }));
    listComments
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({
        data: [
          {
            id: 101,
            user: { login: "bob" },
            body: "@agent-prd this is the latest trigger",
            created_at: "2026-05-27T02:00:00Z",
            html_url: "https://github.com/acme/shop/issues/14#issuecomment-101"
          }
        ]
      });

    const comments = await new GitHubClient({ token: "token" }, fakeOctokit()).listIssueComments("acme", "shop", 14);

    expect(comments).toHaveLength(101);
    expect(comments[100]).toMatchObject({ id: "issue_comment-101", source: "issue_comment", author: "bob" });
    expect(listComments).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, per_page: 100 }));
  });

  it("lists open issue threads with comments and skips pull requests", async () => {
    listForRepo.mockResolvedValue({
      data: [
        {
          number: 14,
          html_url: "https://github.com/acme/shop/issues/14",
          title: "Async sync",
          body: "please sync",
          labels: [{ name: "agent-ready" }],
          user: { login: "alice" },
          updated_at: "2026-05-27T00:00:00Z"
        },
        {
          number: 15,
          html_url: "https://github.com/acme/shop/pull/15",
          title: "Pull request",
          body: "",
          labels: [],
          user: { login: "bot" },
          updated_at: "2026-05-27T00:00:00Z",
          pull_request: { html_url: "https://github.com/acme/shop/pull/15" }
        }
      ]
    });
    listComments.mockResolvedValue({
      data: [
        {
          id: 99,
          user: { login: "alice" },
          body: "@agent-prd go",
          created_at: "2026-05-27T01:00:00Z",
          html_url: "https://github.com/acme/shop/issues/14#issuecomment-99"
        }
      ]
    });

    const issues = await new GitHubClient({ token: "token" }, fakeOctokit()).listOpenIssueThreads("acme", "shop", {
      baseBranch: "develop",
      perPage: 25
    });

    expect(listForRepo).toHaveBeenCalledWith(expect.objectContaining({ state: "open", sort: "updated", per_page: 25 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      number: 14,
      title: "Async sync",
      labels: ["agent-ready"],
      author: "alice",
      baseBranch: "develop",
      isPullRequest: false
    });
    expect(issues[0]?.comments[0]?.body).toContain("@agent-prd");
  });

  it("combines PR conversation comments, review summaries, and inline review comments", async () => {
    listComments.mockResolvedValue({ data: [] });
    listReviews.mockResolvedValue({
      data: [
        {
          id: 7,
          user: { login: "reviewer" },
          body: "Overall please adjust copy",
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-05-27T01:00:00Z",
          html_url: "https://github.com/acme/shop/pull/5#pullrequestreview-7"
        }
      ]
    });
    listReviewComments.mockResolvedValue({
      data: [
        {
          id: 8,
          user: { login: "reviewer" },
          body: "This branch needs async state",
          path: "src/App.tsx",
          line: 42,
          created_at: "2026-05-27T01:01:00Z",
          html_url: "https://github.com/acme/shop/pull/5#discussion_r8"
        }
      ]
    });

    const feedback = await new GitHubClient({ token: "token" }, fakeOctokit()).listPullRequestFeedback("acme", "shop", 5);

    expect(feedback).toHaveLength(2);
    expect(feedback[0]).toMatchObject({ id: "review-7", source: "review", author: "reviewer" });
    expect(feedback[1]).toMatchObject({ id: "review_comment-8", source: "review_comment" });
    expect(feedback[1]?.body).toContain("src/App.tsx:42");
    expect(listReviews).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 5, page: 1, per_page: 100 }));
    expect(listReviewComments).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 5, page: 1, per_page: 100 }));
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

  it("creates issues and normalizes the created issue payload", async () => {
    issuesCreate.mockResolvedValue({
      data: {
        number: 42,
        html_url: "https://github.com/acme/shop/issues/42",
        title: "Implement checkout telemetry",
        body: "Track the checkout funnel.",
        labels: ["agent-ready", { name: "analytics" }]
      }
    });

    const issue = await new GitHubClient({ token: "token" }, fakeOctokit()).createIssue({
      owner: "acme",
      repo: "shop",
      title: "Implement checkout telemetry",
      body: "Track the checkout funnel.",
      labels: ["agent-ready"],
      baseBranch: "develop"
    });

    expect(issuesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "shop",
        title: "Implement checkout telemetry",
        labels: ["agent-ready"]
      })
    );
    expect(issue).toMatchObject({
      provider: "github",
      owner: "acme",
      repo: "shop",
      number: 42,
      labels: ["agent-ready", "analytics"],
      comments: [],
      baseBranch: "develop"
    });
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
