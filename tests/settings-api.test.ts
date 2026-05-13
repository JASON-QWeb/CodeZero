import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";

describe("settings api", () => {
  afterEach(() => {
    delete process.env.PROJECT_ROOT;
  });

  it("returns editable config sections and validates YAML without writing", async () => {
    const app = await buildServer();

    const list = await app.inject({ method: "GET", url: "/settings/config" });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ sections: Array<{ section: string }> }>().sections.map((section) => section.section)).toContain("agents");

    const valid = await app.inject({
      method: "POST",
      url: "/settings/config/agents/validate",
      payload: {
        content: [
          "providers:",
          "  qwen:",
          "    type: openai-compatible",
          "    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1",
          "    api_key_env: QWEN_API_KEY",
          "    model: qwen3.5",
          "agents:",
          "  implementation:",
          "    provider: qwen",
          "    system_prompt: prompts/system/main-agent.md",
          "    skills:",
          "      - minimal-change-planner",
          ""
        ].join("\n")
      }
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json<{ valid: boolean }>().valid).toBe(true);

    const invalid = await app.inject({
      method: "POST",
      url: "/settings/config/repositories/validate",
      payload: { content: "repositories: bad" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ valid: boolean }>().valid).toBe(false);

    await app.close();
  });
});
