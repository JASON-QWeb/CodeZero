import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContextPack, buildNavigationRoute, buildRepoNavigationGraph, indexFiles, indexSymbols } from "@agent/codebase-intelligence";
import type { IssueContext } from "@agent/shared";

const issue: IssueContext = {
  provider: "github",
  owner: "acme",
  repo: "shop",
  number: 7,
  url: "https://github.com/acme/shop/issues/7",
  title: "Refund status wrong on order detail page",
  body: "The refund status copy on the order detail page should match the refund service state.",
  labels: ["frontend"],
  comments: [],
  baseBranch: "main"
};

describe("repo navigation graph", () => {
  it("builds graph routes that guide ContextPack file selection", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-repo-"));
    await mkdir(path.join(repoDir, "app/orders/[id]"), { recursive: true });
    await mkdir(path.join(repoDir, "src/billing"), { recursive: true });

    await writeFile(
      path.join(repoDir, "app/orders/[id]/page.tsx"),
      [
        'import { refundStatusCopy } from "../../../src/billing/refund-status";',
        "",
        "export function OrderDetailPage() {",
        "  return refundStatusCopy('pending');",
        "}"
      ].join("\n")
    );
    await writeFile(path.join(repoDir, "src/billing/refund-status.ts"), "export function refundStatusCopy(status: string) { return status; }\n");
    await writeFile(path.join(repoDir, "src/billing/refund-status.test.ts"), "import { refundStatusCopy } from './refund-status';\n");

    const files = await indexFiles(repoDir);
    const symbols = await indexSymbols(repoDir, files);
    const graph = await buildRepoNavigationGraph({
      repoDir,
      files,
      symbols,
      businessRules: ["Refund status belongs to billing refund service."],
      includeGitHistory: false
    });
    const route = buildNavigationRoute({ taskId: "task-7", issue, graph, files, symbols });
    const contextPack = await buildContextPack({
      taskId: "task-7",
      issue,
      repoDir,
      files,
      symbols,
      businessRules: ["Refund status belongs to billing refund service."],
      codeGraphContext: {
        relatedFiles: ["src/billing/refund-status.ts"],
        summary: "CodeGraph selected refund status implementation."
      },
      navigationRoute: route
    });

    expect(graph.edges.some((edge) => edge.kind === "imports" && edge.to === "file:src/billing/refund-status.ts")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "tests" && edge.to === "file:src/billing/refund-status.test.ts")).toBe(true);
    expect(route.entrypoints).toContain("/orders/:id");
    expect(route.mustRead).toContain("src/billing/refund-status.ts");
    expect(route.tests).toContain("src/billing/refund-status.test.ts");
    expect(contextPack.relevantFiles.map((file) => file.path)).toContain("src/billing/refund-status.ts");
    expect(contextPack.codeGraphContext?.summary).toBe("CodeGraph selected refund status implementation.");
    expect(contextPack.relevantFiles.find((file) => file.path === "src/billing/refund-status.ts")?.evidence).toContainEqual(
      expect.objectContaining({ kind: "graph", summary: "Selected by CodeGraph task context" })
    );
  });
});
