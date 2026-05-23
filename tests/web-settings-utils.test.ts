import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchConfig,
  saveConfig,
  updateRepositoryRuntimeSettings,
  validateConfig,
  validateProviderConnection
} from "../apps/web/src/features/settings/api";
import {
  buildSummary,
  collectProviderIds,
  collectRepositoryQuickConfigs,
  normalizePermissionList,
  normalizePositiveInteger,
  normalizeTriggerMode
} from "../apps/web/src/features/settings/summary";
import type { ConfigSection } from "../apps/web/src/features/settings/types";

describe("web settings utilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  it("builds compact summaries for each config section", () => {
    expect(buildSummary(undefined)).toEqual([]);
    expect(
      buildSummary(section("agents", { providers: { qwen: {} }, agents: { prd: { provider: "qwen" }, review: { provider: "qwen" } } }))
    ).toEqual([
      { label: "Providers", value: "1" },
      { label: "Agent Steps", value: "2" },
      { label: "Routing", value: "prd:qwen, review:qwen" }
    ]);
    expect(buildSummary(section("tools", { tools: [{ permission: "read" }, { permission: "repo_write" }] }))).toContainEqual({
      label: "Permissions",
      value: "read, repo_write"
    });
    expect(buildSummary(section("policies", { policies: [{ action: "block" }, { action: "audit" }] }))).toContainEqual({
      label: "Actions",
      value: "block, audit"
    });
    expect(buildSummary(section("sandbox", { sandbox: { mode: "worktree", image: "node", root_dir: "sandboxes" } }))).toContainEqual({
      label: "Mode",
      value: "worktree"
    });
  });

  it("collects provider ids from parsed config plus in-progress YAML", () => {
    const draft = ["providers:", "  qwen:", "    model: qwen3.5", "  openai.experimental: # staged", "agents: {}"].join("\n");

    expect(collectProviderIds({ providers: { deepseek: {} } }, draft)).toEqual(["deepseek", "qwen", "openai.experimental"]);
  });

  it("normalizes repository quick settings safely", () => {
    const repositories = collectRepositoryQuickConfigs({
      repositories: [
        {
          id: "shop",
          github_owner: "acme",
          github_repo: "shop",
          trigger: { mode: "auto", mention: "@agent" },
          queue: { max_concurrent_issues: "3" },
          permissions: { allowed_permissions: ["read", "bad"], blocked_permissions: ["dangerous"] }
        },
        {
          id: "broken",
          github_owner: "acme",
          github_repo: "broken",
          trigger: { mode: "unknown" },
          queue: { max_concurrent_issues: -1 },
          permissions: {}
        }
      ]
    });

    expect(repositories[0]).toMatchObject({
      triggerMode: "auto",
      maxConcurrentIssues: 3,
      allowedPermissions: ["read"],
      blockedPermissions: ["dangerous"]
    });
    expect(repositories[1]).toMatchObject({
      triggerMode: "manual",
      mention: "@agent-prd",
      maxConcurrentIssues: 1
    });
    expect(normalizeTriggerMode("label")).toBe("label");
    expect(normalizePositiveInteger("2.9")).toBe(2);
    expect(normalizePermissionList("read")).toEqual([]);
  });

  it("calls settings API endpoints and handles validation failures", async () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith("/settings/config") && init?.method === undefined) {
        return ok({ rootDir: "/repo", sections: [] });
      }
      if (url.endsWith("/settings/config/agents/validate")) {
        return { ok: false, json: async () => ({ message: "bad yaml" }) };
      }
      if (url.endsWith("/settings/config/agents") && init?.method === "PUT") {
        return ok(section("agents", {}));
      }
      if (url.endsWith("/settings/providers/validate")) {
        return ok({ providerId: "qwen", valid: true, message: "ok" });
      }
      return ok(section("repositories", {}));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConfig()).resolves.toMatchObject({ rootDir: "/repo" });
    await expect(validateConfig({ section: "agents", content: "bad" })).resolves.toMatchObject({ section: "agents", valid: false });
    await expect(saveConfig({ section: "agents", content: "providers: {}" })).resolves.toMatchObject({ section: "agents" });
    await expect(validateProviderConnection({ providerId: "qwen", content: "providers: {}" })).resolves.toMatchObject({ valid: true });
    await expect(
      updateRepositoryRuntimeSettings({
        repositoryId: "shop repo",
        triggerMode: "label",
        mention: "@agent",
        maxConcurrentIssues: 2,
        allowedPermissions: ["read"],
        blockedPermissions: []
      })
    ).resolves.toMatchObject({ section: "repositories" });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("shop%20repo");
  });

  it("raises clear errors when settings API saves fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ message: "nope" }) })));

    await expect(fetchConfig()).rejects.toThrow("Failed to load settings");
    await expect(saveConfig({ section: "tools", content: "tools: []" })).rejects.toThrow("nope");
    await expect(validateProviderConnection({ providerId: "qwen", content: "" })).resolves.toMatchObject({ valid: false, message: "nope" });
    await expect(
      updateRepositoryRuntimeSettings({
        repositoryId: "shop",
        triggerMode: "manual",
        mention: "@agent",
        maxConcurrentIssues: 1,
        allowedPermissions: [],
        blockedPermissions: []
      })
    ).rejects.toThrow("nope");
  });
});

function section(sectionName: ConfigSection["section"], parsed: unknown): ConfigSection {
  return {
    section: sectionName,
    path: `/config/${sectionName}.yaml`,
    fallbackPath: `/config/${sectionName}.example.yaml`,
    exists: true,
    content: "",
    parsed
  };
}

function ok(body: unknown): { ok: true; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: async () => body
  };
}
