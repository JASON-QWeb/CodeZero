import type { JsonObject } from "@agent/shared";
import type { JsonToolAction, ToolCallResult } from "@agent/tool-gateway";
import type { ImplementationResponse } from "./schemas.js";

export function implementationToToolActions(implementation: ImplementationResponse): JsonToolAction[] {
  if (implementation.actions?.length) {
    return implementation.actions.map((action) => {
      const toolName = normalizeImplementationToolName(action.toolName ?? action.tool);

      if (!toolName) {
        throw new Error("Implementation action requires toolName or tool");
      }

      return {
        id: action.id,
        toolName,
        input: normalizeImplementationToolInput(toolName, action.input as JsonObject)
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

function normalizeImplementationToolName(toolName: string | undefined): string | undefined {
  switch (toolName) {
    case "apply_patch":
      return "repo.apply_patch";
    case "replace_text":
      return "repo.replace_text";
    case "write_file":
      return "repo.write_file";
    default:
      return toolName;
  }
}

function normalizeImplementationToolInput(toolName: string, input: JsonObject): JsonObject {
  if (toolName === "repo.apply_patch") {
    return normalizeKeyAliases(input, {
      unifiedDiff: ["unified_diff", "diff", "patch"]
    });
  }

  if (toolName === "repo.write_file") {
    return normalizeKeyAliases(input, {
      path: ["file_path", "filePath", "filename", "file"],
      content: ["contents", "text", "body"]
    });
  }

  if (toolName === "repo.replace_text") {
    return normalizeKeyAliases(input, {
      path: ["file_path", "filePath", "filename", "file"],
      search: ["oldText", "old_text", "searchText", "search_text", "find"],
      replace: ["newText", "new_text", "replacement", "replaceText", "replace_text"]
    });
  }

  return input;
}

function normalizeKeyAliases(input: JsonObject, aliasesByCanonicalKey: Record<string, string[]>): JsonObject {
  const normalized: JsonObject = { ...input };

  for (const [canonicalKey, aliases] of Object.entries(aliasesByCanonicalKey)) {
    if (normalized[canonicalKey] !== undefined) {
      continue;
    }

    const alias = aliases.find((candidate) => normalized[candidate] !== undefined);
    if (alias) {
      const value = normalized[alias];
      if (value !== undefined) {
        normalized[canonicalKey] = value;
      }
    }
  }

  return normalized;
}

export function summarizeToolFailure(result: ToolCallResult): string {
  const output = result.output && typeof result.output === "object" && !Array.isArray(result.output) ? result.output : undefined;
  const stdout = typeof output?.stdout === "string" ? output.stdout : "";
  const stderr = typeof output?.stderr === "string" ? output.stderr : "";
  return [`Tool ${result.toolName} finished with ${result.status}`, result.error, stderr, stdout].filter(Boolean).join("\n");
}
