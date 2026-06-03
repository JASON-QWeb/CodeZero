import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import type { IssueContext } from "@agent/shared";

export type GitHubAppConfig = {
  appId?: string;
  installationId?: string;
  privateKey?: string;
  privateKeyPath?: string;
};

export type GitHubClientConfig = {
  token?: string;
  app?: GitHubAppConfig;
};

export type GitHubApiClient = Pick<Octokit, "issues" | "pulls">;

export type GitHubIssueCommentSource = "issue_comment" | "review" | "review_comment";

export type GitHubIssueComment = {
  id?: string;
  source: GitHubIssueCommentSource;
  author: string;
  body: string;
  createdAt: string;
  url?: string;
};

export type GitHubIssueThread = IssueContext & {
  author: string;
  updatedAt: string;
  isPullRequest: boolean;
};

export class GitHubClient {
  private readonly auth: GitHubAuthResolver;
  private readonly injectedOctokit?: GitHubApiClient;
  private octokitCache?: { token: string; octokit: GitHubApiClient };

  constructor(config: GitHubClientConfig, octokit?: GitHubApiClient) {
    this.auth = new GitHubAuthResolver(config);
    this.injectedOctokit = octokit;
  }

  async getAccessToken(): Promise<string | undefined> {
    return this.auth.getToken();
  }

  async getIssue(owner: string, repo: string, issueNumber: number, baseBranch = "main"): Promise<IssueContext> {
    const octokit = await this.octokit();
    const [{ data: issue }, comments] = await Promise.all([
      octokit.issues.get({ owner, repo, issue_number: issueNumber }),
      this.listIssueComments(owner, repo, issueNumber)
    ]);

    return {
      provider: "github",
      owner,
      repo,
      number: issueNumber,
      url: issue.html_url,
      title: issue.title,
      body: issue.body ?? "",
      labels: normalizeLabels(issue.labels),
      comments: comments.map(({ author, body, createdAt }) => ({ author, body, createdAt })),
      baseBranch
    };
  }

  async listOpenIssueThreads(
    owner: string,
    repo: string,
    options: { baseBranch?: string; perPage?: number } = {}
  ): Promise<GitHubIssueThread[]> {
    const issues = await this.listOpenIssues(owner, repo, options.perPage ?? 50);

    return Promise.all(
      issues
        .filter((issue) => !issue.pull_request)
        .map(async (issue) => {
          const comments = await this.listIssueComments(owner, repo, issue.number);

          return {
            provider: "github",
            owner,
            repo,
            number: issue.number,
            url: issue.html_url,
            title: issue.title,
            body: issue.body ?? "",
            labels: normalizeLabels(issue.labels),
            comments: comments.map(({ author, body, createdAt }) => ({ author, body, createdAt })),
            baseBranch: options.baseBranch ?? "main",
            author: issue.user?.login ?? "unknown",
            updatedAt: issue.updated_at,
            isPullRequest: Boolean(issue.pull_request)
          };
        })
    );
  }

  async listIssueComments(owner: string, repo: string, issueNumber: number): Promise<GitHubIssueComment[]> {
    const comments = await this.listPaginated(async (page, perPage) => {
      const octokit = await this.octokit();
      const { data } = await octokit.issues.listComments({ owner, repo, issue_number: issueNumber, per_page: perPage, page });
      return data;
    });

    return comments.map((comment) => ({
      id: `issue_comment-${comment.id}`,
      source: "issue_comment",
      author: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      url: comment.html_url
    }));
  }

  async listPullRequestFeedback(owner: string, repo: string, pullNumber: number): Promise<GitHubIssueComment[]> {
    const [conversationComments, reviewComments, reviews] = await Promise.all([
      this.listIssueComments(owner, repo, pullNumber),
      this.listPaginated(async (page, perPage) => {
        const octokit = await this.octokit();
        const { data } = await octokit.pulls.listReviewComments({
          owner,
          repo,
          pull_number: pullNumber,
          per_page: perPage,
          page
        });
        return data;
      }),
      this.listPaginated(async (page, perPage) => {
        const octokit = await this.octokit();
        const { data } = await octokit.pulls.listReviews({
          owner,
          repo,
          pull_number: pullNumber,
          per_page: perPage,
          page
        });
        return data;
      })
    ]);

    const inlineFeedback: GitHubIssueComment[] = reviewComments.map((comment) => ({
      id: `review_comment-${comment.id}`,
      source: "review_comment",
      author: comment.user?.login ?? "unknown",
      body: formatInlineReviewComment(comment.path, comment.line ?? comment.original_line, comment.body ?? ""),
      createdAt: comment.created_at,
      url: comment.html_url
    }));
    const reviewFeedback: GitHubIssueComment[] = reviews
      .filter((review) => Boolean(review.body?.trim()))
      .map((review) => ({
        id: `review-${review.id}`,
        source: "review",
        author: review.user?.login ?? "unknown",
        body: formatPullRequestReview(review.state, review.body ?? ""),
        createdAt: review.submitted_at ?? new Date(0).toISOString(),
        url: review.html_url
      }));

    return [...conversationComments, ...reviewFeedback, ...inlineFeedback].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createDraftPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<string> {
    const octokit = await this.octokit();
    const { data } = await octokit.pulls.create({
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
    const octokit = await this.octokit();
    const { data } = await octokit.pulls.update({
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
    const octokit = await this.octokit();
    const { data } = await octokit.issues.createComment({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.issueNumber,
      body: input.body
    });

    return data.html_url;
  }

  async createIssue(input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels?: string[];
    baseBranch?: string;
  }): Promise<IssueContext> {
    const octokit = await this.octokit();
    const { data } = await octokit.issues.create({
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      body: input.body,
      labels: input.labels
    });

    return {
      provider: "github",
      owner: input.owner,
      repo: input.repo,
      number: data.number,
      url: data.html_url,
      title: data.title,
      body: data.body ?? "",
      labels: normalizeLabels(data.labels),
      comments: [],
      baseBranch: input.baseBranch ?? "main"
    };
  }

  async closeIssue(input: { owner: string; repo: string; issueNumber: number; stateReason?: "completed" | "not_planned" }): Promise<string> {
    const octokit = await this.octokit();
    const { data } = await octokit.issues.update({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.issueNumber,
      state: "closed",
      state_reason: input.stateReason
    });

    return data.html_url;
  }

  private async listOpenIssues(owner: string, repo: string, limit: number): Promise<Awaited<ReturnType<GitHubApiClient["issues"]["listForRepo"]>>["data"]> {
    const issues: Awaited<ReturnType<GitHubApiClient["issues"]["listForRepo"]>>["data"] = [];
    let page = 1;

    while (issues.length < limit) {
      const perPage = Math.min(100, limit - issues.length);
      const octokit = await this.octokit();
      const { data } = await octokit.issues.listForRepo({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: perPage,
        page
      });
      issues.push(...data);

      if (data.length < perPage) {
        break;
      }

      page += 1;
    }

    return issues;
  }

  private async listPaginated<T>(fetchPage: (page: number, perPage: number) => Promise<T[]>): Promise<T[]> {
    const entries: T[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const data = await fetchPage(page, perPage);
      entries.push(...data);

      if (data.length < perPage) {
        return entries;
      }

      page += 1;
    }
  }

  private async octokit(): Promise<GitHubApiClient> {
    if (this.injectedOctokit) {
      return this.injectedOctokit;
    }

    const token = await this.auth.getToken();

    if (!token) {
      throw new Error(gitHubAuthRequiredMessage);
    }

    if (!this.octokitCache || this.octokitCache.token !== token) {
      this.octokitCache = { token, octokit: new Octokit({ auth: token }) };
    }

    return this.octokitCache.octokit;
  }
}

export const gitHubAuthRequiredMessage = "GITHUB_TOKEN or GitHub App credentials are required";

export function hasGitHubAuthConfig(config: GitHubClientConfig): boolean {
  return Boolean(isCompleteGitHubAppConfig(config.app) || config.token);
}

export async function getGitHubAuthToken(config: GitHubClientConfig): Promise<string | undefined> {
  return new GitHubAuthResolver(config).getToken();
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

class GitHubAuthResolver {
  private appTokenCache?: { token: string; expiresAtMs: number };

  constructor(private readonly config: GitHubClientConfig) {}

  async getToken(): Promise<string | undefined> {
    if (isCompleteGitHubAppConfig(this.config.app)) {
      return this.getInstallationToken(this.config.app);
    }

    return this.config.token;
  }

  private async getInstallationToken(app: CompleteGitHubAppConfig): Promise<string> {
    const now = Date.now();
    if (this.appTokenCache && this.appTokenCache.expiresAtMs - now > 60_000) {
      return this.appTokenCache.token;
    }

    const jwt = await createGitHubAppJwt(app);
    const octokit = new Octokit({ auth: jwt });
    const { data } = await octokit.request("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: Number(app.installationId)
    });
    const expiresAtMs = Date.parse(data.expires_at ?? "") || now + 50 * 60_000;
    this.appTokenCache = { token: data.token, expiresAtMs };
    return data.token;
  }
}

type CompleteGitHubAppConfig = Required<Pick<GitHubAppConfig, "appId" | "installationId">> &
  (Required<Pick<GitHubAppConfig, "privateKey">> | Required<Pick<GitHubAppConfig, "privateKeyPath">>);

function isCompleteGitHubAppConfig(app: GitHubAppConfig | undefined): app is CompleteGitHubAppConfig {
  return Boolean(app?.appId && app.installationId && (app.privateKey || app.privateKeyPath));
}

async function createGitHubAppJwt(app: CompleteGitHubAppConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: app.appId
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(await readPrivateKey(app));
  return `${unsigned}.${base64Url(signature)}`;
}

async function readPrivateKey(app: CompleteGitHubAppConfig): Promise<string> {
  if ("privateKeyPath" in app && app.privateKeyPath) {
    return readFile(app.privateKeyPath, "utf8");
  }

  if ("privateKey" in app && app.privateKey) {
    return normalizePrivateKey(app.privateKey);
  }

  throw new Error("GitHub App private key is required");
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizeLabels(labels: Array<string | { name?: string | null }>): string[] {
  return labels.map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean);
}

function formatInlineReviewComment(path: string, line: number | null | undefined, body: string): string {
  const location = line ? `${path}:${line}` : path;
  return `Inline review on ${location}\n\n${body}`;
}

function formatPullRequestReview(state: string | undefined, body: string): string {
  return `Pull request review${state ? ` (${state})` : ""}\n\n${body}`;
}
