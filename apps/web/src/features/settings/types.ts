export type ConfigSectionName =
  | "agents"
  | "repositories"
  | "sandbox"
  | "memory"
  | "workflow_graph";

export type ConfigSection = {
  section: ConfigSectionName;
  path: string;
  templatePath: string;
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

export type RepositoryQuickConfig = {
  id: string;
  owner: string;
  repo: string;
  projectSkillPath: string;
  projectRulePath: string;
  triggerMode: TriggerMode;
  mention: string;
  maxConcurrentIssues: number;
};

export type RepositoryRuntimeSettingsInput = {
  repositoryId: string;
  triggerMode: TriggerMode;
  mention: string;
  maxConcurrentIssues: number;
  projectSkillPath: string;
  projectRulePath: string;
};
