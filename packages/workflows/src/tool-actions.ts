import type { JsonObject } from "@agent/shared";
import type { JsonToolAction, ToolCallResult } from "@agent/tool-gateway";
import type { ImplementationResponse } from "./schemas.js";

export function implementationToToolActions(implementation: ImplementationResponse): JsonToolAction[] {
  if (implementation.actions?.length) {
    return implementation.actions.map((action) => {
      const toolName = action.toolName ?? action.tool;

      if (!toolName) {
        throw new Error("Implementation action requires toolName or tool");
      }

      return {
        id: action.id,
        toolName,
        input: action.input as JsonObject
      };
    });
  }

  if (!implementation.unifiedDiff) {
    throw new Error("Implementation must include actions or unifiedDiff");
  }

  return [
    {
      toolName: "repo.apply_patch",
      input: { unifiedDiff: implementation.unifiedDiff }
    }
  ];
}

export function summarizeToolFailure(result: ToolCallResult): string {
  const output = result.output && typeof result.output === "object" && !Array.isArray(result.output) ? result.output : undefined;
  const stdout = typeof output?.stdout === "string" ? output.stdout : "";
  const stderr = typeof output?.stderr === "string" ? output.stderr : "";
  return [`Tool ${result.toolName} finished with ${result.status}`, result.error, stderr, stdout].filter(Boolean).join("\n");
}
