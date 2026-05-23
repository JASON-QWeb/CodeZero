import path from "node:path";
import type { JsonValue } from "@agent/shared";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function resolveInsideRepo(repoDir: string, relativePath: string): string {
  const root = path.resolve(repoDir);
  const target = path.resolve(root, relativePath);

  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }

  return target;
}

export function expectString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
}

export function expectOptionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(asJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, asJsonValue(entry)]));
  }

  return String(value);
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Tool ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
