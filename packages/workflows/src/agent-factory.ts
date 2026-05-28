import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "@agent/config";
import { createModelRuntimeAgentRunner, type AgentDefinition, type AgentRunner } from "@agent/model-runtime";

export async function createWorkflowAgentRunner(config: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<AgentRunner> {
  return createModelRuntimeAgentRunner(config, env);
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
