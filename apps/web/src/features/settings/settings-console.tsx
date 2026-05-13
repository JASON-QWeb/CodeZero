"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Bot, CheckCircle2, GitBranch, Save, Server, Shield, SlidersHorizontal, Wrench } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type ConfigSectionName = "agents" | "repositories" | "sandbox" | "policies" | "tools";

type ConfigSection = {
  section: ConfigSectionName;
  path: string;
  fallbackPath: string;
  exists: boolean;
  content: string;
  parsed: unknown;
  updatedAt?: string;
};

type ConfigResponse = {
  rootDir: string;
  sections: ConfigSection[];
};

type ValidationResponse = {
  section: ConfigSectionName;
  valid: boolean;
  parsed?: unknown;
  message?: string;
};

const sectionMeta: Record<ConfigSectionName, { title: string; icon: React.ReactNode; description: string }> = {
  agents: {
    title: "Model Providers & Agents",
    icon: <Bot size={18} aria-hidden />,
    description: "Configure DeepSeek, Qwen, OpenAI-compatible providers and choose which provider each workflow step uses."
  },
  repositories: {
    title: "GitHub Repositories",
    icon: <GitBranch size={18} aria-hidden />,
    description: "Configure repository trigger mode, quality gates, frontend screenshots and PR behavior."
  },
  tools: {
    title: "Tool Permissions",
    icon: <Wrench size={18} aria-hidden />,
    description: "Configure tool permissions and timeout boundaries used by Tool Gateway."
  },
  policies: {
    title: "Policy Guardrails",
    icon: <Shield size={18} aria-hidden />,
    description: "Configure path, command, tool and permission policies for block or approval decisions."
  },
  sandbox: {
    title: "Sandbox Runtime",
    icon: <Server size={18} aria-hidden />,
    description: "Configure Docker/worktree sandbox mode, image, network allowlist and runtime limits."
  }
};

const orderedSections: ConfigSectionName[] = ["agents", "repositories", "tools", "policies", "sandbox"];
const apiBaseUrl = () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function fetchConfig(): Promise<ConfigResponse> {
  const response = await fetch(`${apiBaseUrl()}/settings/config`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load settings");
  }

  return (await response.json()) as ConfigResponse;
}

async function validateConfig(input: { section: ConfigSectionName; content: string }): Promise<ValidationResponse> {
  const response = await fetch(`${apiBaseUrl()}/settings/config/${input.section}/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: input.content })
  });
  const body = (await response.json()) as ValidationResponse;

  if (!response.ok) {
    return { ...body, section: input.section, valid: false };
  }

  return body;
}

async function saveConfig(input: { section: ConfigSectionName; content: string }): Promise<ConfigSection> {
  const response = await fetch(`${apiBaseUrl()}/settings/config/${input.section}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: input.content })
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "Failed to save config");
  }

  return (await response.json()) as ConfigSection;
}

export function SettingsConsole() {
  const queryClient = useQueryClient();
  const [selectedSection, setSelectedSection] = useState<ConfigSectionName>("agents");
  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState<ValidationResponse | undefined>();
  const configQuery = useQuery({
    queryKey: ["settings-config"],
    queryFn: fetchConfig,
    refetchInterval: false,
    retry: 1
  });
  const validateMutation = useMutation({
    mutationFn: validateConfig,
    onSuccess: setValidation
  });
  const saveMutation = useMutation({
    mutationFn: saveConfig,
    onSuccess: async (section) => {
      setValidation({ section: section.section, valid: true, parsed: section.parsed });
      await queryClient.invalidateQueries({ queryKey: ["settings-config"] });
    }
  });
  const sections = configQuery.data?.sections ?? [];
  const selected = sections.find((section) => section.section === selectedSection);
  const summary = useMemo(() => buildSummary(selected), [selected]);

  useEffect(() => {
    if (selected) {
      setDraft(selected.content);
      setValidation(undefined);
    }
  }, [selected?.section, selected?.content]);

  return (
    <section className="settingsShell" aria-label="Configuration center">
      <div className="settingsTopline">
        <div>
          <p className="eyebrow">Configuration Center</p>
          <h1>Settings Console</h1>
          <span>{configQuery.data ? configQuery.data.rootDir : "Connect API to edit runtime configuration"}</span>
        </div>
        <div className={`settingsHealth ${configQuery.isError ? "settingsBad" : "settingsGood"}`}>
          {configQuery.isError ? <AlertCircle size={18} aria-hidden /> : <SlidersHorizontal size={18} aria-hidden />}
          <span>{configQuery.isError ? "Settings API offline" : "Editable YAML config"}</span>
        </div>
      </div>

      <div className="settingsGrid">
        <nav className="settingsNav" aria-label="Settings sections">
          {orderedSections.map((section) => {
            const meta = sectionMeta[section];
            const current = sections.find((item) => item.section === section);
            return (
              <button
                className={`settingsNavItem ${selectedSection === section ? "settingsNavItemActive" : ""}`}
                key={section}
                onClick={() => setSelectedSection(section)}
                type="button"
              >
                <span>{meta.icon}</span>
                <strong>{meta.title}</strong>
                <small>{current?.exists ? "configured" : "example fallback"}</small>
              </button>
            );
          })}
        </nav>

        <section className="settingsEditor" aria-label="Settings editor">
          {selected ? (
            <>
              <div className="editorHeader">
                <div>
                  <h2>{sectionMeta[selected.section].title}</h2>
                  <p>{sectionMeta[selected.section].description}</p>
                  <span>{selected.exists ? selected.path : `Using fallback ${selected.fallbackPath}`}</span>
                </div>
                <div className="editorActions">
                  <button
                    className="iconButton neutral"
                    disabled={validateMutation.isPending}
                    onClick={() => validateMutation.mutate({ section: selected.section, content: draft })}
                    type="button"
                  >
                    <CheckCircle2 size={16} aria-hidden />
                    <span>Validate</span>
                  </button>
                  <button
                    className="iconButton positive"
                    disabled={saveMutation.isPending}
                    onClick={() => saveMutation.mutate({ section: selected.section, content: draft })}
                    type="button"
                  >
                    <Save size={16} aria-hidden />
                    <span>Save</span>
                  </button>
                </div>
              </div>

              <div className="settingsSummary" aria-label="Parsed summary">
                {summary.map((item) => (
                  <div key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>

              <textarea
                className="yamlEditor"
                onChange={(event) => {
                  setDraft(event.target.value);
                  setValidation(undefined);
                }}
                spellCheck={false}
                value={draft}
              />

              <div className={`validationBar ${validation?.valid ? "validationGood" : validation ? "validationBad" : ""}`}>
                {validation ? (
                  <>
                    {validation.valid ? <CheckCircle2 size={16} aria-hidden /> : <AlertCircle size={16} aria-hidden />}
                    <span>{validation.valid ? "Config is valid and ready to save." : validation.message ?? "Config validation failed."}</span>
                  </>
                ) : (
                  <span>Validate before saving when changing model routing, repositories, tools or policies.</span>
                )}
              </div>
            </>
          ) : (
            <div className="emptyState">Settings API is unavailable</div>
          )}
        </section>
      </div>
    </section>
  );
}

function buildSummary(section: ConfigSection | undefined): Array<{ label: string; value: string }> {
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
