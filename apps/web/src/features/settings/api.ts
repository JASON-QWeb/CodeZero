import type {
  ConfigResponse,
  ConfigSection,
  ConfigSectionName,
  ProviderApiKeySaveResponse,
  ProviderValidationResponse,
  RepositoryRuntimeSettingsInput,
  ValidationResponse,
} from "./types";
import { isDemoMode } from "../demo-mode";
import {
  demoFetchConfig,
  demoSaveConfig,
  demoSaveProviderApiKey,
  demoUpdateRepositoryRuntimeSettings,
  demoValidateConfig,
  demoValidateProviderConnection,
} from "./mock-data";

export const apiBaseUrl = () =>
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function fetchConfig(): Promise<ConfigResponse> {
  if (isDemoMode()) {
    return demoFetchConfig();
  }

  const response = await fetch(`${apiBaseUrl()}/settings/config`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("设置加载失败");
  }

  return (await response.json()) as ConfigResponse;
}

export async function validateConfig(input: {
  section: ConfigSectionName;
  content: string;
}): Promise<ValidationResponse> {
  if (isDemoMode()) {
    return demoValidateConfig(input);
  }

  const response = await fetch(
    `${apiBaseUrl()}/settings/config/${input.section}/validate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: input.content }),
    },
  );
  const body = (await response.json()) as ValidationResponse;

  if (!response.ok) {
    return { ...body, section: input.section, valid: false };
  }

  return body;
}

export async function saveConfig(input: {
  section: ConfigSectionName;
  content: string;
}): Promise<ConfigSection> {
  if (isDemoMode()) {
    return demoSaveConfig(input);
  }

  const response = await fetch(
    `${apiBaseUrl()}/settings/config/${input.section}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: input.content }),
    },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(body.message ?? "配置保存失败");
  }

  return (await response.json()) as ConfigSection;
}

export async function validateProviderConnection(input: {
  content: string;
  providerId: string;
  apiKey?: string;
}): Promise<ProviderValidationResponse> {
  if (isDemoMode()) {
    return demoValidateProviderConnection(input);
  }

  const response = await fetch(`${apiBaseUrl()}/settings/providers/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response
    .json()
    .catch(() => ({}))) as Partial<ProviderValidationResponse> & {
    message?: string;
  };

  if (!response.ok) {
    return {
      providerId: input.providerId,
      valid: false,
      message: body.message ?? "供应商连接校验失败",
    };
  }

  return body as ProviderValidationResponse;
}

export async function saveProviderApiKey(input: {
  content?: string;
  providerId: string;
  apiKey: string;
}): Promise<ProviderApiKeySaveResponse> {
  if (isDemoMode()) {
    return demoSaveProviderApiKey(input);
  }

  const response = await fetch(`${apiBaseUrl()}/settings/providers/api-key`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response
    .json()
    .catch(() => ({}))) as Partial<ProviderApiKeySaveResponse> & {
    message?: string;
  };

  if (!response.ok) {
    return {
      providerId: input.providerId,
      saved: false,
      message: body.message ?? "API Key 保存失败",
    };
  }

  return body as ProviderApiKeySaveResponse;
}

export async function updateRepositoryRuntimeSettings(
  input: RepositoryRuntimeSettingsInput,
): Promise<ConfigSection> {
  if (isDemoMode()) {
    return demoUpdateRepositoryRuntimeSettings(input);
  }

  const response = await fetch(
    `${apiBaseUrl()}/settings/repositories/${encodeURIComponent(input.repositoryId)}/runtime`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        triggerMode: input.triggerMode,
        mention: input.mention,
        maxConcurrentIssues: input.maxConcurrentIssues,
        projectSkillPath: input.projectSkillPath,
        projectRulePath: input.projectRulePath,
        allowedPermissions: input.allowedPermissions,
        blockedPermissions: input.blockedPermissions,
      }),
    },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(body.message ?? "仓库设置更新失败");
  }

  return (await response.json()) as ConfigSection;
}
