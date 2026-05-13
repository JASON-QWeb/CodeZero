import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  isConfigSectionName,
  findWorkspaceRoot,
  loadEditableConfig,
  parseConfigSection,
  readConfigSection,
  writeConfigSection,
  type ConfigSectionName
} from "@agent/config";

const updateConfigBodySchema = z.object({
  content: z.string().min(1)
});

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings/config", async () => loadEditableConfig());

  app.get<{ Params: { section: string } }>("/settings/config/:section", async (request, reply) => {
    const section = parseSection(request.params.section);

    if (!section) {
      return reply.code(404).send({ message: "Unknown config section" });
    }

    return readConfigSection(await resolveRootDir(), section);
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
      return writeConfigSection(await resolveRootDir(), section, parsed.data.content);
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
