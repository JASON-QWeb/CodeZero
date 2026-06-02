import {
  access,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig, RepositoryConfig } from "@agent/config";
import { getServices } from "../services/task-services.js";
import {
  getProjectKnowledgeGraphState,
  openProjectKnowledgeGraphDashboard,
  prepareRepositoryCheckout,
  projectRepositoryDir,
  startProjectKnowledgeGraphGeneration,
} from "../services/understand-anything.js";
import {
  getRepositoryOnboardingState,
  startRepositoryOnboarding,
} from "../services/repository-onboarding.js";

const generationSchema = z.object({
  full: z.boolean().optional(),
});

const contextFileSchema = z.object({
  kind: z.enum(["skill", "rule"]),
  path: z.string().min(1).max(400),
  content: z.string().max(1_000_000),
});

type RepositoryContextFileKind = "skill" | "rule";

type RepositoryContextFile = {
  kind: RepositoryContextFileKind;
  path: string;
  name: string;
  content: string;
  updatedAt?: string;
};

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
    "/repositories/:repositoryId/context-files",
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
          files: await listRepositoryContextFiles(
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

  app.put<{
    Params: { repositoryId: string };
    Body: z.infer<typeof contextFileSchema>;
  }>(
    "/repositories/:repositoryId/context-files",
    async (request, reply) => {
      const parsed = contextFileSchema.safeParse(request.body ?? {});

      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid repository context file payload",
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
        await writeRepositoryContextFile(
          services.config,
          repository,
          parsed.data,
        );
        return {
          files: await listRepositoryContextFiles(
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

async function listRepositoryContextFiles(
  config: AppConfig,
  repository: RepositoryConfig,
): Promise<RepositoryContextFile[]> {
  const repoDir = await ensureManagedRepositoryCheckout(config, repository);
  const files = [
    ...(await collectContextFiles(
      repoDir,
      path.join(repository.project_skill_path, "skills"),
      "skill",
    )),
    ...(await collectContextFiles(
      repoDir,
      repository.project_rule_path,
      "rule",
    )),
  ];

  return files.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind);
    }

    return left.path.localeCompare(right.path);
  });
}

async function writeRepositoryContextFile(
  config: AppConfig,
  repository: RepositoryConfig,
  input: z.infer<typeof contextFileSchema>,
): Promise<void> {
  const repoDir = await ensureManagedRepositoryCheckout(config, repository);
  const filePath = resolveContextFilePath(repoDir, repository, input);

  if (input.kind === "skill" && path.basename(filePath) !== "SKILL.md") {
    throw new Error("Skill 文件路径必须以 SKILL.md 结尾。");
  }

  if (!/\.(md|mdx|txt|ya?ml)$/i.test(filePath)) {
    throw new Error("只能编辑 Skill 或 Rule 文本文件。");
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, input.content, "utf8");
}

async function collectContextFiles(
  repoDir: string,
  relativeRoot: string,
  kind: RepositoryContextFileKind,
): Promise<RepositoryContextFile[]> {
  const root = path.resolve(repoDir, relativeRoot);

  if (!(await exists(root))) {
    return [];
  }

  const files: RepositoryContextFile[] = [];
  await walkContextFiles(repoDir, root, kind, files);
  return files;
}

async function walkContextFiles(
  repoDir: string,
  dir: string,
  kind: RepositoryContextFileKind,
  files: RepositoryContextFile[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkContextFiles(repoDir, filePath, kind, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const isSupported =
      kind === "skill"
        ? entry.name === "SKILL.md"
        : /\.(md|mdx|txt|ya?ml)$/i.test(entry.name);

    if (!isSupported) {
      continue;
    }

    const fileStat = await stat(filePath).catch(() => undefined);
    files.push({
      kind,
      path: repositoryRelativePath(repoDir, filePath),
      name: displayContextFileName(kind, filePath),
      content: await readFile(filePath, "utf8"),
      updatedAt: fileStat?.mtime.toISOString(),
    });
  }
}

async function ensureManagedRepositoryCheckout(
  config: AppConfig,
  repository: RepositoryConfig,
): Promise<string> {
  const repoDir = projectRepositoryDir(config, repository);

  if (await exists(path.join(repoDir, ".git"))) {
    return repoDir;
  }

  return prepareRepositoryCheckout(config, repository);
}

function resolveContextFilePath(
  repoDir: string,
  repository: RepositoryConfig,
  input: z.infer<typeof contextFileSchema>,
): string {
  const root =
    input.kind === "skill"
      ? path.resolve(repoDir, repository.project_skill_path, "skills")
      : path.resolve(repoDir, repository.project_rule_path);
  const requestedPath = input.path.replace(/\\/g, "/");
  const filePath = path.resolve(repoDir, requestedPath);

  if (!isInsideDirectory(filePath, root)) {
    throw new Error("只能编辑当前仓库配置的 Skill 或 Rule 目录。");
  }

  return filePath;
}

function isInsideDirectory(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return (
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function repositoryRelativePath(repoDir: string, filePath: string): string {
  return path.relative(repoDir, filePath).split(path.sep).join("/");
}

function displayContextFileName(
  kind: RepositoryContextFileKind,
  filePath: string,
): string {
  if (kind === "skill") {
    return path.basename(path.dirname(filePath));
  }

  return path.basename(filePath);
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}
