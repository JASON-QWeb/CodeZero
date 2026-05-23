import type { RepositoryConfig } from "@agent/config";
import { toolPermissions, type PolicyDefinition, type ToolDefinition } from "@agent/tool-gateway";

export function createRepositoryPermissionPolicies(repositoryConfig: Pick<RepositoryConfig, "id" | "permissions">, registeredTools: ToolDefinition[]): PolicyDefinition[] {
  const permissions = repositoryConfig.permissions;
  const policies: PolicyDefinition[] = [];
  const toolsOutsideAllowlist =
    permissions.allowed_tools.length > 0 ? registeredTools.map((tool) => tool.name).filter((toolName) => !permissions.allowed_tools.includes(toolName)) : [];
  const permissionsOutsideAllowlist =
    permissions.allowed_permissions.length > 0 ? toolPermissions.filter((permission) => !permissions.allowed_permissions.includes(permission)) : [];

  if (toolsOutsideAllowlist.length > 0) {
    policies.push({
      id: `repo-${repositoryConfig.id}-tool-allowlist`,
      description: "Repository tool allowlist blocked a tool call.",
      toolNames: toolsOutsideAllowlist,
      action: "block"
    });
  }

  if (permissions.blocked_tools.length > 0) {
    policies.push({
      id: `repo-${repositoryConfig.id}-blocked-tools`,
      description: "Repository tool blocklist blocked a tool call.",
      toolNames: permissions.blocked_tools,
      action: "block"
    });
  }

  if (permissionsOutsideAllowlist.length > 0) {
    policies.push({
      id: `repo-${repositoryConfig.id}-permission-allowlist`,
      description: "Repository permission allowlist blocked a tool call.",
      permissions: permissionsOutsideAllowlist,
      action: "block"
    });
  }

  if (permissions.blocked_permissions.length > 0) {
    policies.push({
      id: `repo-${repositoryConfig.id}-blocked-permissions`,
      description: "Repository permission blocklist blocked a tool call.",
      permissions: permissions.blocked_permissions,
      action: "block"
    });
  }

  return policies;
}

export function repositoryAllowsTool(repositoryConfig: Pick<RepositoryConfig, "permissions">, tool: ToolDefinition): boolean {
  const permissions = repositoryConfig.permissions;

  if (permissions.blocked_tools.includes(tool.name) || permissions.blocked_permissions.includes(tool.permission)) {
    return false;
  }

  if (permissions.allowed_tools.length > 0 && !permissions.allowed_tools.includes(tool.name)) {
    return false;
  }

  if (permissions.allowed_permissions.length > 0 && !permissions.allowed_permissions.includes(tool.permission)) {
    return false;
  }

  return true;
}
