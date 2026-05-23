import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { findWorkspaceRoot, interpolateEnv } from "./loader.js";
import { configSectionNames, repositoriesFileSchema, schemaForSection, type ConfigSectionName, type RepositoryRuntimeSettingsPatch } from "./schema.js";

export type EditableConfigSection = {
  section: ConfigSectionName;
  path: string;
  fallbackPath: string;
  exists: boolean;
  content: string;
  parsed: unknown;
  updatedAt?: string;
};

export type EditableConfigSnapshot = {
  rootDir: string;
  sections: EditableConfigSection[];
};

export async function loadEditableConfig(rootDir?: string): Promise<EditableConfigSnapshot> {
  const resolvedRootDir = rootDir ?? process.env.PROJECT_ROOT ?? (await findWorkspaceRoot(process.cwd()));
  const sections = await Promise.all(configSectionNames.map((section) => readConfigSection(resolvedRootDir, section)));
  return { rootDir: resolvedRootDir, sections };
}

export async function readConfigSection(rootDir: string, section: ConfigSectionName): Promise<EditableConfigSection> {
  const paths = getConfigSectionPaths(rootDir, section);
  const primary = await readFile(paths.path, "utf8")
    .then((content) => ({ content, exists: true }))
    .catch(async () => ({ content: await readFile(paths.fallbackPath, "utf8"), exists: false }));
  const stats = await stat(paths.path).catch(() => undefined);

  return {
    section,
    path: paths.path,
    fallbackPath: paths.fallbackPath,
    exists: primary.exists,
    content: primary.content,
    parsed: parseConfigSection(section, primary.content),
    updatedAt: stats?.mtime.toISOString()
  };
}

export async function writeConfigSection(rootDir: string, section: ConfigSectionName, content: string): Promise<EditableConfigSection> {
  parseConfigSection(section, content);
  const paths = getConfigSectionPaths(rootDir, section);
  await mkdir(path.dirname(paths.path), { recursive: true });
  const tempPath = `${paths.path}.tmp`;
  await writeFile(tempPath, content.endsWith("\n") ? content : `${content}\n`);
  await rename(tempPath, paths.path);
  return readConfigSection(rootDir, section);
}

export async function updateRepositoryRuntimeSettings(
  rootDir: string,
  repositoryId: string,
  patch: RepositoryRuntimeSettingsPatch
): Promise<EditableConfigSection> {
  const current = await readConfigSection(rootDir, "repositories");
  const config = repositoriesFileSchema.parse(YAML.parse(interpolateEnv(current.content)));
  const index = config.repositories.findIndex((repository) => repository.id === repositoryId);

  if (index < 0) {
    throw new Error(`Repository '${repositoryId}' is not defined in repositories config`);
  }

  const repository = config.repositories[index];

  if (!repository) {
    throw new Error(`Repository '${repositoryId}' is not defined in repositories config`);
  }

  config.repositories[index] = {
    ...repository,
    trigger: {
      ...repository.trigger,
      mode: patch.triggerMode ?? repository.trigger.mode,
      mention: patch.mention?.trim() || repository.trigger.mention
    },
    queue: {
      ...repository.queue,
      max_concurrent_issues: patch.maxConcurrentIssues ?? repository.queue.max_concurrent_issues
    },
    permissions: {
      ...repository.permissions,
      allowed_permissions: patch.allowedPermissions ?? repository.permissions.allowed_permissions,
      blocked_permissions: patch.blockedPermissions ?? repository.permissions.blocked_permissions
    }
  };

  return writeConfigSection(rootDir, "repositories", YAML.stringify(config));
}

export function parseConfigSection(section: ConfigSectionName, content: string): unknown {
  return schemaForSection(section).parse(YAML.parse(interpolateEnv(content)));
}

export function isConfigSectionName(value: string): value is ConfigSectionName {
  return configSectionNames.includes(value as ConfigSectionName);
}

function getConfigSectionPaths(rootDir: string, section: ConfigSectionName): { path: string; fallbackPath: string } {
  return {
    path: path.join(rootDir, "config", `${section}.yaml`),
    fallbackPath: path.join(rootDir, "config", `${section}.example.yaml`)
  };
}
