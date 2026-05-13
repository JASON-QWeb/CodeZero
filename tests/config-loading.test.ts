import { describe, expect, it } from "vitest";
import { loadAppConfig } from "@agent/config";

describe("app config loading", () => {
  it("loads repository, tool, and policy configuration from examples", async () => {
    const config = await loadAppConfig(process.cwd());

    expect(config.repositories[0]?.trigger.mode).toBe("mention");
    expect(config.tools.map((tool) => tool.name)).toContain("repo.apply_patch");
    expect(config.policies.map((policy) => policy.id)).toContain("block-dangerous-shell");
    expect(config.memory.filePath).toContain("memory.json");
  });
});
