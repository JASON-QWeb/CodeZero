import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgentRunner, OpenAICompatibleProvider, type AgentDefinition } from "@agent/agent-runtime";
import type { AppConfig } from "@agent/config";

export async function createWorkflowAgentRunner(config: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<AgentRunner> {
  const providers = new Map(
    Object.entries(config.agents.providers).map(([id, provider]) => {
      const apiKey = env[provider.api_key_env] ?? "";

      if (!apiKey) {
        throw new Error(`${provider.api_key_env} is required for provider ${id}`);
      }

      if (provider.model.includes("${") || provider.base_url.includes("${")) {
        throw new Error(`Provider ${id} has unresolved environment placeholders`);
      }

      return [
        id,
        new OpenAICompatibleProvider({
          id,
          baseUrl: provider.base_url,
          apiKey,
          model: provider.model,
          temperature: provider.temperature,
          maxTokens: provider.max_tokens,
          supportsTools: provider.supports_tools,
          supportsStructuredOutput: provider.supports_structured_output,
          timeoutMs: provider.timeout_ms
        })
      ] as const;
    })
  );

  return new AgentRunner(providers);
}

export async function createExecutionAgents(
  config: AppConfig,
  complexityScore: number
): Promise<{ implementation: AgentDefinition; review: AgentDefinition }> {
  return {
    implementation: await createWorkflowAgent(config, "implementation", "main-implementation", complexityScore),
    review: await createWorkflowAgent(config, "review", "review", complexityScore)
  };
}

export async function createWorkflowAgent(
  config: AppConfig,
  configKey: string,
  role: AgentDefinition["role"],
  complexityScore?: number
): Promise<AgentDefinition> {
  const agentConfig = config.agents.agents[configKey];

  if (!agentConfig) {
    throw new Error(`Missing agent config: ${configKey}`);
  }

  const promptPath = path.resolve(config.rootDir, agentConfig.system_prompt);
  const systemPrompt = await readFile(promptPath, "utf8");

  return {
    id: configKey,
    role,
    providerId: selectProviderForComplexity(agentConfig.provider, agentConfig.provider_by_complexity, complexityScore),
    systemPrompt,
    skillRefs: agentConfig.skills,
    tools: config.tools.map((tool) => tool.name),
    guardrails: config.policies.map((policy) => policy.id)
  };
}

export function selectProviderForComplexity(
  fallbackProvider: string,
  providerByComplexity: { low?: string; medium?: string; high?: string } | undefined,
  complexityScore: number | undefined
): string {
  if (complexityScore === undefined) {
    return fallbackProvider;
  }

  if (complexityScore <= 35) {
    return providerByComplexity?.low ?? fallbackProvider;
  }

  if (complexityScore <= 70) {
    return providerByComplexity?.medium ?? fallbackProvider;
  }

  return providerByComplexity?.high ?? fallbackProvider;
}
