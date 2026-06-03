import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "@agent/config";
import { createModelRuntimeAgentRunner, type AgentDefinition, type AgentRunner } from "@agent/model-runtime";
import { loadPlatformSkills } from "@agent/skills";

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
  const skillPrompt = await renderPlatformSkillPrompt(
    config.rootDir,
    agentConfig.skills,
  );

  return {
    id: configKey,
    role,
    providerId: selectProviderForComplexity(agentConfig.provider, agentConfig.provider_by_complexity, complexityScore),
    systemPrompt: [systemPrompt.trim(), skillPrompt].filter(Boolean).join("\n\n"),
    skillRefs: agentConfig.skills
  };
}

async function renderPlatformSkillPrompt(
  projectRoot: string,
  skillRefs: string[],
): Promise<string> {
  if (skillRefs.length === 0) {
    return "";
  }

  const platformSkills = await loadPlatformSkills(projectRoot).catch(() => []);
  const skillsById = new Map(platformSkills.map((skill) => [skill.id, skill]));
  const selectedSkills = skillRefs
    .map((skillRef) => skillsById.get(skillRef))
    .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));

  if (selectedSkills.length === 0) {
    return "";
  }

  return [
    "# Enabled Platform Skills",
    ...selectedSkills.map(
      (skill) => `## ${skill.id}\n${skill.content.trim()}`,
    ),
  ].join("\n\n");
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
