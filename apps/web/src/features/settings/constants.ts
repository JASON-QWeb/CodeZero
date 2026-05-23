import type { ConfigSectionName, ToolPermissionLevel, TriggerMode } from "./types";

export const triggerModes: TriggerMode[] = ["auto", "mention", "label", "manual", "disabled"];
export const permissionLevels: ToolPermissionLevel[] = ["read", "safe_write", "repo_write", "external_write", "dangerous"];
export const orderedSections: ConfigSectionName[] = ["agents", "repositories", "tools", "policies", "sandbox"];
