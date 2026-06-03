export type ProviderPresetType =
  | "openai-compatible"
  | "anthropic"
  | "google"
  | "xai"
  | "mistral"
  | "groq";

export type ProviderPreset = {
  id: string;
  label: string;
  type: ProviderPresetType;
  baseUrl?: string;
  model: string;
  apiKeyEnv: string;
};

export const providerPresets: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    label: "Claude / Anthropic",
    type: "anthropic",
    model: "claude-sonnet-4-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  {
    id: "google",
    label: "Gemini / Google",
    type: "google",
    model: "gemini-3-pro-preview",
    apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
  {
    id: "xai",
    label: "Grok / xAI",
    type: "xai",
    model: "grok-4-latest",
    apiKeyEnv: "XAI_API_KEY",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "qwen",
    label: "Qwen compatible mode",
    type: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.5",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "xiaomi-mimo",
    label: "Xiaomi MiMo",
    type: "openai-compatible",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-pro",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "mistral",
    label: "Mistral",
    type: "mistral",
    model: "mistral-large-latest",
    apiKeyEnv: "MISTRAL_API_KEY",
  },
  {
    id: "groq",
    label: "Groq",
    type: "groq",
    model: "openai/gpt-oss-120b",
    apiKeyEnv: "GROQ_API_KEY",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    type: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1",
    apiKeyEnv: "OPENAI_API_KEY",
  },
];

export function applyProviderPresetToAgentsYaml(
  content: string,
  preset: ProviderPreset,
  providerId = "default",
): string {
  const providerBlock = [
    `  ${providerId}:`,
    `    type: ${preset.type}`,
    ...(preset.baseUrl ? [`    base_url: "${preset.baseUrl}"`] : []),
    `    api_key_env: "${preset.apiKeyEnv}"`,
    `    model: "${preset.model}"`,
    "    supports_structured_output: true",
    "    timeout_ms: 900000",
    "    coding_executor:",
    "      mode: auto",
  ].join("\n");
  const providerPattern = new RegExp(
    `(^  ${escapeRegExp(providerId)}:\\n)[\\s\\S]*?(?=^  [A-Za-z0-9_.-]+:\\s*$|^agents:\\s*$|(?![\\s\\S]))`,
    "m",
  );

  if (providerPattern.test(content)) {
    return ensureTrailingNewline(
      content.replace(providerPattern, `${providerBlock}\n`),
    );
  }

  if (/^providers:\s*$/m.test(content)) {
    return ensureTrailingNewline(
      content.replace(/^providers:\s*$/m, `providers:\n${providerBlock}`),
    );
  }

  return ensureTrailingNewline(
    `providers:\n${providerBlock}\n\n${content.trimStart()}`,
  );
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
