import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectSkills, type Skill } from "@agent/skills";

export type ProjectContext = {
  projectDocument: string;
  businessSkills: Skill[];
  testingGuide: string;
};

export async function loadProjectContext(repoDir: string, projectSkillPath = ".agent"): Promise<ProjectContext> {
  const agentDir = path.join(repoDir, projectSkillPath);
  const [projectDocument, testingGuide, businessSkills] = await Promise.all([
    readFile(path.join(agentDir, "project.md"), "utf8").catch(() => ""),
    readFile(path.join(agentDir, "testing-guide.md"), "utf8").catch(() => ""),
    loadProjectSkills(repoDir, path.join(projectSkillPath, "skills"))
  ]);

  return {
    projectDocument,
    businessSkills,
    testingGuide
  };
}

export function summarizeProjectContext(context: ProjectContext): string {
  const skillList = context.businessSkills
    .map((skill) => [`## Skill: ${skill.id}@${skill.version}`, trimForContext(skill.content, 4_000)].join("\n"))
    .join("\n\n");

  return [
    "# Project Context",
    context.projectDocument || "No .agent/project.md found.",
    "",
    "# Business Skills",
    skillList || "No project business skills found.",
    "",
    "# Testing Guide",
    context.testingGuide || "No .agent/testing-guide.md found."
  ].join("\n");
}

function trimForContext(content: string, maxChars: number): string {
  return content.length > maxChars ? `${content.slice(0, maxChars)}\n... (truncated)` : content;
}
