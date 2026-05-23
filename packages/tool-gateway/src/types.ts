import type { JsonObject, JsonValue } from "@agent/shared";

export const toolPermissions = ["read", "safe_write", "repo_write", "external_write", "dangerous"] as const;

export type ToolPermission = (typeof toolPermissions)[number];
export type PolicyAction = "allow" | "audit" | "require_approval" | "block";
export type ToolCallStatus = "success" | "failed" | "blocked" | "approval_required";

export type ToolDefinition = {
  name: string;
  description: string;
  permission: ToolPermission;
  timeoutMs?: number;
  policyRefs?: string[];
};

export type PolicyDefinition = {
  id: string;
  description?: string;
  toolNames?: string[];
  permissions?: ToolPermission[];
  matchPaths?: string[];
  matchCommands?: string[];
  action: PolicyAction;
};

export type ToolCallRequest = {
  id?: string;
  taskId?: string;
  toolName: string;
  input: JsonObject;
};

export type JsonToolAction = {
  id?: string;
  toolName: string;
  input: JsonObject;
};

export type JsonActionPlan = {
  actions: JsonToolAction[];
};

export type PolicyDecision = {
  policyId: string;
  action: PolicyAction;
  matched: boolean;
  reasons: string[];
};

export type ToolCallResult = {
  id: string;
  taskId?: string;
  toolName: string;
  status: ToolCallStatus;
  output?: JsonValue;
  error?: string;
  durationMs: number;
  policyDecisions: PolicyDecision[];
};

export type ToolExecutionContext = {
  taskId?: string;
  repoDir: string;
  env?: Record<string, string | undefined>;
};

export type ToolHandler = (input: JsonObject, context: ToolExecutionContext) => JsonValue | Promise<JsonValue>;

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};
