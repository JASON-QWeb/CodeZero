import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type { AppConfig } from "@agent/config";
import type { AgentRole, JsonObject, JsonValue } from "@agent/shared";
import { generateText, type LanguageModel } from "ai";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

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

export type AgentDefinition = {
  id: string;
  role: AgentRole;
  providerId: string;
  systemPrompt: string;
  skillRefs: string[];
};

export type AgentRunInput = {
  agent: AgentDefinition;
  userPrompt: string;
  context: JsonObject;
};

export type ModelProviderConfig = AppConfig["agents"]["providers"][string] & {
  id: string;
  apiKey: string;
};

export class AiSdkModelProvider implements ModelProvider {
  readonly id: string;
  private readonly model: LanguageModel;

  constructor(private readonly config: ModelProviderConfig) {
    this.id = config.id;
    this.model = createConfiguredLanguageModel(config);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const timeoutMs = this.config.timeout_ms ?? 120_000;
    const result = await runWithTransientRetry(
      (abortSignal) =>
        generateText({
          model: this.model,
          messages: request.messages.map((message) => ({
            role: message.role === "tool" ? "user" : message.role,
            content: message.content,
          })),
          temperature: this.config.temperature,
          maxOutputTokens: this.config.max_tokens,
          abortSignal,
        }),
      {
        maxRetries: this.config.max_retries ?? 2,
        timeoutMs,
        timeoutMessage: () =>
          new Error(
            `Provider ${this.id} timed out after ${timeoutMs}ms while calling model ${this.config.model}`,
          ),
      },
    );

    return {
      content: result.value.text,
      raw: asJsonValue({
        finishReason: result.value.finishReason,
        usage: result.value.usage,
        response: result.value.response,
        metadata: request.metadata,
        attempts: result.attempts,
      }),
    };
  }
}

function createConfiguredLanguageModel(
  config: ModelProviderConfig,
): LanguageModel {
  const providerOptions = {
    apiKey: config.apiKey,
    ...(config.base_url ? { baseURL: config.base_url } : {}),
  };
  const modelId = config.model as never;

  switch (config.type) {
    case "openai-compatible": {
      if (!config.base_url) {
        throw new Error(`Provider ${config.id} requires base_url`);
      }

      return createOpenAICompatible({
        name: config.id,
        baseURL: config.base_url,
        apiKey: config.apiKey,
      })(config.model);
    }
    case "anthropic":
      return createAnthropic(providerOptions)(modelId);
    case "google":
      return createGoogleGenerativeAI(providerOptions)(modelId);
    case "xai":
      return createXai(providerOptions)(modelId);
    case "mistral":
      return createMistral(providerOptions)(modelId);
    case "groq":
      return createGroq(providerOptions)(modelId);
  }
}

export async function runWithTransientRetry<T>(
  operation: (abortSignal: AbortSignal, attempt: number) => Promise<T>,
  options: {
    maxRetries?: number;
    timeoutMs: number;
    timeoutMessage: () => Error;
  },
): Promise<{ value: T; attempts: number }> {
  const maxAttempts = Math.max(1, (options.maxRetries ?? 2) + 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), options.timeoutMs);

    try {
      return {
        value: await operation(abortController.signal, attempt),
        attempts: attempt,
      };
    } catch (error) {
      lastError = isAbortError(error) ? options.timeoutMessage() : error;

      if (attempt >= maxAttempts || !isTransientModelError(lastError)) {
        throw lastError;
      }

      await delay(retryDelayMs(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

function isTransientModelError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  const status = errorStatus(error);
  const code = errorCode(error);

  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable")
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      isObject(error.cause) && typeof error.cause.message === "string"
        ? `: ${error.cause.message}`
        : "";
    return `${error.message}${cause}`;
  }

  return String(error);
}

function errorStatus(error: unknown): number | undefined {
  if (isObject(error) && typeof error.status === "number") {
    return error.status;
  }

  if (isObject(error) && typeof error.statusCode === "number") {
    return error.statusCode;
  }

  if (error instanceof Error && isObject(error.cause)) {
    return errorStatus(error.cause);
  }

  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (isObject(error) && typeof error.code === "string") {
    return error.code;
  }

  if (error instanceof Error && isObject(error.cause)) {
    return errorCode(error.cause);
  }

  return undefined;
}

function retryDelayMs(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** Math.max(0, attempt - 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
          content: `${input.userPrompt}\n\nContext:\n${JSON.stringify(input.context, null, 2)}`,
        },
      ],
      metadata: {
        agent_id: input.agent.id,
        agent_role: input.agent.role,
      },
    });
  }
}

export function createModelRuntimeProviders(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, ModelProvider> {
  return new Map(
    Object.entries(config.agents.providers).map(([id, provider]) => {
      const apiKey = env[provider.api_key_env] ?? "";

      if (!apiKey) {
        throw new Error(
          `${provider.api_key_env} is required for provider ${id}`,
        );
      }

      if (provider.model.includes("${") || provider.base_url?.includes("${")) {
        throw new Error(
          `Provider ${id} has unresolved environment placeholders`,
        );
      }

      return [
        id,
        new AiSdkModelProvider({
          ...provider,
          id,
          apiKey,
        }),
      ] as const;
    }),
  );
}

export function createModelRuntimeAgentRunner(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): AgentRunner {
  return new AgentRunner(createModelRuntimeProviders(config, env));
}

type AgentProviderConfig = AppConfig["agents"]["providers"][string];

export function buildOpenCodeProviderConfig(
  config: AppConfig,
  agent: AgentDefinition,
): JsonObject | undefined {
  const provider = config.agents.providers[agent.providerId];

  if (!provider) {
    return undefined;
  }

  return resolveCodingExecutorProvider(agent.providerId, provider).config;
}

export function resolveCodingExecutorProvider(
  providerId: string,
  provider: AgentProviderConfig,
): {
  mode: "auto" | "custom" | "native";
  providerId: string;
  modelRef: string;
  config?: JsonObject;
  env: NodeJS.ProcessEnv;
} {
  const executorProvider = provider.coding_executor;
  const requestedMode = executorProvider?.mode ?? "auto";
  const nativeProviderId = toNativeOpenCodeProviderId(provider.type);
  const mode =
    requestedMode === "auto" && nativeProviderId ? "native" : requestedMode;
  const model = executorProvider?.model ?? provider.model;
  const resolvedProviderId =
    executorProvider?.provider_id ??
    inferOpenCodeProviderId(mode, model) ??
    nativeProviderId ??
    "codezero";
  const modelKey = toOpenCodeProviderModelKey(resolvedProviderId, model);
  const modelRef = toOpenCodeModelRef(resolvedProviderId, modelKey);
  const env = executorProvider?.env ?? {};

  if (mode !== "native" && !provider.base_url) {
    throw new Error(
      `Provider ${providerId} requires base_url for OpenCode custom config`,
    );
  }

  if (
    mode === "native" &&
    !provider.base_url &&
    !shouldWriteNativeProviderConfig(executorProvider)
  ) {
    return { mode, providerId: resolvedProviderId, modelRef, env };
  }

  const providerOptions =
    mode === "native"
      ? toJsonObject({
          baseURL: provider.base_url,
          ...toJsonObject(executorProvider?.options ?? {}),
        })
      : toJsonObject({
          baseURL: provider.base_url ?? "",
          apiKey: "{env:OPENAI_API_KEY}",
          ...toJsonObject(executorProvider?.options ?? {}),
        });
  const modelOptions = {
    name: modelKey,
    ...toJsonObject(executorProvider?.model_options ?? {}),
  };
  const providerEntry: JsonObject = {
    ...(executorProvider?.npm || mode !== "native"
      ? { npm: executorProvider?.npm ?? "@ai-sdk/openai-compatible" }
      : {}),
    name: executorProvider?.name ?? "CodeZero Runtime Provider",
    ...(Object.keys(providerOptions).length > 0
      ? { options: providerOptions }
      : {}),
    models: {
      [modelKey]: modelOptions,
    },
  };

  return {
    mode,
    providerId: resolvedProviderId,
    modelRef,
    env,
    config: {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [resolvedProviderId]: providerEntry,
      },
      model: modelRef,
    },
  };
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

export async function runJsonAgent(
  input: AgentRunInput & { runner: AgentRunner },
): Promise<JsonObject> {
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
        result.content,
      ].join("\n"),
      context: input.context,
    });

    return parseJsonObject(repairResult.content);
  }
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
    const char = content[index] ?? "";

    if (inString) {
      repaired += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      repaired += char;
      continue;
    }

    if (char === ",") {
      const next = nextNonWhitespace(content, index + 1);
      if (next === "}" || next === "]") {
        continue;
      }
    }

    repaired += char;
  }

  return repaired;
}

function stripJsonCommentsOutsideStrings(content: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? "";
    const next = content[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        repaired += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      repaired += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      repaired += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    repaired += char;
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
      if (char === '"') {
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

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    const code = char.charCodeAt(0);
    repaired += code < 0x20 ? escapeJsonControlCharacter(char, code) : char;
  }

  return repaired;
}

function nextNonWhitespace(
  content: string,
  startIndex: number,
): string | undefined {
  for (let index = startIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char && !/\s/.test(char)) {
      return char;
    }
  }

  return undefined;
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

function asJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(asJsonValue);
  }

  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]),
    );
  }

  return String(value);
}

function shouldWriteNativeProviderConfig(
  executorProvider: AgentProviderConfig["coding_executor"],
): boolean {
  return Boolean(
    executorProvider?.npm ||
    executorProvider?.name ||
    Object.keys(executorProvider?.options ?? {}).length > 0 ||
    Object.keys(executorProvider?.model_options ?? {}).length > 0,
  );
}

function inferOpenCodeProviderId(
  mode: "auto" | "custom" | "native",
  model: string,
): string | undefined {
  if (mode !== "native") {
    return undefined;
  }

  const [providerId] = model.split("/");
  return providerId && providerId !== model ? providerId : undefined;
}

function toNativeOpenCodeProviderId(
  providerType: AgentProviderConfig["type"],
): string | undefined {
  switch (providerType) {
    case "anthropic":
      return "anthropic";
    case "google":
      return "google";
    case "xai":
      return "xai";
    case "mistral":
      return "mistral";
    case "groq":
      return "groq";
    case "openai-compatible":
      return undefined;
  }
}

function toOpenCodeProviderModelKey(providerId: string, model: string): string {
  return model.startsWith(`${providerId}/`)
    ? model.slice(providerId.length + 1)
    : model;
}

function toOpenCodeModelRef(providerId: string, modelKey: string): string {
  return `${providerId}/${modelKey}`;
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as JsonObject;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortError(error: unknown): boolean {
  return isObject(error) && error.name === "AbortError";
}
