import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ContextPack, IssueContext } from "@agent/shared";
import type { FileIndexEntry } from "../indexer/file-indexer.js";
import type { SymbolIndexEntry } from "../indexer/symbol-indexer.js";
import { createSearchHypothesis, hybridSearch, toRelevantFiles } from "./hybrid-search.js";

export type ContextPackInput = {
  taskId: string;
  issue: IssueContext;
  repoDir: string;
  files: FileIndexEntry[];
  symbols: SymbolIndexEntry[];
  businessRules: string[];
  tokenBudget?: number;
};

export async function buildContextPack(input: ContextPackInput): Promise<ContextPack> {
  const issueText = [input.issue.title, input.issue.body, input.issue.labels.join(" ")].join("\n");
  const hypothesis = createSearchHypothesis(`${issueText}\n${input.businessRules.join("\n")}`);
  const searchResults = hybridSearch(input.files, hypothesis, 18);
  const relevantFiles = toRelevantFiles(searchResults);
  const tests = relevantFiles
    .map((file) => relatedTestCandidates(file.path, input.files))
    .flat()
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
    relevantFiles,
    symbols: relevantSymbols,
    tests,
    similarChanges: [],
    nonRelevantAreas: hypothesis.negativeFilters,
    openQuestions: relevantFiles.length === 0 ? ["No relevant files were found; human review or better project skills are required."] : [],
    tokenBudget: input.tokenBudget ?? 30_000,
    createdAt: new Date().toISOString()
  };
}

export async function readContextFileSnippets(repoDir: string, contextPack: ContextPack, maxCharsPerFile = 12_000): Promise<Record<string, string>> {
  const snippets: Record<string, string> = {};

  for (const file of contextPack.relevantFiles) {
    const content = await readFile(path.join(repoDir, file.path), "utf8").catch(() => "");
    snippets[file.path] = content.slice(0, maxCharsPerFile);
  }

  return snippets;
}

function relatedTestCandidates(filePath: string, files: FileIndexEntry[]): string[] {
  const basename = path.basename(filePath).replace(/\.[^.]+$/, "");
  return files
    .filter((file) => file.isTest)
    .filter((file) => file.path.includes(basename) || file.path.toLowerCase().includes(path.dirname(filePath).toLowerCase()))
    .map((file) => file.path);
}

