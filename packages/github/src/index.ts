import { Octokit } from "@octokit/rest";
import type { IssueContext } from "@agent/shared";

export type GitHubClientConfig = {
  token: string;
};

export type GitHubApiClient = Pick<Octokit, "issues" | "pulls">;

export class GitHubClient {
  private readonly octokit: GitHubApiClient;

  constructor(config: GitHubClientConfig, octokit: GitHubApiClient = new Octokit({ auth: config.token })) {
    this.octokit = octokit;
  }

  async getIssue(owner: string, repo: string, issueNumber: number, baseBranch = "main"): Promise<IssueContext> {
    const [{ data: issue }, { data: comments }] = await Promise.all([
      this.octokit.issues.get({ owner, repo, issue_number: issueNumber }),
      this.octokit.issues.listComments({ owner, repo, issue_number: issueNumber, per_page: 100 })
    ]);

    return {
      provider: "github",
      owner,
      repo,
      number: issueNumber,
      url: issue.html_url,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean),
      comments: comments.map((comment) => ({
        author: comment.user?.login ?? "unknown",
        body: comment.body ?? "",
        createdAt: comment.created_at
      })),
      baseBranch
    };
  }

  async createDraftPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<string> {
    const { data } = await this.octokit.pulls.create({
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: true
    });

    return data.html_url;
  }

  async updatePullRequest(input: {
    owner: string;
    repo: string;
    pullNumber: number;
    title?: string;
    body?: string;
    state?: "open" | "closed";
  }): Promise<string> {
    const { data } = await this.octokit.pulls.update({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      title: input.title,
      body: input.body,
      state: input.state
    });

    return data.html_url;
  }

  async createIssueComment(input: { owner: string; repo: string; issueNumber: number; body: string }): Promise<string> {
    const { data } = await this.octokit.issues.createComment({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.issueNumber,
      body: input.body
    });

    return data.html_url;
  }

  async closeIssue(input: { owner: string; repo: string; issueNumber: number; stateReason?: "completed" | "not_planned" }): Promise<string> {
    const { data } = await this.octokit.issues.update({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.issueNumber,
      state: "closed",
      state_reason: input.stateReason
    });

    return data.html_url;
  }
}

export function createGitHubRemoteUrl(owner: string, repo: string, token?: string): string {
  if (!token) {
    return `https://github.com/${owner}/${repo}.git`;
  }

  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

export function redactRemoteUrl(remoteUrl: string): string {
  return remoteUrl.replace(/x-access-token:[^@]+@/, "x-access-token:***@");
}
