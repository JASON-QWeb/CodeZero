import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, OpenAICompatibleProvider, parseJsonObject, runJsonAgent, type AgentDefinition } from "@agent/agent-runtime";

const agent: AgentDefinition = {
  id: "implementation",
  role: "main-implementation",
  providerId: "test-provider",
  systemPrompt: "You are a test agent.",
  skillRefs: [],
  tools: [],
  guardrails: []
};

describe("agent runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses raw and fenced JSON objects", () => {
    expect(parseJsonObject('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonObject("```json\n{\"name\":\"agent\"}\n```")).toEqual({ name: "agent" });
    expect(() => parseJsonObject("[1,2,3]")).toThrow("Agent response was not a JSON object");
  });

  it("calls OpenAI-compatible chat completions and extracts assistant content", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{\"summary\":\"done\"}" } }],
        usage: { total_tokens: 12 }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      id: "test-provider",
      baseUrl: "https://models.example.test/v1/",
      apiKey: "secret",
      model: "test-model",
      supportsTools: true,
      supportsStructuredOutput: true,
      timeoutMs: 5_000
    });
    const result = await provider.generate({
      messages: [{ role: "user", content: "Return JSON" }],
      responseFormat: { type: "json_object" }
    });

    expect(result.content).toBe("{\"summary\":\"done\"}");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" })
      })
    );
  });

  it("runs JSON agents through the selected provider", async () => {
    const runner = new AgentRunner(
      new Map([
        [
          "test-provider",
          {
            id: "test-provider",
            generate: vi.fn().mockResolvedValue({ content: "{\"files\":[\"src/a.ts\"]}", raw: {} })
          }
        ]
      ])
    );

    await expect(runJsonAgent({ runner, agent, userPrompt: "Plan", context: { issue: "demo" } })).resolves.toEqual({
      files: ["src/a.ts"]
    });
  });

  it("surfaces provider errors with response status and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => "rate limited"
      })
    );
    const provider = new OpenAICompatibleProvider({
      id: "test-provider",
      baseUrl: "https://models.example.test",
      apiKey: "secret",
      model: "test-model",
      supportsTools: true,
      supportsStructuredOutput: true
    });

    await expect(provider.generate({ messages: [] })).rejects.toThrow("Provider test-provider failed with 429: rate limited");
  });
});
