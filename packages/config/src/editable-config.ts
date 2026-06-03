import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { findWorkspaceRoot, interpolateEnv, loadProjectEnv } from "./loader.js";
import {
  codezeroFileSchema,
  configSectionNames,
  repositoriesFileSchema,
  schemaForSection,
  type CodeZeroFileConfig,
  type ConfigSectionName,
  type RepositoryRuntimeSettingsPatch,
} from "./schema.js";

export type EditableConfigSection = {
  section: ConfigSectionName;
  path: string;
  templatePath: string;
  exists: boolean;
  content: string;
  parsed: unknown;
  updatedAt?: string;
};

export type EditableConfigSnapshot = {
  rootDir: string;
  sections: EditableConfigSection[];
};

export async function loadEditableConfig(
  rootDir?: string,
): Promise<EditableConfigSnapshot> {
  const resolvedRootDir =
    rootDir ??
    process.env.PROJECT_ROOT ??
    (await findWorkspaceRoot(process.cwd()));
  await loadProjectEnv(resolvedRootDir);
  const sections = await Promise.all(
    configSectionNames.map((section) =>
      readConfigSection(resolvedRootDir, section),
    ),
  );
  return { rootDir: resolvedRootDir, sections };
}

export async function readConfigSection(
  rootDir: string,
  section: ConfigSectionName,
): Promise<EditableConfigSection> {
  await loadProjectEnv(rootDir);
  return readUnifiedConfigSection(rootDir, section);
}

export async function writeConfigSection(
  rootDir: string,
  section: ConfigSectionName,
  content: string,
): Promise<EditableConfigSection> {
  await loadProjectEnv(rootDir);
  const parsedSection = parseConfigSection(section, content);
  const current = await readUnifiedConfigDocument(rootDir);
  const next = replaceUnifiedConfigSection(
    current.parsed,
    section,
    parsedSection,
  );
  const paths = getUnifiedConfigPaths(rootDir);
  await mkdir(path.dirname(paths.path), { recursive: true });
  const tempPath = `${paths.path}.tmp`;
  await writeFile(tempPath, YAML.stringify(next));
  await rename(tempPath, paths.path);
  return readConfigSection(rootDir, section);
}

export async function updateRepositoryRuntimeSettings(
  rootDir: string,
  repositoryId: string,
  patch: RepositoryRuntimeSettingsPatch,
): Promise<EditableConfigSection> {
  const current = await readConfigSection(rootDir, "repositories");
  const config = repositoriesFileSchema.parse(
    YAML.parse(interpolateEnv(current.content)),
  );
  const index = config.repositories.findIndex(
    (repository) => repository.id === repositoryId,
  );

  if (index < 0) {
    throw new Error(
      `Repository '${repositoryId}' is not defined in repositories config`,
    );
  }

  const repository = config.repositories[index];

  if (!repository) {
    throw new Error(
      `Repository '${repositoryId}' is not defined in repositories config`,
    );
  }

  config.repositories[index] = {
    ...repository,
    project_skill_path:
      patch.projectSkillPath?.trim() || repository.project_skill_path,
    project_rule_path:
      patch.projectRulePath?.trim() || repository.project_rule_path,
    trigger: {
      ...repository.trigger,
      mode: patch.triggerMode ?? repository.trigger.mode,
      mention: patch.mention?.trim() || repository.trigger.mention,
    },
    queue: {
      ...repository.queue,
      max_concurrent_issues:
        patch.maxConcurrentIssues ?? repository.queue.max_concurrent_issues,
    },
  };

  return writeConfigSection(rootDir, "repositories", YAML.stringify(config));
}

export function parseConfigSection(
  section: ConfigSectionName,
  content: string,
): unknown {
  return schemaForSection(section).parse(YAML.parse(interpolateEnv(content)));
}

export function isConfigSectionName(value: string): value is ConfigSectionName {
  return configSectionNames.includes(value as ConfigSectionName);
}

async function readUnifiedConfigSection(
  rootDir: string,
  section: ConfigSectionName,
): Promise<EditableConfigSection> {
  const document = await readUnifiedConfigDocument(rootDir);
  const stats = await stat(document.path).catch(() => undefined);

  return {
    section,
    path: document.path,
    templatePath: document.templatePath,
    exists: document.exists,
    content: YAML.stringify(pickUnifiedConfigSection(document.parsed, section)),
    parsed: parseConfigSection(
      section,
      YAML.stringify(pickUnifiedConfigSection(document.parsed, section)),
    ),
    updatedAt: stats?.mtime.toISOString(),
  };
}

async function readUnifiedConfigDocument(rootDir: string): Promise<{
  path: string;
  templatePath: string;
  exists: boolean;
  content: string;
  parsed: CodeZeroFileConfig;
}> {
  const paths = getUnifiedConfigPaths(rootDir);
  const content = await readFile(paths.path, "utf8");

  return {
    path: paths.path,
    templatePath: paths.templatePath,
    exists: true,
    content,
    parsed: codezeroFileSchema.parse(YAML.parse(interpolateEnv(content))),
  };
}

function pickUnifiedConfigSection(
  config: CodeZeroFileConfig,
  section: ConfigSectionName,
): unknown {
  switch (section) {
    case "agents":
      return {
        providers: config.providers,
        agents: config.agents,
      };
    case "repositories":
      return { repositories: config.repositories };
    case "sandbox":
      return { sandbox: config.sandbox };
    case "memory":
      return { memory: config.memory };
    case "workflow_graph":
      return { workflow_graph: config.workflow_graph };
  }
}

function replaceUnifiedConfigSection(
  config: CodeZeroFileConfig,
  section: ConfigSectionName,
  parsedSection: unknown,
): CodeZeroFileConfig {
  const next = { ...config };

  switch (section) {
    case "agents": {
      const parsed = schemaForSection("agents").parse(parsedSection) as Pick<
        CodeZeroFileConfig,
        "providers" | "agents"
      >;
      return { ...next, providers: parsed.providers, agents: parsed.agents };
    }
    case "repositories": {
      const parsed = repositoriesFileSchema.parse(parsedSection);
      return { ...next, repositories: parsed.repositories };
    }
    case "sandbox": {
      const parsed = schemaForSection("sandbox").parse(parsedSection) as Pick<
        CodeZeroFileConfig,
        "sandbox"
      >;
      return { ...next, sandbox: parsed.sandbox };
    }
    case "memory": {
      const parsed = schemaForSection("memory").parse(parsedSection) as Pick<
        CodeZeroFileConfig,
        "memory"
      >;
      return { ...next, memory: parsed.memory };
    }
    case "workflow_graph": {
      const parsed = schemaForSection("workflow_graph").parse(
        parsedSection,
      ) as Pick<CodeZeroFileConfig, "workflow_graph">;
      return { ...next, workflow_graph: parsed.workflow_graph };
    }
  }
}

function getUnifiedConfigPaths(rootDir: string): {
  path: string;
  templatePath: string;
} {
  return {
    path: path.join(rootDir, "config", "codezero.yaml"),
    templatePath: path.join(rootDir, "config", "codezero.example.yaml"),
  };
}
