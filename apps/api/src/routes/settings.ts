import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  isConfigSectionName,
  findWorkspaceRoot,
  loadEditableConfig,
  loadProjectEnv,
  parseConfigSection,
  readConfigSection,
  repositoryTriggerModes,
  toolPermissionLevels,
  updateRepositoryRuntimeSettings,
  upsertProjectEnv,
  writeConfigSection,
  type AgentsFileConfig,
  type ConfigSectionName
} from "@agent/config";
import { reloadServices } from "../services/task-services.js";
import { startConfiguredRepositoryOnboarding } from "../services/repository-onboarding.js";

const updateConfigBodySchema = z.object({
  content: z.string().min(1)
});

const validateProviderBodySchema = z.object({
  content: z.string().min(1),
  providerId: z.string().min(1),
  apiKey: z.string().optional()
});

const saveProviderApiKeyBodySchema = z.object({
  content: z.string().optional(),
  providerId: z.string().min(1),
  apiKey: z.string().min(1).refine((value) => value.trim().length > 0, "API key cannot be blank")
});

const repositoryRuntimeSettingsSchema = z
  .object({
    triggerMode: z.enum(repositoryTriggerModes).optional(),
    mention: z.string().min(1).optional(),
    maxConcurrentIssues: z.number().int().positive().max(50).optional(),
    projectSkillPath: z.string().min(1).optional(),
    allowedPermissions: z.array(z.enum(toolPermissionLevels)).optional(),
    blockedPermissions: z.array(z.enum(toolPermissionLevels)).optional()
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), "At least one repository setting must be provided");

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings/config", async () => loadEditableConfig());

  app.post<{ Body: { content?: string; providerId?: string; apiKey?: string } }>("/settings/providers/validate", async (request, reply) => {
    const parsed = validateProviderBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ valid: false, message: "Invalid provider validation payload", issues: parsed.error.issues });
    }

    try {
      return await validateProviderConnection(parsed.data);
    } catch (error) {
      return reply.code(400).send({
        providerId: parsed.data.providerId,
        valid: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.put<{ Body: { content?: string; providerId?: string; apiKey?: string } }>("/settings/providers/api-key", async (request, reply) => {
    const parsed = saveProviderApiKeyBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ saved: false, message: "Invalid provider API key payload", issues: parsed.error.issues });
    }

    try {
      const rootDir = await resolveRootDir();
      const agentsConfig = parsed.data.content
        ? (parseConfigSection("agents", parsed.data.content) as AgentsFileConfig)
        : ((await readConfigSection(rootDir, "agents")).parsed as AgentsFileConfig);
      const provider = agentsConfig.providers[parsed.data.providerId];

      if (!provider) {
        return reply.code(404).send({
          providerId: parsed.data.providerId,
          saved: false,
          message: `Provider '${parsed.data.providerId}' is not defined in agents config`
        });
      }

      await upsertProjectEnv(rootDir, provider.api_key_env, parsed.data.apiKey.trim());
      const services = await reloadServices();
      void startConfiguredRepositoryOnboarding(services.config);

      return {
        providerId: parsed.data.providerId,
        apiKeyEnv: provider.api_key_env,
        saved: true,
        message: `Saved API key to ${provider.api_key_env} and reloaded runtime config.`
      };
    } catch (error) {
      return reply.code(400).send({
        providerId: parsed.data.providerId,
        saved: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get<{ Params: { section: string } }>("/settings/config/:section", async (request, reply) => {
    const section = parseSection(request.params.section);

    if (!section) {
      return reply.code(404).send({ message: "Unknown config section" });
    }

    return readConfigSection(await resolveRootDir(), section);
  });

  app.put<{
    Params: { repositoryId: string };
    Body: {
      triggerMode?: string;
      mention?: string;
      maxConcurrentIssues?: number;
      projectSkillPath?: string;
      allowedPermissions?: string[];
      blockedPermissions?: string[];
    };
  }>("/settings/repositories/:repositoryId/runtime", async (request, reply) => {
    const parsed = repositoryRuntimeSettingsSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid repository runtime settings", issues: parsed.error.issues });
    }

    try {
      const section = await updateRepositoryRuntimeSettings(await resolveRootDir(), request.params.repositoryId, parsed.data);
      const services = await reloadServices();
      void startConfiguredRepositoryOnboarding(services.config);
      return section;
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { section: string }; Body: { content?: string } }>("/settings/config/:section/validate", async (request, reply) => {
    const section = parseSection(request.params.section);

    if (!section) {
      return reply.code(404).send({ message: "Unknown config section" });
    }

    const parsed = updateConfigBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid config payload", issues: parsed.error.issues });
    }

    try {
      return { section, valid: true, parsed: parseConfigSection(section, parsed.data.content) };
    } catch (error) {
      return reply.code(400).send({ section, valid: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Params: { section: string }; Body: { content?: string } }>("/settings/config/:section", async (request, reply) => {
    const section = parseSection(request.params.section);

    if (!section) {
      return reply.code(404).send({ message: "Unknown config section" });
    }

    const parsed = updateConfigBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid config payload", issues: parsed.error.issues });
    }

    try {
      const saved = await writeConfigSection(await resolveRootDir(), section, parsed.data.content);
      const services = await reloadServices();
      void startConfiguredRepositoryOnboarding(services.config);
      return saved;
    } catch (error) {
      return reply.code(400).send({ section, message: error instanceof Error ? error.message : String(error) });
    }
  });
}

function parseSection(value: string): ConfigSectionName | undefined {
  return isConfigSectionName(value) ? value : undefined;
}

async function resolveRootDir(): Promise<string> {
  return process.env.PROJECT_ROOT ?? (await findWorkspaceRoot(process.cwd()));
}

async function validateProviderConnection(input: { content: string; providerId: string; apiKey?: string }) {
  await loadProjectEnv(await resolveRootDir());
  const agentsConfig = parseConfigSection("agents", input.content) as AgentsFileConfig;
  const provider = agentsConfig.providers[input.providerId];

  if (!provider) {
    return {
      providerId: input.providerId,
      valid: false,
      message: `Provider '${input.providerId}' is not defined in agents config`
    };
  }

  if (hasUnresolvedPlaceholder(provider.base_url) || hasUnresolvedPlaceholder(provider.model)) {
    return {
      providerId: input.providerId,
      valid: false,
      baseUrl: provider.base_url,
      model: provider.model,
      message: "Provider base_url or model still contains unresolved environment placeholders"
    };
  }

  const apiKey = input.apiKey?.trim() || process.env[provider.api_key_env];

  if (!apiKey) {
    return {
      providerId: input.providerId,
      valid: false,
      baseUrl: provider.base_url,
      model: provider.model,
      usedApiKeySource: "missing",
      message: `Missing API key. Set ${provider.api_key_env} in the API server environment or enter a one-time key in WebUI.`
    };
  }

  const startedAt = Date.now();
  const timeoutMs = Math.min(provider.timeout_ms ?? 15_000, 30_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${provider.base_url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: "Reply with ok." }],
        temperature: 0,
        max_tokens: 4
      })
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text();
      return {
        providerId: input.providerId,
        valid: false,
        baseUrl: provider.base_url,
        model: provider.model,
        statusCode: response.status,
        latencyMs,
        usedApiKeySource: input.apiKey?.trim() ? "request" : "env",
        message: `Provider returned ${response.status}: ${body.slice(0, 500)}`
      };
    }

    return {
      providerId: input.providerId,
      valid: true,
      baseUrl: provider.base_url,
      model: provider.model,
      statusCode: response.status,
      latencyMs,
      usedApiKeySource: input.apiKey?.trim() ? "request" : "env",
      message: `Provider '${input.providerId}' responded successfully in ${latencyMs}ms.`
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error && error.name === "AbortError" ? `Provider validation timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error);

    return {
      providerId: input.providerId,
      valid: false,
      baseUrl: provider.base_url,
      model: provider.model,
      latencyMs,
      usedApiKeySource: input.apiKey?.trim() ? "request" : "env",
      message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function hasUnresolvedPlaceholder(value: string): boolean {
  return value.includes("${");
}
