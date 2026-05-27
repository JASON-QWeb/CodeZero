import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ContextMemory, ContextPack, IssueContext, JsonObject, JsonValue } from "@agent/shared";
import type { FileIndexEntry } from "../indexer/file-indexer.js";
import type { SymbolIndexEntry } from "../indexer/symbol-indexer.js";
import type { NavigationRoute } from "../navigation-graph/navigation-route.js";
import { createSearchHypothesis, hybridSearch, toRelevantFiles } from "./hybrid-search.js";

export type ContextPackInput = {
  taskId: string;
  issue: IssueContext;
  repoDir: string;
  files: FileIndexEntry[];
  symbols: SymbolIndexEntry[];
  businessRules: string[];
  memories?: ContextMemory[];
  codeGraphContext?: JsonObject;
  knowledgeGraphContext?: JsonObject;
  navigationRoute?: NavigationRoute;
  tokenBudget?: number;
};

export async function buildContextPack(input: ContextPackInput): Promise<ContextPack> {
  const issueText = [input.issue.title, input.issue.body, input.issue.labels.join(" ")].join("\n");
  const memoryHints = (input.memories ?? []).map((memory) => `${memory.title}\n${memory.content}`).join("\n");
  const hypothesis = createSearchHypothesis(`${issueText}\n${input.businessRules.join("\n")}\n${memoryHints}`);
  const searchResults = hybridSearch(input.files, hypothesis, 18);
  const relevantFiles = mergeCodeGraphFiles(
    mergeKnowledgeGraphFiles(mergeNavigationRouteFiles(toRelevantFiles(searchResults), input.navigationRoute, input.files), input.knowledgeGraphContext, input.files),
    input.codeGraphContext,
    input.files
  );
  const tests = relevantFiles
    .map((file) => relatedTestCandidates(file.path, input.files))
    .flat()
    .concat(input.navigationRoute?.tests ?? [])
    .filter(unique)
    .slice(0, 12);
  const relevantSymbols = input.symbols
    .filter((symbol) => relevantFiles.some((file) => symbol.path === file.path))
    .map((symbol) => `${symbol.kind} ${symbol.name} at ${symbol.path}:${symbol.line}`)
    .slice(0, 40);

  return {
    id: `ctx-${input.taskId}`,
    taskId: input.taskId,
    taskSummary: `${input.issue.title}\n\n${input.issue.body}`.slice(0, 4000),
    businessRules: input.businessRules.slice(0, 40),
    memories: (input.memories ?? []).slice(0, 8),
    codeGraphContext: input.codeGraphContext,
    knowledgeGraphContext: input.knowledgeGraphContext,
    relevantFiles,
    symbols: relevantSymbols,
    tests,
    similarChanges: [],
    nonRelevantAreas: [...hypothesis.negativeFilters, ...(input.navigationRoute?.doNotModify ?? [])].filter(unique),
    openQuestions: relevantFiles.length === 0 ? ["No relevant files were found; human review or better project skills are required."] : [],
    tokenBudget: input.tokenBudget ?? 30_000,
    createdAt: new Date().toISOString()
  };
}

function mergeKnowledgeGraphFiles(
  relevantFiles: ContextPack["relevantFiles"],
  context: JsonObject | undefined,
  files: FileIndexEntry[]
): ContextPack["relevantFiles"] {
  const filePaths = asStringArray(context?.files);

  if (filePaths.length === 0) {
    return relevantFiles;
  }

  const fileMap = new Map(files.map((file) => [file.path, file]));
  const merged = new Map(relevantFiles.map((file) => [file.path, file]));

  for (const filePath of filePaths.slice(0, 20)) {
    const normalizedPath = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const file = fileMap.get(normalizedPath);

    if (!file || merged.has(normalizedPath)) {
      continue;
    }

    merged.set(normalizedPath, {
      path: normalizedPath,
      reason: "Selected by Understand-Anything knowledge graph",
      evidence: [{ kind: "graph", score: 9, summary: "Selected by repository-level knowledge graph" }],
      readMode: file.sizeBytes < 40_000 ? "full" : "excerpt"
    });
  }

  return Array.from(merged.values()).slice(0, 20);
}

function mergeCodeGraphFiles(relevantFiles: ContextPack["relevantFiles"], context: JsonObject | undefined, files: FileIndexEntry[]): ContextPack["relevantFiles"] {
  const filePaths = asStringArray(context?.relatedFiles);

  if (filePaths.length === 0) {
    return relevantFiles;
  }

  const fileMap = new Map(files.map((file) => [file.path, file]));
  const merged = new Map<string, ContextPack["relevantFiles"][number]>();

  for (const filePath of filePaths) {
    const normalizedPath = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const file = fileMap.get(normalizedPath);

    if (!file) {
      continue;
    }

    merged.set(normalizedPath, {
      path: normalizedPath,
      reason: "Selected by CodeGraph task context",
      evidence: [{ kind: "graph", score: 12, summary: "Selected by CodeGraph task context" }],
      readMode: file.sizeBytes < 40_000 ? "full" : "excerpt"
    });
  }

  for (const file of relevantFiles) {
    const graphFile = merged.get(file.path);

    if (graphFile) {
      graphFile.reason = `${graphFile.reason}; ${file.reason}`;
      graphFile.evidence.push(...file.evidence);
    } else {
      merged.set(file.path, file);
    }
  }

  return Array.from(merged.values()).slice(0, 20);
}

function mergeNavigationRouteFiles(relevantFiles: ContextPack["relevantFiles"], navigationRoute: NavigationRoute | undefined, files: FileIndexEntry[]): ContextPack["relevantFiles"] {
  if (!navigationRoute) {
    return relevantFiles;
  }

  const fileMap = new Map(files.map((file) => [file.path, file]));
  const merged = new Map(relevantFiles.map((file) => [file.path, file]));

  for (const routeFile of navigationRoute.mustRead) {
    const existing = merged.get(routeFile);
    const graphEvidence = {
      kind: "graph" as const,
      score: 10,
      summary: "Selected by Repo Navigation Graph route"
    };

    if (existing) {
      existing.evidence.push(graphEvidence);
      existing.reason = `${existing.reason}; Selected by navigation route`;
      continue;
    }

    merged.set(routeFile, {
      path: routeFile,
      reason: "Selected by Repo Navigation Graph route",
      evidence: [graphEvidence],
      readMode: (fileMap.get(routeFile)?.sizeBytes ?? 0) < 40_000 ? "full" : "excerpt"
    });
  }

  return Array.from(merged.values()).slice(0, 20);
}

function asStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export type ReadContextFileSnippetOptions = {
  maxCharsPerFile?: number;
  maxFiles?: number;
  includePaths?: string[];
};

export async function readContextFileSnippets(
  repoDir: string,
  contextPack: ContextPack,
  optionsOrMaxChars: number | ReadContextFileSnippetOptions = 12_000
): Promise<Record<string, string>> {
  const options = typeof optionsOrMaxChars === "number" ? { maxCharsPerFile: optionsOrMaxChars } : optionsOrMaxChars;
  const maxCharsPerFile = options.maxCharsPerFile ?? 12_000;
  const includePaths = uniquePaths((options.includePaths ?? []).map(normalizeSnippetPath).filter(Boolean));
  const relevantByPath = new Map(contextPack.relevantFiles.map((file) => [normalizeSnippetPath(file.path), file]));
  const files =
    includePaths.length > 0
      ? includePaths.map((filePath) => relevantByPath.get(filePath) ?? ({ path: filePath, reason: "Selected by execution plan", evidence: [], readMode: "full" } satisfies ContextPack["relevantFiles"][number]))
      : contextPack.relevantFiles;
  const snippets: Record<string, string> = {};

  for (const file of files.slice(0, options.maxFiles ?? files.length)) {
    const content = await readFile(path.join(repoDir, file.path), "utf8").catch(() => "");
    snippets[file.path] = content.slice(0, maxCharsPerFile);
  }

  return snippets;
}

function normalizeSnippetPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function uniquePaths(paths: string[]): string[] {
  return paths.filter((value, index) => value.length > 0 && paths.indexOf(value) === index);
}

function relatedTestCandidates(filePath: string, files: FileIndexEntry[]): string[] {
  const basename = path.basename(filePath).replace(/\.[^.]+$/, "");
  return files
    .filter((file) => file.isTest)
    .filter((file) => file.path.includes(basename) || file.path.toLowerCase().includes(path.dirname(filePath).toLowerCase()))
    .map((file) => file.path);
}

function unique<T>(value: T, index: number, array: T[]): boolean {
  return array.indexOf(value) === index;
}
