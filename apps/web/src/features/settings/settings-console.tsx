"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Save, SlidersHorizontal } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchConfig, saveConfig, saveProviderApiKey, updateRepositoryRuntimeSettings, validateConfig, validateProviderConnection } from "./api";
import { orderedSections, permissionLevels, triggerModes } from "./constants";
import { sectionMeta } from "./section-meta";
import { buildSummary, collectProviderIds, collectRepositoryQuickConfigs } from "./summary";
import type {
  ConfigSectionName,
  ProviderValidationResponse,
  ProviderApiKeySaveResponse,
  RepositoryQuickConfig,
  RepositoryRuntimeSettingsInput,
  ToolPermissionLevel,
  TriggerMode,
  ValidationResponse
} from "./types";

export function SettingsConsole() {
  const queryClient = useQueryClient();
  const [selectedSection, setSelectedSection] = useState<ConfigSectionName>("agents");
  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState<ValidationResponse | undefined>();
  const [providerId, setProviderId] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
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
  const providerTestMutation = useMutation({
    mutationFn: validateProviderConnection
  });
  const providerKeyMutation = useMutation({
    mutationFn: saveProviderApiKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings-config"] });
    }
  });
  const repositoryRuntimeMutation = useMutation({
    mutationFn: updateRepositoryRuntimeSettings,
    onSuccess: async (section) => {
      setDraft(section.content);
      setValidation({ section: section.section, valid: true, parsed: section.parsed });
      await queryClient.invalidateQueries({ queryKey: ["settings-config"] });
      await queryClient.invalidateQueries({ queryKey: ["task-repositories"] });
    }
  });
  const sections = configQuery.data?.sections ?? [];
  const selected = sections.find((section) => section.section === selectedSection);
  const summary = useMemo(() => buildSummary(selected), [selected]);
  const providerIds = useMemo(() => (selected?.section === "agents" ? collectProviderIds(selected.parsed, draft) : []), [draft, selected?.parsed, selected?.section]);
  const repositories = useMemo(() => (selected?.section === "repositories" ? collectRepositoryQuickConfigs(selected.parsed) : []), [selected?.parsed, selected?.section]);

  useEffect(() => {
    if (selected) {
      setDraft(selected.content);
      setValidation(undefined);
    }
  }, [selected?.section, selected?.content]);

  useEffect(() => {
    if (selected?.section !== "agents") {
      return;
    }

    if (providerIds.length > 0 && !providerIds.includes(providerId)) {
      setProviderId(providerIds[0] ?? "");
    }
  }, [providerId, providerIds, selected?.section]);

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
                <small>{current?.exists ? "configured" : "template"}</small>
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
                  <span>{selected.exists ? selected.path : `Template: ${selected.templatePath}`}</span>
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

              {selected.section === "agents" ? (
                <ProviderConnectionTest
                  apiKey={providerApiKey}
                  isPending={providerTestMutation.isPending}
                  onApiKeyChange={(value) => {
                    setProviderApiKey(value);
                    providerTestMutation.reset();
                    providerKeyMutation.reset();
                  }}
                  onProviderChange={(value) => {
                    setProviderId(value);
                    providerTestMutation.reset();
                    providerKeyMutation.reset();
                  }}
                  onSaveApiKey={() =>
                    providerKeyMutation.mutate({
                      content: draft,
                      providerId,
                      apiKey: providerApiKey.trim()
                    })
                  }
                  onTest={() =>
                    providerTestMutation.mutate({
                      content: draft,
                      providerId,
                      apiKey: providerApiKey.trim() || undefined
                    })
                  }
                  providerId={providerId}
                  providerIds={providerIds}
                  result={providerTestMutation.data}
                  savePending={providerKeyMutation.isPending}
                  saveResult={providerKeyMutation.data}
                />
              ) : null}

              {selected.section === "repositories" ? (
                <RepositoryQuickSettings
                  errorMessage={repositoryRuntimeMutation.error instanceof Error ? repositoryRuntimeMutation.error.message : undefined}
                  isPending={repositoryRuntimeMutation.isPending}
                  onSave={(input) => repositoryRuntimeMutation.mutate(input)}
                  repositories={repositories}
                />
              ) : null}

              <textarea
                className="yamlEditor"
                onChange={(event) => {
                  setDraft(event.target.value);
                  setValidation(undefined);
                  providerTestMutation.reset();
                  providerKeyMutation.reset();
                  repositoryRuntimeMutation.reset();
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

function ProviderConnectionTest({
  apiKey,
  isPending,
  onApiKeyChange,
  onProviderChange,
  onSaveApiKey,
  onTest,
  providerId,
  providerIds,
  result,
  savePending,
  saveResult
}: {
  apiKey: string;
  isPending: boolean;
  onApiKeyChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onSaveApiKey: () => void;
  onTest: () => void;
  providerId: string;
  providerIds: string[];
  result?: ProviderValidationResponse;
  savePending: boolean;
  saveResult?: ProviderApiKeySaveResponse;
}) {
  return (
    <div className="providerVerifier" aria-label="Provider connection test">
      <div>
        <h3>Provider Connection Test</h3>
        <span>Use a one-time key here, or leave it empty to use the provider's api_key_env on the API server.</span>
      </div>
      <div className="providerVerifierControls">
        <label>
          <span>Provider</span>
          <select disabled={providerIds.length === 0} onChange={(event) => onProviderChange(event.target.value)} value={providerId}>
            {providerIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>One-time API key</span>
          <input
            autoComplete="off"
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder="Optional"
            type="password"
            value={apiKey}
          />
        </label>
        <button className="iconButton neutral" disabled={providerIds.length === 0 || !providerId || isPending} onClick={onTest} type="button">
          <CheckCircle2 size={16} aria-hidden />
          <span>{isPending ? "Testing" : "Test"}</span>
        </button>
        <button className="iconButton positive" disabled={providerIds.length === 0 || !providerId || !apiKey.trim() || savePending} onClick={onSaveApiKey} type="button">
          <Save size={16} aria-hidden />
          <span>{savePending ? "Saving" : "Save Key"}</span>
        </button>
      </div>
      <div className={`validationBar ${result?.valid || saveResult?.saved ? "validationGood" : result || saveResult ? "validationBad" : ""}`}>
        {saveResult ? (
          <>
            {saveResult.saved ? <CheckCircle2 size={16} aria-hidden /> : <AlertCircle size={16} aria-hidden />}
            <span>{saveResult.message}</span>
          </>
        ) : result ? (
          <>
            {result.valid ? <CheckCircle2 size={16} aria-hidden /> : <AlertCircle size={16} aria-hidden />}
            <span>
              {result.message}
              {result.model && result.latencyMs !== undefined ? ` Model: ${result.model}. Latency: ${result.latencyMs}ms.` : ""}
            </span>
          </>
        ) : (
          <span>Provider test sends one minimal chat completion request and never saves the one-time key.</span>
        )}
      </div>
    </div>
  );
}

function RepositoryQuickSettings({
  errorMessage,
  isPending,
  onSave,
  repositories
}: {
  errorMessage?: string;
  isPending: boolean;
  onSave: (input: RepositoryRuntimeSettingsInput) => void;
  repositories: RepositoryQuickConfig[];
}) {
  return (
    <div className="repositoryQuickEditor" aria-label="Repository quick settings">
      <div className="repositoryQuickHeader">
        <div>
          <h3>Repository Quick Settings</h3>
          <span>{repositories.length} repositories</span>
        </div>
        {errorMessage ? (
          <span className="quickSettingsError">
            <AlertCircle size={14} aria-hidden />
            {errorMessage}
          </span>
        ) : null}
      </div>
      <div className="repositoryQuickList">
        {repositories.map((repository) => (
          <RepositoryQuickSettingsItem isPending={isPending} key={repository.id} onSave={onSave} repository={repository} />
        ))}
      </div>
    </div>
  );
}

function RepositoryQuickSettingsItem({
  isPending,
  onSave,
  repository
}: {
  isPending: boolean;
  onSave: (input: RepositoryRuntimeSettingsInput) => void;
  repository: RepositoryQuickConfig;
}) {
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(repository.triggerMode);
  const [mention, setMention] = useState(repository.mention);
  const [maxConcurrentIssues, setMaxConcurrentIssues] = useState(String(repository.maxConcurrentIssues));
  const [projectSkillPath, setProjectSkillPath] = useState(repository.projectSkillPath);
  const [allowedPermissions, setAllowedPermissions] = useState<ToolPermissionLevel[]>(repository.allowedPermissions);
  const [blockedPermissions, setBlockedPermissions] = useState<ToolPermissionLevel[]>(repository.blockedPermissions);

  useEffect(() => {
    setTriggerMode(repository.triggerMode);
    setMention(repository.mention);
    setMaxConcurrentIssues(String(repository.maxConcurrentIssues));
    setProjectSkillPath(repository.projectSkillPath);
    setAllowedPermissions(repository.allowedPermissions);
    setBlockedPermissions(repository.blockedPermissions);
  }, [repository]);

  return (
    <article className="repositoryQuickItem">
      <div className="repositoryQuickTitle">
        <strong>{repository.id}</strong>
        <span>
          {repository.owner}/{repository.repo}
        </span>
      </div>

      <div className="repositoryQuickControls">
        <label>
          <span>Trigger</span>
          <select onChange={(event) => setTriggerMode(event.target.value as TriggerMode)} value={triggerMode}>
            {triggerModes.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Mention</span>
          <input onChange={(event) => setMention(event.target.value)} type="text" value={mention} />
        </label>

        <label>
          <span>Max Running</span>
          <input min={1} onChange={(event) => setMaxConcurrentIssues(event.target.value)} step={1} type="number" value={maxConcurrentIssues} />
        </label>

        <label>
          <span>Skill Path</span>
          <input onChange={(event) => setProjectSkillPath(event.target.value)} type="text" value={projectSkillPath} />
        </label>
      </div>

      <PermissionChecklist label="Allowed Permissions" onChange={setAllowedPermissions} selected={allowedPermissions} />
      <PermissionChecklist label="Blocked Permissions" onChange={setBlockedPermissions} selected={blockedPermissions} />

      <div className="repositoryQuickActions">
        <button
          className="iconButton positive"
          disabled={isPending || !Number.isFinite(Number(maxConcurrentIssues)) || Number(maxConcurrentIssues) < 1 || !mention.trim() || !projectSkillPath.trim()}
          onClick={() =>
            onSave({
              repositoryId: repository.id,
              triggerMode,
              mention: mention.trim(),
              maxConcurrentIssues: Math.max(1, Math.floor(Number(maxConcurrentIssues))),
              projectSkillPath: projectSkillPath.trim(),
              allowedPermissions,
              blockedPermissions
            })
          }
          type="button"
        >
          <Save size={16} aria-hidden />
          <span>{isPending ? "Saving" : "Save Repo"}</span>
        </button>
      </div>
    </article>
  );
}

function PermissionChecklist({
  label,
  onChange,
  selected
}: {
  label: string;
  onChange: (value: ToolPermissionLevel[]) => void;
  selected: ToolPermissionLevel[];
}) {
  return (
    <fieldset className="permissionChecklist">
      <legend>{label}</legend>
      <div>
        {permissionLevels.map((permission) => {
          const checked = selected.includes(permission);
          return (
            <label key={permission}>
              <input
                checked={checked}
                onChange={(event) => {
                  onChange(event.target.checked ? [...selected, permission] : selected.filter((item) => item !== permission));
                }}
                type="checkbox"
              />
              <span>{permission}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
