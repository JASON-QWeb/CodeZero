import type { IssueContext } from "@agent/shared";
import type { FileIndexEntry } from "../indexer/file-indexer.js";
import type { SymbolIndexEntry } from "../indexer/symbol-indexer.js";
import { fileNodeId, normalizePath, type RepoNavigationGraph } from "./repo-graph-builder.js";

export type NavigationRouteEvidence = {
  path: string;
  score: number;
  reasons: string[];
};

export type NavigationRoute = {
  id: string;
  taskId: string;
  entrypoints: string[];
  mustRead: string[];
  tests: string[];
  doNotModify: string[];
  reasoning: string[];
  evidence: NavigationRouteEvidence[];
  createdAt: string;
};

export type BuildNavigationRouteInput = {
  taskId: string;
  issue: IssueContext;
  graph: RepoNavigationGraph;
  files: FileIndexEntry[];
  symbols: SymbolIndexEntry[];
  maxMustRead?: number;
  maxTests?: number;
};

const likelyEntrypointPatterns = ["/app/", "/pages/", "/routes/", "/api/", "/components/", "/services/"];
const riskyPathTerms = ["auth", "billing", "ledger", "permission", "permissions", "migration", "migrations"];

export function buildNavigationRoute(input: BuildNavigationRouteInput): NavigationRoute {
  const terms = extractTerms([input.issue.title, input.issue.body, input.issue.labels.join(" ")].join("\n"));
  const fileScores = new Map<string, NavigationRouteEvidence>();
  const filesByPath = new Map(input.files.map((file) => [normalizePath(file.path), file]));

  for (const file of input.files) {
    const filePath = normalizePath(file.path);
    const lowerPath = filePath.toLowerCase();
    const evidence = ensureEvidence(fileScores, filePath);

    for (const term of terms) {
      if (lowerPath.includes(term)) {
        evidence.score += 6;
        evidence.reasons.push(`Path matched issue term "${term}"`);
      }
    }

    if (likelyEntrypointPatterns.some((pattern) => lowerPath.includes(pattern) || lowerPath.startsWith(pattern.slice(1)))) {
      evidence.score += 2;
      evidence.reasons.push("Path is in a likely entrypoint area");
    }
  }

  for (const symbol of input.symbols) {
    const symbolPath = normalizePath(symbol.path);
    const lowerName = symbol.name.toLowerCase();
    const matchingTerm = terms.find((term) => lowerName.includes(term));

    if (matchingTerm) {
      const evidence = ensureEvidence(fileScores, symbolPath);
      evidence.score += 5;
      evidence.reasons.push(`Symbol ${symbol.name} matched issue term "${matchingTerm}"`);
    }
  }

  for (const edge of input.graph.edges) {
    if (edge.kind === "handles_route" && edge.to.startsWith("file:")) {
      const filePath = edge.to.slice("file:".length);
      const lowerRoute = edge.from.toLowerCase();
      const matchingTerm = terms.find((term) => lowerRoute.includes(term));

      if (matchingTerm) {
        const evidence = ensureEvidence(fileScores, filePath);
        evidence.score += 7;
        evidence.reasons.push(`Route ${edge.from} matched issue term "${matchingTerm}"`);
      }
    }

    if (edge.kind === "mentions_business_concept" && edge.to.startsWith("file:")) {
      const concept = edge.from.slice("business:".length);
      if (terms.includes(concept)) {
        const evidence = ensureEvidence(fileScores, edge.to.slice("file:".length));
        evidence.score += 5;
        evidence.reasons.push(`Business concept "${concept}" matched issue text`);
      }
    }
  }

  propagateGraphEvidence(input.graph, fileScores);

  const evidence = Array.from(fileScores.values())
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const mustRead = evidence
    .filter((item) => !filesByPath.get(item.path)?.isTest)
    .map((item) => item.path)
    .slice(0, input.maxMustRead ?? 8);
  const tests = findRouteTests(input.graph, mustRead)
    .concat(evidence.filter((item) => filesByPath.get(item.path)?.isTest).map((item) => item.path))
    .filter(unique)
    .slice(0, input.maxTests ?? 8);
  const entrypoints = findEntrypoints(input.graph, mustRead, terms).slice(0, 8);
  const doNotModify = input.files
    .map((file) => normalizePath(file.path))
    .filter((filePath) => !mustRead.includes(filePath) && riskyPathTerms.some((term) => filePath.toLowerCase().includes(term)))
    .slice(0, 12);

  return {
    id: `nav-${input.taskId}`,
    taskId: input.taskId,
    entrypoints,
    mustRead,
    tests,
    doNotModify,
    reasoning: [
      ...entrypoints.map((entrypoint) => `Selected entrypoint ${entrypoint}.`),
      ...mustRead.map((filePath) => {
        const reasons = evidence.find((item) => item.path === filePath)?.reasons.slice(0, 2).join("; ") ?? "Selected by graph score";
        return `Read ${filePath}: ${reasons}.`;
      }),
      ...tests.map((filePath) => `Verify with related test ${filePath}.`)
    ].slice(0, 24),
    evidence: evidence.slice(0, 30),
    createdAt: new Date().toISOString()
  };
}

function propagateGraphEvidence(graph: RepoNavigationGraph, fileScores: Map<string, NavigationRouteEvidence>): void {
  const activeFiles = new Set(Array.from(fileScores.values()).filter((item) => item.score >= 5).map((item) => item.path));

  for (const edge of graph.edges) {
    if (!edge.from.startsWith("file:") || !edge.to.startsWith("file:")) {
      continue;
    }

    const from = edge.from.slice("file:".length);
    const to = edge.to.slice("file:".length);

    if (activeFiles.has(from) && ["imports", "tests", "changed_with"].includes(edge.kind)) {
      const evidence = ensureEvidence(fileScores, to);
      evidence.score += edge.kind === "tests" ? 4 : 2;
      evidence.reasons.push(`Connected to ${from} via ${edge.kind} edge`);
    }
  }
}

function findRouteTests(graph: RepoNavigationGraph, mustRead: string[]): string[] {
  const sourceIds = new Set(mustRead.map(fileNodeId));
  return graph.edges.filter((edge) => edge.kind === "tests" && sourceIds.has(edge.from) && edge.to.startsWith("file:")).map((edge) => edge.to.slice("file:".length));
}

function findEntrypoints(graph: RepoNavigationGraph, mustRead: string[], terms: string[]): string[] {
  const mustReadIds = new Set(mustRead.map(fileNodeId));
  const routes = graph.edges
    .filter((edge) => edge.kind === "handles_route" && mustReadIds.has(edge.to))
    .map((edge) => edge.from.replace(/^route:/, ""));

  if (routes.length > 0) {
    return routes.filter(unique);
  }

  return graph.nodes
    .filter((node) => node.kind === "route" && terms.some((term) => node.label.toLowerCase().includes(term)))
    .map((node) => node.label)
    .filter(unique);
}

function ensureEvidence(scores: Map<string, NavigationRouteEvidence>, filePath: string): NavigationRouteEvidence {
  const normalized = normalizePath(filePath);
  const existing = scores.get(normalized);

  if (existing) {
    return existing;
  }

  const created = { path: normalized, score: 0, reasons: [] };
  scores.set(normalized, created);
  return created;
}

function extractTerms(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((term) => term.length > 2)
    )
  ).slice(0, 24);
}

function unique<T>(value: T, index: number, array: T[]): boolean {
  return array.indexOf(value) === index;
}
