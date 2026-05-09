import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type Skill = {
  id: string;
  scope: "platform" | "project";
  version: string;
  path: string;
  content: string;
};

export async function loadSkillsFromDirectory(directory: string, scope: Skill["scope"]): Promise<Skill[]> {
  const dirents = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const skillPath = path.join(directory, dirent.name, "SKILL.md");
    const content = await readFile(skillPath, "utf8").catch(() => "");

    if (!content) {
      continue;
    }

    skills.push({
      id: dirent.name,
      scope,
      version: extractVersion(content) ?? "0.1.0",
      path: skillPath,
      content
    });
  }

  return skills.sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadPlatformSkills(projectRoot: string): Promise<Skill[]> {
  return loadSkillsFromDirectory(path.join(projectRoot, "packages", "skills", "platform"), "platform");
}

export async function loadProjectSkills(repoDir: string, projectSkillPath = ".agent/skills"): Promise<Skill[]> {
  return loadSkillsFromDirectory(path.join(repoDir, projectSkillPath), "project");
}

function extractVersion(content: string): string | undefined {
  const match = content.match(/^version:\s*"?([^"\n]+)"?/m);
  return match?.[1]?.trim();
}

