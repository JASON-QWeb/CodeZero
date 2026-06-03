import { triggerModes } from "./constants";
import type {
  ConfigSection,
  RepositoryQuickConfig,
  TriggerMode,
} from "./types";

export function buildSummary(
  section: ConfigSection | undefined,
): Array<{ label: string; value: string }> {
  if (!section) {
    return [];
  }

  const parsed = asRecord(section.parsed);

  if (section.section === "agents") {
    const providers = Object.keys(asRecord(parsed.providers));
    const agents = asRecord(parsed.agents);
    return [
      { label: "供应商", value: String(providers.length) },
      { label: "代理步骤", value: String(Object.keys(agents).length) },
      {
        label: "路由",
        value:
          Object.entries(agents)
            .map(
              ([name, value]) => `${name}:${asRecord(value).provider ?? "?"}`,
            )
            .join(", ") || "无",
      },
    ];
  }

  if (section.section === "repositories") {
    const repositories = Array.isArray(parsed.repositories)
      ? parsed.repositories
      : [];
    return [
      { label: "仓库", value: String(repositories.length) },
      {
        label: "触发",
        value:
          repositories
            .map((repo) => asRecord(asRecord(repo).trigger).mode)
            .join(", ") || "无",
      },
      {
        label: "队列上限",
        value:
          repositories
            .map((repo) =>
              String(asRecord(asRecord(repo).queue).max_concurrent_issues ?? 1),
            )
            .join(", ") || "无",
      },
      {
        label: "Skill/Rule",
        value: `${repositories.length} 个仓库级配置`,
      },
      {
        label: "质量门禁",
        value: String(
          repositories.filter(
            (repo) =>
              Object.keys(asRecord(asRecord(repo).quality_gates)).length > 0,
          ).length,
        ),
      },
    ];
  }

  if (section.section === "memory") {
    const memory = asRecord(parsed.memory);
    return [
      { label: "记录上限", value: String(memory.max_records ?? "未知") },
      { label: "总大小", value: String(memory.max_bytes ?? "未知") },
      { label: "单条大小", value: String(memory.max_record_bytes ?? "未知") },
    ];
  }

  if (section.section === "workflow_graph") {
    const workflowGraph = asRecord(parsed.workflow_graph);
    return [
      {
        label: "Checkpoint",
        value: String(workflowGraph.checkpoint_file ?? "未知"),
      },
    ];
  }

  const sandbox = asRecord(parsed.sandbox);
  return [
    { label: "模式", value: String(sandbox.mode ?? "未知") },
    { label: "镜像", value: String(sandbox.image ?? "未知") },
    { label: "根目录", value: String(sandbox.root_dir ?? "未知") },
  ];
}

export function collectProviderIds(parsed: unknown, draft: string): string[] {
  const ids = new Set(Object.keys(asRecord(asRecord(parsed).providers)));
  let inProviders = false;

  for (const line of draft.split("\n")) {
    if (/^providers:\s*$/.test(line)) {
      inProviders = true;
      continue;
    }

    if (inProviders && /^\S/.test(line)) {
      inProviders = false;
    }

    if (!inProviders) {
      continue;
    }

    const match = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);

    if (match?.[1]) {
      ids.add(match[1]);
    }
  }

  return [...ids];
}

export function collectRepositoryQuickConfigs(
  parsed: unknown,
): RepositoryQuickConfig[] {
  const repositories = asRecord(parsed).repositories;

  if (!Array.isArray(repositories)) {
    return [];
  }

  return repositories.map((entry) => {
    const repository = asRecord(entry);
    const trigger = asRecord(repository.trigger);
    const queue = asRecord(repository.queue);
    return {
      id: String(repository.id ?? ""),
      owner: String(repository.github_owner ?? ""),
      repo: String(repository.github_repo ?? ""),
      projectSkillPath: String(repository.project_skill_path ?? ".agent"),
      projectRulePath: String(repository.project_rule_path ?? ".agent/rules"),
      triggerMode: normalizeTriggerMode(trigger.mode),
      mention: String(trigger.mention ?? "@agent-prd"),
      maxConcurrentIssues: normalizePositiveInteger(
        queue.max_concurrent_issues,
      ),
    };
  });
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeTriggerMode(value: unknown): TriggerMode {
  return triggerModes.includes(value as TriggerMode)
    ? (value as TriggerMode)
    : "manual";
}

export function normalizePositiveInteger(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? Math.floor(numberValue)
    : 1;
}
