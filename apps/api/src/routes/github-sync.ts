import type { FastifyInstance } from "fastify";
import {
  getGitHubRepositorySyncState,
  GitHubSyncRepositoryNotFoundError,
  triggerGitHubRepositorySync
} from "../services/github-sync.js";
import { getServices } from "../services/task-services.js";

export async function registerGitHubSyncRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { repositoryId: string } }>("/repositories/:repositoryId/github-sync", async (request, reply) => {
    const services = await getServices();

    if (!services.config.repositories.some((repository) => repository.id === request.params.repositoryId)) {
      return reply.code(404).send({ message: `Repository '${request.params.repositoryId}' is not configured` });
    }

    return { sync: getGitHubRepositorySyncState(request.params.repositoryId) };
  });

  app.post<{ Params: { repositoryId: string } }>("/repositories/:repositoryId/github-sync", async (request, reply) => {
    try {
      const sync = await triggerGitHubRepositorySync(request.params.repositoryId);
      return reply.code(202).send(sync);
    } catch (error) {
      if (error instanceof GitHubSyncRepositoryNotFoundError) {
        return reply.code(404).send({ message: error.message });
      }
      throw error;
    }
  });
}
