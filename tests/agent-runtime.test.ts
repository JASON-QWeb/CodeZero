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

  it("repairs raw control characters inside JSON strings", () => {
    const response = `{"summary":"repair","unifiedDiff":"diff --git a/a b/a
@@ -1 +1 @@
-old
+new"}`;

    expect(parseJsonObject(response)).toEqual({
      summary: "repair",
      unifiedDiff: "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new"
    });
  });

  it("repairs common trailing commas in JSON-like agent responses", () => {
    expect(parseJsonObject('{"summary":"ok","actions":[{"tool":"repo.write_file","input":{"path":"src/a.ts","content":"a,b",},}],}')).toEqual({
      summary: "ok",
      actions: [
        {
          tool: "repo.write_file",
          input: {
            path: "src/a.ts",
            content: "a,b"
          }
        }
      ]
    });
  });

  it("repairs comments outside strings in JSON-like agent responses", () => {
    const response = `{
      // implementation summary
      "summary": "ok // keep string content",
      "actions": [
        {"tool": "repo.write_file", /* inline comment */ "input": {"path": "src/a.ts", "content": "x"}}
      ],
    }`;

    expect(parseJsonObject(response)).toEqual({
      summary: "ok // keep string content",
      actions: [
        {
          tool: "repo.write_file",
          input: {
            path: "src/a.ts",
            content: "x"
          }
        }
      ]
    });
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

  it("surfaces provider timeouts with model context", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    const provider = new OpenAICompatibleProvider({
      id: "test-provider",
      baseUrl: "https://models.example.test",
      apiKey: "secret",
      model: "test-model",
      supportsTools: true,
      supportsStructuredOutput: true,
      timeoutMs: 123_000
    });

    await expect(provider.generate({ messages: [] })).rejects.toThrow("Provider test-provider timed out after 123000ms while calling model test-model");
  });

  it("retries transient provider network failures once", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "{\"summary\":\"retried\"}" } }]
        })
      });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      id: "test-provider",
      baseUrl: "https://models.example.test",
      apiKey: "secret",
      model: "test-model",
      supportsTools: true,
      supportsStructuredOutput: true
    });

    await expect(provider.generate({ messages: [] })).resolves.toMatchObject({ content: "{\"summary\":\"retried\"}" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
