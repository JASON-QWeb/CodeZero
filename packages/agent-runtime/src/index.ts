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
    const timeoutMs = this.config.timeoutMs ?? 120_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const maxAttempts = 2;
    const body = JSON.stringify({
      model: this.config.model,
      messages: request.messages,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      response_format: request.responseFormat,
      metadata: request.metadata
    });

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${this.config.apiKey}`,
              "content-type": "application/json"
            },
            body
          });

          if (!response.ok) {
            const responseBody = await response.text();
            throw new Error(`Provider ${this.id} failed with ${response.status}: ${responseBody}`);
          }

          const rawUnknown = (await response.json()) as unknown;
          const raw = asJsonValue(rawUnknown);
          const chatResponse = rawUnknown as OpenAiChatResponse;
          const content = chatResponse.choices?.[0]?.message?.content ?? "";

          return { content, raw };
        } catch (error) {
          if (isObject(error) && error.name === "AbortError") {
            throw new Error(`Provider ${this.id} timed out after ${timeoutMs}ms while calling model ${this.config.model}`);
          }

          if (attempt < maxAttempts && isTransientFetchError(error)) {
            await yieldToEventLoop();
            continue;
          }

          if (isTransientFetchError(error)) {
            throw new Error(`Provider ${this.id} network request failed after ${maxAttempts} attempts while calling model ${this.config.model}: ${errorMessage(error)}`);
          }

          throw error;
        }
      }

      throw new Error(`Provider ${this.id} did not return a response`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isTransientFetchError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  const code = errorCode(error);
  return message.includes("fetch failed") || message.includes("network") || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = isObject(error.cause) && typeof error.cause.message === "string" ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  if (isObject(error) && typeof error.code === "string") {
    return error.code;
  }

  if (error instanceof Error && isObject(error.cause) && typeof error.cause.code === "string") {
    return error.cause.code;
  }

  return undefined;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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
  let lastError: unknown;

  for (const parseCandidate of jsonParseCandidates(candidate)) {
    try {
      parsed = JSON.parse(parseCandidate) as unknown;
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  if (!isObject(parsed) || Array.isArray(parsed)) {
    throw new Error("Agent response was not a JSON object");
  }

  return asJsonValue(parsed) as JsonObject;
}

function jsonParseCandidates(candidate: string): string[] {
  const candidates: string[] = [];
  const push = (value: string) => {
    if (!candidates.includes(value)) {
      candidates.push(value);
    }
  };

  push(candidate);
  const escaped = escapeControlCharactersInJsonStrings(candidate);
  push(escaped);
  push(stripTrailingCommasOutsideStrings(escaped));
  const withoutComments = stripJsonCommentsOutsideStrings(escaped);
  push(withoutComments);
  push(stripTrailingCommasOutsideStrings(withoutComments));

  return candidates;
}

function stripTrailingCommasOutsideStrings(content: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (!inString && char === ",") {
      let cursor = index + 1;
      while (cursor < content.length && /\s/.test(content[cursor] ?? "")) {
        cursor += 1;
      }
      if (content[cursor] === "}" || content[cursor] === "]") {
        continue;
      }
    }

    repaired += char;

    if (!inString) {
      if (char === "\"") {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = false;
    }
  }

  return repaired;
}

function stripJsonCommentsOutsideStrings(content: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (!inString && char === "/" && next === "/") {
      index += 2;
      while (index < content.length && content[index] !== "\n") {
        index += 1;
      }
      if (content[index] === "\n") {
        repaired += "\n";
      }
      continue;
    }

    if (!inString && char === "/" && next === "*") {
      index += 2;
      while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    repaired += char;

    if (!inString) {
      if (char === "\"") {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = false;
    }
  }

  return repaired;
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

  try {
    return parseJsonObject(result.content);
  } catch (error) {
    const repairResult = await input.runner.run({
      agent: input.agent,
      userPrompt: [
        input.userPrompt,
        "",
        "The previous response was invalid JSON and could not be parsed.",
        `Parser error: ${error instanceof Error ? error.message : String(error)}`,
        "Convert the previous response into one strict JSON object that matches the requested schema.",
        "Return only valid JSON. Do not include markdown, comments, prose, or trailing commas.",
        "",
        "Previous response:",
        result.content
      ].join("\n"),
      context: input.context
    });

    return parseJsonObject(repairResult.content);
  }
}
