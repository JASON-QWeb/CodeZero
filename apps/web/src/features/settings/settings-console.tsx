"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchConfig,
  saveConfig,
  saveProviderApiKey,
  updateRepositoryRuntimeSettings,
  validateConfig,
  validateProviderConnection,
} from "./api";
import { orderedSections, permissionLevels, triggerModes } from "./constants";
import {
  applyProviderPresetToAgentsYaml,
  providerPresets,
  type ProviderPreset,
} from "./provider-presets";
import { sectionMeta } from "./section-meta";
import {
  buildSummary,
  collectProviderIds,
  collectRepositoryQuickConfigs,
} from "./summary";
import type {
  ConfigSectionName,
  ProviderValidationResponse,
  ProviderApiKeySaveResponse,
  RepositoryQuickConfig,
  RepositoryRuntimeSettingsInput,
  ToolPermissionLevel,
  TriggerMode,
  ValidationResponse,
} from "./types";

const triggerModeLabels: Record<TriggerMode, string> = {
  auto: "自动",
  mention: "提及触发",
  label: "标签触发",
  manual: "手动",
  disabled: "停用",
};

const permissionLevelLabels: Record<ToolPermissionLevel, string> = {
  read: "读取",
  safe_write: "安全写入",
  repo_write: "仓库写入",
  external_write: "外部写入",
  dangerous: "高风险",
};

type SettingsConsoleProps = {
  description?: string;
  initialSection?: ConfigSectionName;
  showTopline?: boolean;
  title?: string;
  visibleSections?: ConfigSectionName[];
};

export function SettingsConsole({
  description,
  initialSection,
  showTopline = true,
  title = "设置控制台",
  visibleSections,
}: SettingsConsoleProps = {}) {
  const queryClient = useQueryClient();
  const availableSections = useMemo(() => {
    if (!visibleSections || visibleSections.length === 0) {
      return orderedSections;
    }

    const allowed = new Set(visibleSections);
    return orderedSections.filter((section) => allowed.has(section));
  }, [visibleSections]);
  const [selectedSection, setSelectedSection] = useState<ConfigSectionName>(
    initialSection ?? availableSections[0] ?? "agents",
  );
  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState<
    ValidationResponse | undefined
  >();
  const [providerId, setProviderId] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const configQuery = useQuery({
    queryKey: ["settings-config"],
    queryFn: fetchConfig,
    refetchInterval: false,
    retry: 1,
  });
  const validateMutation = useMutation({
    mutationFn: validateConfig,
    onSuccess: setValidation,
  });
  const saveMutation = useMutation({
    mutationFn: saveConfig,
    onSuccess: async (section) => {
      setValidation({
        section: section.section,
        valid: true,
        parsed: section.parsed,
      });
      await queryClient.invalidateQueries({ queryKey: ["settings-config"] });
    },
  });
  const providerTestMutation = useMutation({
    mutationFn: validateProviderConnection,
  });
  const providerKeyMutation = useMutation({
    mutationFn: saveProviderApiKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings-config"] });
    },
  });
  const repositoryRuntimeMutation = useMutation({
    mutationFn: updateRepositoryRuntimeSettings,
    onSuccess: async (section) => {
      setDraft(section.content);
      setValidation({
        section: section.section,
        valid: true,
        parsed: section.parsed,
      });
      await queryClient.invalidateQueries({ queryKey: ["settings-config"] });
      await queryClient.invalidateQueries({ queryKey: ["task-repositories"] });
    },
  });
  const sections = configQuery.data?.sections ?? [];
  const selected = sections.find(
    (section) => section.section === selectedSection,
  );
  const summary = useMemo(() => buildSummary(selected), [selected]);
  const providerIds = useMemo(
    () =>
      selected?.section === "agents"
        ? collectProviderIds(selected.parsed, draft)
        : [],
    [draft, selected?.parsed, selected?.section],
  );
  const repositories = useMemo(
    () =>
      selected?.section === "repositories"
        ? collectRepositoryQuickConfigs(selected.parsed)
        : [],
    [selected?.parsed, selected?.section],
  );

  useEffect(() => {
    const fallback = availableSections.includes(initialSection ?? "agents")
      ? (initialSection ?? "agents")
      : availableSections[0];

    if (fallback && !availableSections.includes(selectedSection)) {
      setSelectedSection(fallback);
    }
  }, [availableSections, initialSection, selectedSection]);

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
    <section className="settingsShell" aria-label="配置中心">
      {showTopline ? (
        <div className="settingsTopline">
          <div>
            <p className="eyebrow">配置中心</p>
            <h1>{title}</h1>
            <span>
              {description ??
                (configQuery.data
                  ? configQuery.data.rootDir
                  : "连接 API 后可编辑运行时配置")}
            </span>
            {description ? (
              <span>
                {configQuery.data
                  ? configQuery.data.rootDir
                  : "连接 API 后可编辑运行时配置"}
              </span>
            ) : null}
          </div>
          <div
            className={`settingsHealth ${configQuery.isError ? "settingsBad" : "settingsGood"}`}
          >
            {configQuery.isError ? (
              <AlertCircle size={18} aria-hidden />
            ) : (
              <SlidersHorizontal size={18} aria-hidden />
            )}
            <span>
              {configQuery.isError ? "设置 API 离线" : "可编辑 YAML 配置"}
            </span>
          </div>
        </div>
      ) : null}

      <div className="settingsGrid">
        <nav className="settingsNav" aria-label="设置分区">
          {availableSections.map((section) => {
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
                <small>{current?.exists ? "已配置" : "模板"}</small>
              </button>
            );
          })}
        </nav>

        <section className="settingsEditor" aria-label="设置编辑器">
          {selected ? (
            <>
              <div className="editorHeader">
                <div>
                  <h2>{sectionMeta[selected.section].title}</h2>
                  <p>{sectionMeta[selected.section].description}</p>
                  <span>
                    {selected.exists
                      ? selected.path
                      : `模板：${selected.templatePath}`}
                  </span>
                </div>
                <div className="editorActions">
                  <button
                    className="iconButton neutral"
                    disabled={validateMutation.isPending}
                    onClick={() =>
                      validateMutation.mutate({
                        section: selected.section,
                        content: draft,
                      })
                    }
                    type="button"
                  >
                    <CheckCircle2 size={16} aria-hidden />
                    <span>校验</span>
                  </button>
                  <button
                    className="iconButton positive"
                    disabled={saveMutation.isPending}
                    onClick={() =>
                      saveMutation.mutate({
                        section: selected.section,
                        content: draft,
                      })
                    }
                    type="button"
                  >
                    <Save size={16} aria-hidden />
                    <span>保存</span>
                  </button>
                </div>
              </div>

              <div className="settingsSummary" aria-label="配置摘要">
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
                  onProviderPresetChange={(preset) => {
                    const nextDraft = applyProviderPresetToAgentsYaml(
                      draft,
                      preset,
                      providerId || "default",
                    );
                    setDraft(nextDraft);
                    setProviderId(providerId || "default");
                    setProviderApiKey("");
                    setValidation(undefined);
                    providerTestMutation.reset();
                    providerKeyMutation.reset();
                  }}
                  onSaveApiKey={() =>
                    providerKeyMutation.mutate({
                      content: draft,
                      providerId,
                      apiKey: providerApiKey.trim(),
                    })
                  }
                  onTest={() =>
                    providerTestMutation.mutate({
                      content: draft,
                      providerId,
                      apiKey: providerApiKey.trim() || undefined,
                    })
                  }
                  onSaveProvider={() =>
                    saveMutation.mutate(
                      { section: "agents", content: draft },
                      {
                        onSuccess: () => {
                          if (providerApiKey.trim()) {
                            providerKeyMutation.mutate({
                              content: draft,
                              providerId,
                              apiKey: providerApiKey.trim(),
                            });
                          }
                        },
                      },
                    )
                  }
                  providerId={providerId}
                  providerIds={providerIds}
                  result={providerTestMutation.data}
                  saveConfigPending={saveMutation.isPending}
                  savePending={providerKeyMutation.isPending}
                  saveResult={providerKeyMutation.data}
                />
              ) : null}

              {selected.section === "repositories" ? (
                <RepositoryQuickSettings
                  errorMessage={
                    repositoryRuntimeMutation.error instanceof Error
                      ? repositoryRuntimeMutation.error.message
                      : undefined
                  }
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

              <div
                className={`validationBar ${validation?.valid ? "validationGood" : validation ? "validationBad" : ""}`}
              >
                {validation ? (
                  <>
                    {validation.valid ? (
                      <CheckCircle2 size={16} aria-hidden />
                    ) : (
                      <AlertCircle size={16} aria-hidden />
                    )}
                    <span>
                      {validation.valid
                        ? "配置已通过校验，可以保存。"
                        : (validation.message ?? "配置校验失败。")}
                    </span>
                  </>
                ) : (
                  <span>
                    修改模型路由、仓库、工具或策略后，建议先校验再保存。
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="emptyState">设置 API 不可用</div>
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
  onProviderPresetChange,
  onSaveApiKey,
  onSaveProvider,
  onTest,
  providerId,
  providerIds,
  result,
  saveConfigPending,
  savePending,
  saveResult,
}: {
  apiKey: string;
  isPending: boolean;
  onApiKeyChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onProviderPresetChange: (preset: ProviderPreset) => void;
  onSaveApiKey: () => void;
  onSaveProvider: () => void;
  onTest: () => void;
  providerId: string;
  providerIds: string[];
  result?: ProviderValidationResponse;
  saveConfigPending: boolean;
  savePending: boolean;
  saveResult?: ProviderApiKeySaveResponse;
}) {
  return (
    <div className="providerVerifier" aria-label="供应商连接测试">
      <div>
        <h3>供应商连接测试</h3>
        <span>
          可临时输入一次性 Key；留空时会使用 API 服务端 provider.api_key_env
          指向的环境变量。
        </span>
      </div>
      <div className="providerVerifierControls">
        <label>
          <span>服务</span>
          <select
            onChange={(event) => {
              const preset = providerPresets.find(
                (item) => item.id === event.target.value,
              );

              if (preset) {
                onProviderPresetChange(preset);
              }
            }}
            defaultValue=""
          >
            <option disabled value="">
              选择供应商
            </option>
            {providerPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>供应商 ID</span>
          <select
            disabled={providerIds.length === 0}
            onChange={(event) => onProviderChange(event.target.value)}
            value={providerId}
          >
            {providerIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>一次性 API Key</span>
          <input
            autoComplete="off"
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder="可选"
            type="password"
            value={apiKey}
          />
        </label>
        <button
          className="iconButton neutral"
          disabled={providerIds.length === 0 || !providerId || isPending}
          onClick={onTest}
          type="button"
        >
          <CheckCircle2 size={16} aria-hidden />
          <span>{isPending ? "测试中" : "测试"}</span>
        </button>
        <button
          className="iconButton positive"
          disabled={
            providerIds.length === 0 ||
            !providerId ||
            !apiKey.trim() ||
            savePending
          }
          onClick={onSaveApiKey}
          type="button"
        >
          <Save size={16} aria-hidden />
          <span>{savePending ? "保存中" : "保存 Key"}</span>
        </button>
        <button
          className="iconButton positive"
          disabled={
            providerIds.length === 0 ||
            !providerId ||
            saveConfigPending ||
            savePending
          }
          onClick={onSaveProvider}
          type="button"
        >
          <Save size={16} aria-hidden />
          <span>
            {saveConfigPending || savePending ? "保存中" : "保存供应商"}
          </span>
        </button>
      </div>
      <div
        className={`validationBar ${result?.valid || saveResult?.saved ? "validationGood" : result || saveResult ? "validationBad" : ""}`}
      >
        {saveResult ? (
          <>
            {saveResult.saved ? (
              <CheckCircle2 size={16} aria-hidden />
            ) : (
              <AlertCircle size={16} aria-hidden />
            )}
            <span>{saveResult.message}</span>
          </>
        ) : result ? (
          <>
            {result.valid ? (
              <CheckCircle2 size={16} aria-hidden />
            ) : (
              <AlertCircle size={16} aria-hidden />
            )}
            <span>
              {result.message}
              {result.model && result.latencyMs !== undefined
                ? ` 模型：${result.model}。延迟：${result.latencyMs}ms。`
                : ""}
            </span>
          </>
        ) : (
          <span>连接测试只发送一次最小聊天补全请求，不会保存一次性 Key。</span>
        )}
      </div>
    </div>
  );
}

function RepositoryQuickSettings({
  errorMessage,
  isPending,
  onSave,
  repositories,
}: {
  errorMessage?: string;
  isPending: boolean;
  onSave: (input: RepositoryRuntimeSettingsInput) => void;
  repositories: RepositoryQuickConfig[];
}) {
  return (
    <div className="repositoryQuickEditor" aria-label="仓库快捷设置">
      <div className="repositoryQuickHeader">
        <div>
          <h3>仓库快捷设置</h3>
          <span>{repositories.length} 个仓库</span>
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
          <RepositoryQuickSettingsItem
            isPending={isPending}
            key={repository.id}
            onSave={onSave}
            repository={repository}
          />
        ))}
      </div>
    </div>
  );
}

function RepositoryQuickSettingsItem({
  isPending,
  onSave,
  repository,
}: {
  isPending: boolean;
  onSave: (input: RepositoryRuntimeSettingsInput) => void;
  repository: RepositoryQuickConfig;
}) {
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(
    repository.triggerMode,
  );
  const [mention, setMention] = useState(repository.mention);
  const [maxConcurrentIssues, setMaxConcurrentIssues] = useState(
    String(repository.maxConcurrentIssues),
  );
  const [projectSkillPath, setProjectSkillPath] = useState(
    repository.projectSkillPath,
  );
  const [projectRulePath, setProjectRulePath] = useState(
    repository.projectRulePath,
  );
  const [allowedPermissions, setAllowedPermissions] = useState<
    ToolPermissionLevel[]
  >(repository.allowedPermissions);
  const [blockedPermissions, setBlockedPermissions] = useState<
    ToolPermissionLevel[]
  >(repository.blockedPermissions);

  useEffect(() => {
    setTriggerMode(repository.triggerMode);
    setMention(repository.mention);
    setMaxConcurrentIssues(String(repository.maxConcurrentIssues));
    setProjectSkillPath(repository.projectSkillPath);
    setProjectRulePath(repository.projectRulePath);
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
          <span>触发方式</span>
          <select
            onChange={(event) =>
              setTriggerMode(event.target.value as TriggerMode)
            }
            value={triggerMode}
          >
            {triggerModes.map((mode) => (
              <option key={mode} value={mode}>
                {triggerModeLabels[mode]}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>提及触发词</span>
          <input
            onChange={(event) => setMention(event.target.value)}
            type="text"
            value={mention}
          />
        </label>

        <label>
          <span>最大并发</span>
          <input
            min={1}
            onChange={(event) => setMaxConcurrentIssues(event.target.value)}
            step={1}
            type="number"
            value={maxConcurrentIssues}
          />
        </label>

        <label>
          <span>Skill 路径</span>
          <input
            onChange={(event) => setProjectSkillPath(event.target.value)}
            type="text"
            value={projectSkillPath}
          />
        </label>

        <label>
          <span>Rule 路径</span>
          <input
            onChange={(event) => setProjectRulePath(event.target.value)}
            type="text"
            value={projectRulePath}
          />
        </label>
      </div>

      <PermissionChecklist
        label="允许权限"
        onChange={setAllowedPermissions}
        selected={allowedPermissions}
      />
      <PermissionChecklist
        label="阻止权限"
        onChange={setBlockedPermissions}
        selected={blockedPermissions}
      />

      <div className="repositoryQuickActions">
        <button
          className="iconButton positive"
          disabled={
            isPending ||
            !Number.isFinite(Number(maxConcurrentIssues)) ||
            Number(maxConcurrentIssues) < 1 ||
            !mention.trim() ||
            !projectSkillPath.trim() ||
            !projectRulePath.trim()
          }
          onClick={() =>
            onSave({
              repositoryId: repository.id,
              triggerMode,
              mention: mention.trim(),
              maxConcurrentIssues: Math.max(
                1,
                Math.floor(Number(maxConcurrentIssues)),
              ),
              projectSkillPath: projectSkillPath.trim(),
              projectRulePath: projectRulePath.trim(),
              allowedPermissions,
              blockedPermissions,
            })
          }
          type="button"
        >
          <Save size={16} aria-hidden />
          <span>{isPending ? "保存中" : "保存仓库"}</span>
        </button>
      </div>
    </article>
  );
}

function PermissionChecklist({
  label,
  onChange,
  selected,
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
                  onChange(
                    event.target.checked
                      ? [...selected, permission]
                      : selected.filter((item) => item !== permission),
                  );
                }}
                type="checkbox"
              />
              <span>{permissionLevelLabels[permission]}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
