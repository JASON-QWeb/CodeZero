import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectSkills, type Skill } from "@agent/skills";

export type ProjectContext = {
  projectDocument: string;
  projectRules: Array<{ path: string; content: string }>;
  businessSkills: Skill[];
  testingGuide: string;
};

export async function loadProjectContext(
  repoDir: string,
  projectSkillPath = ".agent",
  projectRulePath = path.join(projectSkillPath, "rules"),
): Promise<ProjectContext> {
  const agentDir = path.join(repoDir, projectSkillPath);
  const [projectDocument, projectRules, testingGuide, businessSkills] =
    await Promise.all([
      readFile(path.join(agentDir, "project.md"), "utf8").catch(() => ""),
      loadProjectRules(repoDir, projectRulePath),
      readFile(path.join(agentDir, "testing-guide.md"), "utf8").catch(() => ""),
      loadProjectSkills(repoDir, path.join(projectSkillPath, "skills")),
    ]);

  return {
    projectDocument,
    projectRules,
    businessSkills,
    testingGuide,
  };
}

export function summarizeProjectContext(context: ProjectContext): string {
  const skillList = context.businessSkills
    .map((skill) =>
      [
        `## Skill: ${skill.id}@${skill.version}`,
        trimForContext(skill.content, 4_000),
      ].join("\n"),
    )
    .join("\n\n");

  return [
    "# Project Context",
    context.projectDocument || "No .agent/project.md found.",
    "",
    "# Business Skills",
    skillList || "No project business skills found.",
    "",
    "# Project Rules",
    summarizeProjectRules(context.projectRules),
    "",
    "# Testing Guide",
    context.testingGuide || "No .agent/testing-guide.md found.",
  ].join("\n");
}

async function loadProjectRules(
  repoDir: string,
  projectRulePath: string,
): Promise<Array<{ path: string; content: string }>> {
  const ruleDir = path.join(repoDir, projectRulePath);
  const entries = await readdir(ruleDir, { withFileTypes: true }).catch(
    () => [],
  );
  const files = entries
    .filter(
      (entry) => entry.isFile() && /\.(md|mdx|txt|ya?ml)$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    files.map(async (file) => ({
      path: path.join(projectRulePath, file),
      content: await readFile(path.join(ruleDir, file), "utf8"),
    })),
  );
}

function summarizeProjectRules(
  rules: Array<{ path: string; content: string }>,
): string {
  if (rules.length === 0) {
    return "No project rules found.";
  }

  return rules
    .map((rule) =>
      [`## Rule: ${rule.path}`, trimForContext(rule.content, 4_000)].join("\n"),
    )
    .join("\n\n");
}

function trimForContext(content: string, maxChars: number): string {
  return content.length > maxChars
    ? `${content.slice(0, maxChars)}\n... (truncated)`
    : content;
}
