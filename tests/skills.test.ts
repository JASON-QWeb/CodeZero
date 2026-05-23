import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkillsFromDirectory } from "@agent/skills";

describe("skills loader", () => {
  it("loads sorted skills and extracts versions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-skills-"));
    await mkdir(path.join(dir, "zeta"), { recursive: true });
    await mkdir(path.join(dir, "alpha"), { recursive: true });
    await writeFile(path.join(dir, "zeta", "SKILL.md"), "version: 2.0.0\n\nZeta skill\n");
    await writeFile(path.join(dir, "alpha", "SKILL.md"), "Alpha skill without version\n");

    const skills = await loadSkillsFromDirectory(dir, "project");

    expect(skills.map((skill) => skill.id)).toEqual(["alpha", "zeta"]);
    expect(skills[0]?.version).toBe("0.1.0");
    expect(skills[1]?.version).toBe("2.0.0");
  });

  it("returns an empty list for missing directories or empty skill folders", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-skills-empty-"));
    await mkdir(path.join(dir, "missing-md"), { recursive: true });

    await expect(loadSkillsFromDirectory(path.join(dir, "does-not-exist"), "platform")).resolves.toEqual([]);
    await expect(loadSkillsFromDirectory(dir, "platform")).resolves.toEqual([]);
  });
});
