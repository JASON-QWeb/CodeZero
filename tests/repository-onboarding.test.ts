import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepositoryOnboarding, writeRepositoryOnboarding } from "@agent/codebase-intelligence";

describe("repository onboarding", () => {
  it("generates project maps and configuration suggestions for a new repository", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-onboarding-"));
    await mkdir(path.join(repoDir, "src", "routes"), { recursive: true });
    await mkdir(path.join(repoDir, "src", "orders"), { recursive: true });
    await writeFile(path.join(repoDir, "pnpm-lock.yaml"), "");
    await writeFile(
      path.join(repoDir, "src", "routes", "orders.ts"),
      "import { getOrder } from '../orders/service';\nexport function registerOrdersRoute(app) { app.get('/orders/:id', getOrder); }\n"
    );
    await writeFile(path.join(repoDir, "src", "orders", "service.ts"), "export function getOrder() { return {}; }\n");
    await writeFile(path.join(repoDir, "src", "orders", "service.test.ts"), "import { getOrder } from './service';\n");

    const result = await createRepositoryOnboarding({
      repoDir,
      owner: "acme",
      repo: "shop",
      businessRules: ["Refund status must follow payment provider state."]
    });

    expect(result.summary.packageManager).toBe("pnpm");
    expect(result.summary.tests).toBe(1);
    expect(result.documents.map((document) => document.path)).toContain(".agent/project.md");
    expect(result.documents.find((document) => document.path === "config/repositories.suggested.yaml")?.content).toContain("mode: mention");

    await writeRepositoryOnboarding(result, repoDir);
    await expect(readFile(path.join(repoDir, ".agent", "testing-guide.md"), "utf8")).resolves.toContain("pnpm test");
  });
});
