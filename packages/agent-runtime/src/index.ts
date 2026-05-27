import type { AgentRole, JsonObject, JsonValue } from "@agent/shared";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type ModelProviderConfig = {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  timeoutMs?: number;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type GenerateRequest = {
  messages: ChatMessage[];
  responseFormat?: JsonObject;
  metadata?: JsonObject;
};

export type GenerateResult = {
  content: string;
  raw: JsonValue;
};

export type ModelProvider = {
  readonly id: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
};

type OpenAiChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(asJsonValue);
  }

  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]));
  }

  return String(value);
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;

  constructor(private readonly config: ModelProviderConfig) {
    this.id = config.id;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 120_000);

    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
          response_format: request.responseFormat,
          metadata: request.metadata
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Provider ${this.id} failed with ${response.status}: ${body}`);
      }

      const rawUnknown = (await response.json()) as unknown;
      const raw = asJsonValue(rawUnknown);
      const chatResponse = rawUnknown as OpenAiChatResponse;
      const content = chatResponse.choices?.[0]?.message?.content ?? "";

      return { content, raw };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type AgentDefinition = {
  id: string;
  role: AgentRole;
  providerId: string;
  systemPrompt: string;
  skillRefs: string[];
  tools: string[];
  guardrails: string[];
};

export type AgentRunInput = {
  agent: AgentDefinition;
  userPrompt: string;
  context: JsonObject;
};

export class AgentRunner {
  constructor(private readonly providers: Map<string, ModelProvider>) {}

  async run(input: AgentRunInput): Promise<GenerateResult> {
    const provider = this.providers.get(input.agent.providerId);

    if (!provider) {
      throw new Error(`Missing provider: ${input.agent.providerId}`);
    }

    return provider.generate({
      messages: [
        { role: "system", content: input.agent.systemPrompt },
        {
          role: "user",
          content: `${input.userPrompt}\n\nContext:\n${JSON.stringify(input.context, null, 2)}`
        }
      ],
      metadata: {
        agent_id: input.agent.id,
        agent_role: input.agent.role
      }
    });
  }
}

export function parseJsonObject(content: string): JsonObject {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  let parsed: unknown;

  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (error) {
    const repaired = escapeControlCharactersInJsonStrings(candidate);
    if (repaired === candidate) {
      throw error;
    }
    parsed = JSON.parse(repaired) as unknown;
  }

  if (!isObject(parsed) || Array.isArray(parsed)) {
    throw new Error("Agent response was not a JSON object");
  }

  return asJsonValue(parsed) as JsonObject;
}

function escapeControlCharactersInJsonStrings(content: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (const char of content) {
    if (!inString) {
      repaired += char;
      if (char === "\"") {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      repaired += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      repaired += char;
      inString = false;
      continue;
    }

    const code = char.charCodeAt(0);
    repaired += code < 0x20 ? escapeJsonControlCharacter(char, code) : char;
  }

  return repaired;
}

function escapeJsonControlCharacter(char: string, code: number): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${code.toString(16).padStart(4, "0")}`;
  }
}

export async function runJsonAgent(input: AgentRunInput & { runner: AgentRunner }): Promise<JsonObject> {
  const result = await input.runner.run(input);
  return parseJsonObject(result.content);
}
