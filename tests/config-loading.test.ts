import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfigSection, readConfigSection, writeConfigSection, loadAppConfig } from "@agent/config";

describe("app config loading", () => {
  it("loads repository, tool, and policy configuration from examples", async () => {
    const config = await loadAppConfig(process.cwd());

    expect(config.repositories[0]?.trigger.mode).toBe("mention");
    expect(config.repositories[0]?.permissions.blocked_permissions).toContain("dangerous");
    expect(config.tools.map((tool) => tool.name)).toContain("repo.apply_patch");
    expect(config.policies.map((policy) => policy.id)).toContain("block-dangerous-shell");
    expect(config.memory.filePath).toContain("memory.json");
  });

  it("validates and writes editable config sections", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-config-"));
    const content = [
      "providers:",
      "  simple:",
      "    type: openai-compatible",
      "    base_url: https://api.deepseek.com",
      "    api_key_env: DEEPSEEK_API_KEY",
      "    model: deepseek-chat",
      "agents:",
      "  prd:",
      "    provider: simple",
      "    system_prompt: prompts/system/prd-agent.md",
      "    skills:",
      "      - draft-prd",
      ""
    ].join("\n");

    const saved = await writeConfigSection(dir, "agents", content);
    const reloaded = await readConfigSection(dir, "agents");

    expect(saved.exists).toBe(true);
    expect(reloaded.content).toContain("deepseek-chat");
    expect(parseConfigSection("agents", content)).toMatchObject({
      providers: {
        simple: {
          model: "deepseek-chat"
        }
      }
    });
    expect(() => parseConfigSection("agents", "providers: []")).toThrow();
  });
});
