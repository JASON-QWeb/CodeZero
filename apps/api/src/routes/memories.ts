import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FileMemoryStore, type MemoryRecordPatch } from "@agent/memory";
import { getServices } from "../services/task-services.js";

const listMemoryQuerySchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  status: z.enum(["proposed", "approved", "rejected"]).optional()
});

const updateMemorySchema = z.object({
  kind: z.enum(["semantic", "episodic", "procedural", "policy"]).optional(),
  status: z.enum(["proposed", "approved", "rejected"]).optional(),
  scope: z.enum(["repository", "global"]).optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.record(z.string(), z.unknown()).optional()
});

const pruneMemorySchema = z.object({
  maxRecords: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional()
});

export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { owner?: string; repo?: string; status?: string } }>("/memories", async (request, reply) => {
    const parsed = listMemoryQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid memory query", issues: parsed.error.issues });
    }

    const services = await getServices();
    const store = memoryStore(services.config.memory);
    return { memories: await store.list(parsed.data) };
  });

  app.patch<{ Params: { id: string } }>("/memories/:id", async (request, reply) => {
    const parsed = updateMemorySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid memory patch", issues: parsed.error.issues });
    }

    const services = await getServices();
    const store = memoryStore(services.config.memory);

    try {
      return { memory: await store.update(request.params.id, parsed.data as MemoryRecordPatch) };
    } catch (error) {
      return reply.code(404).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { id: string } }>("/memories/:id", async (request, reply) => {
    const services = await getServices();
    const store = memoryStore(services.config.memory);

    try {
      await store.delete(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(404).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/memories/prune", async (request, reply) => {
    const parsed = pruneMemorySchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid memory prune request", issues: parsed.error.issues });
    }

    const services = await getServices();
    const store = memoryStore(services.config.memory);
    return { memories: await store.prune(parsed.data) };
  });

  app.post<{ Params: { id: string } }>("/memories/:id/approve", async (request, reply) => {
    const services = await getServices();
    const store = memoryStore(services.config.memory);

    try {
      return { memory: await store.approve(request.params.id) };
    } catch (error) {
      return reply.code(404).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/memories/:id/reject", async (request, reply) => {
    const services = await getServices();
    const store = memoryStore(services.config.memory);

    try {
      return { memory: await store.reject(request.params.id) };
    } catch (error) {
      return reply.code(404).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });
}

function memoryStore(config: {
  filePath: string;
  maxRecords: number;
  maxBytes: number;
  maxRecordBytes: number;
}): FileMemoryStore {
  return new FileMemoryStore(config.filePath, {
    maxRecords: config.maxRecords,
    maxBytes: config.maxBytes,
    maxRecordBytes: config.maxRecordBytes,
  });
}
