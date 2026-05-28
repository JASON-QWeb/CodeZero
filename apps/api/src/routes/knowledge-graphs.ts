import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RepositoryConfig } from "@agent/config";
import { getServices } from "../services/task-services.js";
import {
  getProjectKnowledgeGraphState,
  openProjectKnowledgeGraphDashboard,
  startProjectKnowledgeGraphGeneration,
} from "../services/understand-anything.js";
import {
  getRepositoryOnboardingState,
  startRepositoryOnboarding,
} from "../services/repository-onboarding.js";

const generationSchema = z.object({
  full: z.boolean().optional(),
});

export async function registerKnowledgeGraphRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get<{ Params: { repositoryId: string } }>(
    "/repositories/:repositoryId/onboarding",
    async (request, reply) => {
      const services = await getServices();
      const repository = findConfiguredRepository(
        services.config.repositories,
        request.params.repositoryId,
      );

      if (!repository) {
        return reply.code(404).send({ message: "Repository not found" });
      }

      if (process.env.NODE_ENV !== "test") {
        void startRepositoryOnboarding(services.config, repository).catch(
          () => undefined,
        );
      }

      return {
        onboarding: await getRepositoryOnboardingState(
          services.config,
          repository,
        ),
      };
    },
  );

  app.post<{ Params: { repositoryId: string } }>(
    "/repositories/:repositoryId/onboarding",
    async (request, reply) => {
      const services = await getServices();
      const repository = findConfiguredRepository(
        services.config.repositories,
        request.params.repositoryId,
      );

      if (!repository) {
        return reply.code(404).send({ message: "Repository not found" });
      }

      return reply.code(202).send({
        onboarding: await startRepositoryOnboarding(services.config, repository),
      });
    },
  );

  app.get<{ Params: { repositoryId: string } }>(
    "/repositories/:repositoryId/knowledge-graph",
    async (request, reply) => {
      const services = await getServices();
      const repository = findConfiguredRepository(
        services.config.repositories,
        request.params.repositoryId,
      );

      if (!repository) {
        return reply.code(404).send({ message: "Repository not found" });
      }

      return {
        knowledgeGraph: await getProjectKnowledgeGraphState(
          services.config,
          repository,
        ),
      };
    },
  );

  app.post<{ Params: { repositoryId: string }; Body: { full?: boolean } }>(
    "/repositories/:repositoryId/knowledge-graph/generate",
    async (request, reply) => {
      const parsed = generationSchema.safeParse(request.body ?? {});

      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid graph generation payload",
          issues: parsed.error.issues,
        });
      }

      const services = await getServices();
      const repository = findConfiguredRepository(
        services.config.repositories,
        request.params.repositoryId,
      );

      if (!repository) {
        return reply.code(404).send({ message: "Repository not found" });
      }

      try {
        const knowledgeGraph = await startProjectKnowledgeGraphGeneration(
          services.config,
          repository,
          parsed.data,
        );
        return reply.code(202).send({ knowledgeGraph });
      } catch (error) {
        return reply.code(409).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post<{ Params: { repositoryId: string } }>(
    "/repositories/:repositoryId/knowledge-graph/dashboard",
    async (request, reply) => {
      const services = await getServices();
      const repository = findConfiguredRepository(
        services.config.repositories,
        request.params.repositoryId,
      );

      if (!repository) {
        return reply.code(404).send({ message: "Repository not found" });
      }

      try {
        return {
          knowledgeGraph: await openProjectKnowledgeGraphDashboard(
            services.config,
            repository,
          ),
        };
      } catch (error) {
        return reply.code(409).send({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

function findConfiguredRepository(
  repositories: RepositoryConfig[],
  repositoryId: string,
): RepositoryConfig | undefined {
  return repositories.find((repository) => repository.id === repositoryId);
}
