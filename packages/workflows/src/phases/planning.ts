import {
  runJsonAgent,
  type AgentDefinition,
  type AgentRunner,
} from "@agent/model-runtime";
import type { RepositoryConfig } from "@agent/config";
import { gitHubAuthRequiredMessage } from "@agent/github";
import { loadPlatformSkills } from "@agent/skills";
import type { JsonObject, PlanningDocument, Task } from "@agent/shared";
import {
  createPrdIssueComment,
  detectIssueLocale,
  languageInstruction,
} from "../pr-local-verification.js";
import { planningDocumentSchema } from "../schemas.js";
import { githubClient, hasGitHubAuth } from "./github-utils.js";
import type { WorkflowServices } from "./types.js";

export async function draftPlanningDocument(
  host: WorkflowServices,
  task: Task,
  repositoryConfig: RepositoryConfig,
  runner: AgentRunner,
  agent: AgentDefinition,
): Promise<PlanningDocument> {
  await host.updateStatus(task.id, "BRAINSTORMING");
  const platformSkills = await loadPlatformSkills(host.config.rootDir);
  const locale = detectIssueLocale(task.issue);
  const result = await runJsonAgent({
    runner,
    agent,
    userPrompt: [
      "Generate one CodeZero planning document JSON. It must include the PRD fields and implementationPlan in the same JSON object. Return only JSON matching the required schema.",
      languageInstruction(locale),
    ].join("\n"),
    context: {
      issue: task.issue as unknown as JsonObject,
      platformSkills: platformSkills.map((skill) => ({
        id: skill.id,
        content: skill.content,
      })),
      contextPack: task.contextPack as unknown as JsonObject,
      projectRulesAndSkills: task.contextPack?.businessRules ?? [],
      codeGraphContext: task.contextPack?.codeGraphContext ?? null,
      repository: {
        owner: repositoryConfig.github_owner,
        repo: repositoryConfig.github_repo,
        defaultBranch: repositoryConfig.default_branch,
        projectSkillPath: repositoryConfig.project_skill_path,
        projectRulePath: repositoryConfig.project_rule_path,
      },
    },
  });
  const planningDocument = planningDocumentSchema.parse(result);
  await host.writeArtifact(
    task.id,
    "prd",
    "planning-document.json",
    JSON.stringify(planningDocument, null, 2),
  );
  await host.event(
    task.id,
    "PRD_DRAFTED",
    `Planning document drafted with complexity ${planningDocument.complexity.score}`,
  );
  return planningDocument;
}

export async function publishPrdIssueComment(
  host: WorkflowServices,
  task: Task,
  repositoryConfig: RepositoryConfig,
  planningDocument: PlanningDocument,
  requiresHumanReview: boolean,
): Promise<void> {
  if (!hasGitHubAuth(host)) {
    await host.event(
      task.id,
      "PRD_DRAFTED",
      `PRD issue comment skipped because ${gitHubAuthRequiredMessage}`,
      "warn",
    );
    return;
  }

  const github = githubClient(host);
  const locale = detectIssueLocale(task.issue);
  const body = createPrdIssueComment({
    task,
    planningDocument,
    requiresHumanReview,
    mention: repositoryConfig.trigger.mention,
    locale,
  });
  const url = await github.createIssueComment({
    owner: repositoryConfig.github_owner,
    repo: repositoryConfig.github_repo,
    issueNumber: task.issue.number,
    body,
  });
  await host.event(
    task.id,
    "PRD_DRAFTED",
    "PRD commented on GitHub issue",
    "info",
    {
      commentUrl: url,
      requiresHumanReview,
    },
  );
}
