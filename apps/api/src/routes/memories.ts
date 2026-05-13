import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FileMemoryStore } from "@agent/memory";
import { getServices } from "../services/task-services.js";

const listMemoryQuerySchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  status: z.enum(["proposed", "approved", "rejected"]).optional()
});

export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { owner?: string; repo?: string; status?: string } }>("/memories", async (request, reply) => {
    const parsed = listMemoryQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid memory query", issues: parsed.error.issues });
    }

    const services = await getServices();
    const store = new FileMemoryStore(services.config.memory.filePath);
    return { memories: await store.list(parsed.data) };
  });

  app.post<{ Params: { id: string } }>("/memories/:id/approve", async (request, reply) => {
    const services = await getServices();
    const store = new FileMemoryStore(services.config.memory.filePath);

    try {
      return { memory: await store.approve(request.params.id) };
    } catch (error) {
      return reply.code(404).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/memories/:id/reject", async (request, reply) => {
    const services = await getServices();
    const store = new FileMemoryStore(services.config.memory.filePath);

    try {
      return { memory: await store.reject(request.params.id) };
    } catch (error) {
      return reply.code(404).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });
}
