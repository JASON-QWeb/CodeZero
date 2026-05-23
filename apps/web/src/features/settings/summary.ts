import { permissionLevels, triggerModes } from "./constants";
import type { ConfigSection, RepositoryQuickConfig, ToolPermissionLevel, TriggerMode } from "./types";

export function buildSummary(section: ConfigSection | undefined): Array<{ label: string; value: string }> {
  if (!section) {
    return [];
  }

  const parsed = asRecord(section.parsed);

  if (section.section === "agents") {
    const providers = Object.keys(asRecord(parsed.providers));
    const agents = asRecord(parsed.agents);
    return [
      { label: "Providers", value: String(providers.length) },
      { label: "Agent Steps", value: String(Object.keys(agents).length) },
      { label: "Routing", value: Object.entries(agents).map(([name, value]) => `${name}:${asRecord(value).provider ?? "?"}`).join(", ") || "none" }
    ];
  }

  if (section.section === "repositories") {
    const repositories = Array.isArray(parsed.repositories) ? parsed.repositories : [];
    return [
      { label: "Repositories", value: String(repositories.length) },
      { label: "Triggers", value: repositories.map((repo) => asRecord(asRecord(repo).trigger).mode).join(", ") || "none" },
      { label: "Queue Limits", value: repositories.map((repo) => String(asRecord(asRecord(repo).queue).max_concurrent_issues ?? 1)).join(", ") || "none" },
      { label: "Quality Gates", value: String(repositories.filter((repo) => Object.keys(asRecord(asRecord(repo).quality_gates)).length > 0).length) },
      { label: "Repo Permissions", value: summarizeRepositoryPermissions(repositories) }
    ];
  }

  if (section.section === "tools") {
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    return [
      { label: "Tools", value: String(tools.length) },
      { label: "Permissions", value: Array.from(new Set(tools.map((tool) => String(asRecord(tool).permission)))).join(", ") || "none" }
    ];
  }

  if (section.section === "policies") {
    const policies = Array.isArray(parsed.policies) ? parsed.policies : [];
    return [
      { label: "Policies", value: String(policies.length) },
      { label: "Actions", value: Array.from(new Set(policies.map((policy) => String(asRecord(policy).action)))).join(", ") || "none" }
    ];
  }

  const sandbox = asRecord(parsed.sandbox);
  return [
    { label: "Mode", value: String(sandbox.mode ?? "unknown") },
    { label: "Image", value: String(sandbox.image ?? "unknown") },
    { label: "Root", value: String(sandbox.root_dir ?? "unknown") }
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

export function collectRepositoryQuickConfigs(parsed: unknown): RepositoryQuickConfig[] {
  const repositories = asRecord(parsed).repositories;

  if (!Array.isArray(repositories)) {
    return [];
  }

  return repositories.map((entry) => {
    const repository = asRecord(entry);
    const trigger = asRecord(repository.trigger);
    const queue = asRecord(repository.queue);
    const permissions = asRecord(repository.permissions);
    return {
      id: String(repository.id ?? ""),
      owner: String(repository.github_owner ?? ""),
      repo: String(repository.github_repo ?? ""),
      triggerMode: normalizeTriggerMode(trigger.mode),
      mention: String(trigger.mention ?? "@agent-prd"),
      maxConcurrentIssues: normalizePositiveInteger(queue.max_concurrent_issues),
      allowedPermissions: normalizePermissionList(permissions.allowed_permissions),
      blockedPermissions: normalizePermissionList(permissions.blocked_permissions)
    };
  });
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function normalizeTriggerMode(value: unknown): TriggerMode {
  return triggerModes.includes(value as TriggerMode) ? (value as TriggerMode) : "manual";
}

export function normalizePositiveInteger(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : 1;
}

export function normalizePermissionList(value: unknown): ToolPermissionLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is ToolPermissionLevel => permissionLevels.includes(item as ToolPermissionLevel));
}

function summarizeRepositoryPermissions(repositories: unknown[]): string {
  const scoped = repositories.filter((repo) => {
    const permissions = asRecord(asRecord(repo).permissions);
    return ["allowed_tools", "blocked_tools", "allowed_permissions", "blocked_permissions"].some((key) => {
      const value = permissions[key];
      return Array.isArray(value) && value.length > 0;
    });
  }).length;

  return scoped > 0 ? `${scoped} scoped` : "global defaults";
}
