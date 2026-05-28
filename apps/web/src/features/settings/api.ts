import type {
  ConfigResponse,
  ConfigSection,
  ConfigSectionName,
  ProviderApiKeySaveResponse,
  ProviderValidationResponse,
  RepositoryRuntimeSettingsInput,
  ValidationResponse
} from "./types";

export const apiBaseUrl = () => process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function fetchConfig(): Promise<ConfigResponse> {
  const response = await fetch(`${apiBaseUrl()}/settings/config`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load settings");
  }

  return (await response.json()) as ConfigResponse;
}

export async function validateConfig(input: { section: ConfigSectionName; content: string }): Promise<ValidationResponse> {
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

export async function saveConfig(input: { section: ConfigSectionName; content: string }): Promise<ConfigSection> {
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

export async function validateProviderConnection(input: { content: string; providerId: string; apiKey?: string }): Promise<ProviderValidationResponse> {
  const response = await fetch(`${apiBaseUrl()}/settings/providers/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const body = (await response.json().catch(() => ({}))) as Partial<ProviderValidationResponse> & { message?: string };

  if (!response.ok) {
    return {
      providerId: input.providerId,
      valid: false,
      message: body.message ?? "Provider validation failed"
    };
  }

  return body as ProviderValidationResponse;
}

export async function saveProviderApiKey(input: { content?: string; providerId: string; apiKey: string }): Promise<ProviderApiKeySaveResponse> {
  const response = await fetch(`${apiBaseUrl()}/settings/providers/api-key`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  const body = (await response.json().catch(() => ({}))) as Partial<ProviderApiKeySaveResponse> & { message?: string };

  if (!response.ok) {
    return {
      providerId: input.providerId,
      saved: false,
      message: body.message ?? "Failed to save API key"
    };
  }

  return body as ProviderApiKeySaveResponse;
}

export async function updateRepositoryRuntimeSettings(input: RepositoryRuntimeSettingsInput): Promise<ConfigSection> {
  const response = await fetch(`${apiBaseUrl()}/settings/repositories/${encodeURIComponent(input.repositoryId)}/runtime`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      triggerMode: input.triggerMode,
      mention: input.mention,
      maxConcurrentIssues: input.maxConcurrentIssues,
      projectSkillPath: input.projectSkillPath,
      allowedPermissions: input.allowedPermissions,
      blockedPermissions: input.blockedPermissions
    })
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "Failed to update repository settings");
  }

  return (await response.json()) as ConfigSection;
}
