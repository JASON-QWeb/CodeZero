import type { JsonValue } from "@agent/shared";
import { escapeRegExp, normalizeRelativePath } from "./utils.js";
import type { PolicyDecision, PolicyDefinition, ToolCallRequest, ToolDefinition } from "./types.js";

export function evaluateToolPolicies(input: {
  tool: ToolDefinition;
  request: ToolCallRequest;
  policies: PolicyDefinition[];
}): PolicyDecision[] {
  const candidatePaths = extractPathCandidates(input.request.input);
  const command = typeof input.request.input.command === "string" ? input.request.input.command : undefined;

  return input.policies
    .map((policy) => {
      const reasons: string[] = [];

      if (policy.toolNames?.includes(input.tool.name)) {
        reasons.push(`tool matched ${input.tool.name}`);
      }

      if (policy.permissions?.includes(input.tool.permission)) {
        reasons.push(`permission matched ${input.tool.permission}`);
      }

      const matchedPath = policy.matchPaths?.find((pattern) => candidatePaths.some((candidate) => matchPathPattern(candidate, pattern)));

      if (matchedPath) {
        reasons.push(`path matched ${matchedPath}`);
      }

      const matchedCommand = command ? policy.matchCommands?.find((pattern) => command.includes(pattern)) : undefined;

      if (matchedCommand) {
        reasons.push(`command matched ${matchedCommand}`);
      }

      return {
        policyId: policy.id,
        action: policy.action,
        matched: reasons.length > 0,
        reasons
      };
    })
    .filter((decision) => decision.matched);
}

export function extractPathCandidates(input: JsonValue, keyHint = ""): string[] {
  if (typeof input === "string") {
    if (isDiffKey(keyHint)) {
      return extractDiffPaths(input);
    }

    return isPathKey(keyHint) ? [normalizeRelativePath(input)] : [];
  }

  if (Array.isArray(input)) {
    return input.flatMap((value) => extractPathCandidates(value, keyHint));
  }

  if (input && typeof input === "object") {
    return Object.entries(input).flatMap(([key, value]) => extractPathCandidates(value, key));
  }

  return [];
}

export function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>();

  for (const line of diff.split("\n")) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);

    if (diffMatch?.[1]) {
      paths.add(normalizeRelativePath(diffMatch[1]));
    }

    if (diffMatch?.[2]) {
      paths.add(normalizeRelativePath(diffMatch[2]));
    }

    const markerMatch = line.match(/^(?:---|\+\+\+) [ab]\/(.+)$/);

    if (markerMatch?.[1]) {
      paths.add(normalizeRelativePath(markerMatch[1]));
    }
  }

  return [...paths].filter((candidate) => candidate !== "/dev/null");
}

export function matchPathPattern(candidate: string, pattern: string): boolean {
  const normalizedCandidate = normalizeRelativePath(candidate);
  const normalizedPattern = normalizeRelativePath(pattern);

  if (globToRegExp(normalizedPattern).test(normalizedCandidate)) {
    return true;
  }

  if (normalizedPattern.startsWith("**/")) {
    return globToRegExp(normalizedPattern.slice(3)).test(normalizedCandidate);
  }

  return false;
}

function isPathKey(key: string): boolean {
  return ["path", "paths", "file", "files", "targetPath", "targetPaths"].includes(key);
}

function isDiffKey(key: string): boolean {
  return ["patch", "unifiedDiff", "diff"].includes(key);
}

function globToRegExp(glob: string): RegExp {
  let source = "";

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];

    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }

    source += escapeRegExp(char ?? "");
  }

  return new RegExp(`^${source}$`);
}
