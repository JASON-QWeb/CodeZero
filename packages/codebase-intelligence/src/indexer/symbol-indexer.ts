import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FileIndexEntry } from "./file-indexer.js";

export type SymbolIndexEntry = {
  name: string;
  kind: "function" | "class" | "component" | "route" | "type" | "unknown";
  path: string;
  line: number;
};

const symbolPatterns: Array<{ kind: SymbolIndexEntry["kind"]; pattern: RegExp }> = [
  { kind: "function", pattern: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g },
  { kind: "class", pattern: /\b(?:export\s+)?class\s+([A-Za-z0-9_]+)/g },
  { kind: "type", pattern: /\b(?:export\s+)?(?:type|interface)\s+([A-Za-z0-9_]+)/g },
  { kind: "component", pattern: /\b(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*=/g },
  { kind: "route", pattern: /\b(?:app|router)\.(get|post|put|patch|delete)\s*\(/g }
];

export async function indexSymbols(repoDir: string, files: FileIndexEntry[], limit = 5000): Promise<SymbolIndexEntry[]> {
  const symbols: SymbolIndexEntry[] = [];
  const codeFiles = files.filter((file) => [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(file.extension) && file.sizeBytes < 300_000);

  for (const file of codeFiles) {
    if (symbols.length >= limit) {
      break;
    }

    const absolutePath = path.join(repoDir, file.path);
    const content = await readFile(absolutePath, "utf8").catch(() => "");

    if (!content) {
      continue;
    }

    for (const { kind, pattern } of symbolPatterns) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        const name = match[1] ?? kind;
        const index = match.index ?? 0;
        symbols.push({
          name,
          kind,
          path: file.path,
          line: content.slice(0, index).split("\n").length
        });

        if (symbols.length >= limit) {
          return symbols;
        }
      }
    }
  }

  return symbols;
}

