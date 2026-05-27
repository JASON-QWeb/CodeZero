import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectContext, summarizeProjectContext } from "@agent/project-context";

describe("project context", () => {
  it("loads .agent project docs, testing guide, and project skills", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-project-context-"));
    await mkdir(path.join(repoDir, ".agent", "skills", "refunds"), { recursive: true });
    await writeFile(path.join(repoDir, ".agent", "project.md"), "# Shop\n");
    await writeFile(path.join(repoDir, ".agent", "testing-guide.md"), "pnpm test\n");
    await writeFile(path.join(repoDir, ".agent", "skills", "refunds", "SKILL.md"), "version: \"1.2.3\"\n\nRefund rules\n");

    const context = await loadProjectContext(repoDir);
    const summary = summarizeProjectContext(context);

    expect(context.projectDocument).toContain("# Shop");
    expect(context.testingGuide).toContain("pnpm test");
    expect(context.businessSkills[0]?.id).toBe("refunds");
    expect(summary).toContain("refunds@1.2.3");
  });

  it("uses configured project skill paths when loading repository context", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-project-context-custom-"));
    await mkdir(path.join(repoDir, "ops-agent", "skills", "booking"), { recursive: true });
    await writeFile(path.join(repoDir, "ops-agent", "project.md"), "# Booking\n");
    await writeFile(path.join(repoDir, "ops-agent", "testing-guide.md"), "go test ./...\n");
    await writeFile(path.join(repoDir, "ops-agent", "skills", "booking", "SKILL.md"), "version: \"2.0.0\"\n\nBooking rules\n");

    const context = await loadProjectContext(repoDir, "ops-agent");

    expect(context.projectDocument).toContain("# Booking");
    expect(context.testingGuide).toContain("go test ./...");
    expect(context.businessSkills[0]?.id).toBe("booking");
  });

  it("summarizes missing project context with explicit fallback text", async () => {
    const context = await loadProjectContext(await mkdtemp(path.join(os.tmpdir(), "agent-project-context-empty-")));

    expect(summarizeProjectContext(context)).toContain("No .agent/project.md found.");
    expect(summarizeProjectContext(context)).toContain("No project business skills found.");
  });
});
