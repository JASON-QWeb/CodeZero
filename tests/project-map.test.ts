import { describe, expect, it } from "vitest";
import { proposeProjectMapUpdate } from "@agent/codebase-intelligence";

describe("project map updater", () => {
  it("proposes auditable change-pattern updates from completed work", () => {
    const update = proposeProjectMapUpdate({
      issueTitle: "Refund status copy",
      changedFiles: ["src/refunds/status.ts", "src/refunds/status.test.ts"],
      testCommands: ["pnpm test -- refunds"]
    });

    expect(update.title).toBe("Project map update for Refund status copy");
    expect(update.suggestedFiles).toHaveLength(1);
    expect(update.suggestedFiles[0]?.path).toBe(".agent/change-patterns.md");
    expect(update.suggestedFiles[0]?.content).toContain("- src/refunds/status.ts");
    expect(update.suggestedFiles[0]?.content).toContain("- pnpm test -- refunds");
  });
});
