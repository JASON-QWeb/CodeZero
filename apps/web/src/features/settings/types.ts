export type ConfigSectionName = "agents" | "repositories" | "sandbox" | "policies" | "tools";

export type ConfigSection = {
  section: ConfigSectionName;
  path: string;
  fallbackPath: string;
  exists: boolean;
  content: string;
  parsed: unknown;
  updatedAt?: string;
};

export type ConfigResponse = {
  rootDir: string;
  sections: ConfigSection[];
};

export type ValidationResponse = {
  section: ConfigSectionName;
  valid: boolean;
  parsed?: unknown;
  message?: string;
};

export type ProviderValidationResponse = {
  providerId: string;
  valid: boolean;
  message: string;
  baseUrl?: string;
  model?: string;
  statusCode?: number;
  latencyMs?: number;
  usedApiKeySource?: "request" | "env" | "missing";
};

export type ProviderApiKeySaveResponse = {
  providerId: string;
  apiKeyEnv?: string;
  saved: boolean;
  message: string;
};

export type TriggerMode = "auto" | "mention" | "label" | "manual" | "disabled";
export type ToolPermissionLevel = "read" | "safe_write" | "repo_write" | "external_write" | "dangerous";

export type RepositoryQuickConfig = {
  id: string;
  owner: string;
  repo: string;
  projectSkillPath: string;
  triggerMode: TriggerMode;
  mention: string;
  maxConcurrentIssues: number;
  allowedPermissions: ToolPermissionLevel[];
  blockedPermissions: ToolPermissionLevel[];
};

export type RepositoryRuntimeSettingsInput = {
  repositoryId: string;
  triggerMode: TriggerMode;
  mention: string;
  maxConcurrentIssues: number;
  projectSkillPath: string;
  allowedPermissions: ToolPermissionLevel[];
  blockedPermissions: ToolPermissionLevel[];
};
