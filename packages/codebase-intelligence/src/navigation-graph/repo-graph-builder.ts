import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FileIndexEntry } from "../indexer/file-indexer.js";
import type { SymbolIndexEntry } from "../indexer/symbol-indexer.js";

const execFileAsync = promisify(execFile);

export type RepoGraphNodeKind = "file" | "symbol" | "route" | "business-concept";

export type RepoGraphEdgeKind =
  | "defines"
  | "imports"
  | "handles_route"
  | "tests"
  | "mentions_business_concept"
  | "changed_with";

export type RepoGraphNode = {
  id: string;
  kind: RepoGraphNodeKind;
  label: string;
  path?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type RepoGraphEdge = {
  from: string;
  to: string;
  kind: RepoGraphEdgeKind;
  confidence: number;
  evidence: string[];
};

export type RepoNavigationGraph = {
  id: string;
  nodes: RepoGraphNode[];
  edges: RepoGraphEdge[];
  stats: {
    files: number;
    symbols: number;
    routes: number;
    imports: number;
    tests: number;
    changedWith: number;
  };
  createdAt: string;
};

export type BuildRepoNavigationGraphInput = {
  repoDir: string;
  files: FileIndexEntry[];
  symbols: SymbolIndexEntry[];
  businessRules?: string[];
  includeGitHistory?: boolean;
  maxGitCommits?: number;
};

const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/g;

export async function buildRepoNavigationGraph(input: BuildRepoNavigationGraphInput): Promise<RepoNavigationGraph> {
  const filePaths = new Set(input.files.map((file) => normalizePath(file.path)));
  const nodes = new Map<string, RepoGraphNode>();
  const edges: RepoGraphEdge[] = [];

  for (const file of input.files) {
    const filePath = normalizePath(file.path);
    nodes.set(fileNodeId(filePath), {
      id: fileNodeId(filePath),
      kind: "file",
      label: filePath,
      path: filePath,
      metadata: {
        extension: file.extension,
        isTest: file.isTest,
        isGenerated: file.isGenerated,
        moduleName: file.moduleName,
        sizeBytes: file.sizeBytes
      }
    });

    const route = routeFromPath(filePath);
    if (route) {
      const routeId = routeNodeId(route);
      nodes.set(routeId, { id: routeId, kind: "route", label: route, path: filePath });
      edges.push({
        from: routeId,
        to: fileNodeId(filePath),
        kind: "handles_route",
        confidence: 0.88,
        evidence: [`${filePath} follows route file conventions`]
      });
    }
  }

  for (const symbol of input.symbols) {
    const symbolPath = normalizePath(symbol.path);
    const symbolId = `symbol:${symbolPath}#${symbol.name}`;
    nodes.set(symbolId, {
      id: symbolId,
      kind: "symbol",
      label: symbol.name,
      path: symbolPath,
      metadata: { kind: symbol.kind, line: symbol.line }
    });
    edges.push({
      from: fileNodeId(symbolPath),
      to: symbolId,
      kind: "defines",
      confidence: 0.9,
      evidence: [`${symbol.kind} ${symbol.name} defined at line ${symbol.line}`]
    });
  }

  edges.push(...buildTestEdges(input.files));
  edges.push(...(await buildImportEdges(input.repoDir, input.files, filePaths)));
  edges.push(...buildBusinessConceptEdges(input.businessRules ?? [], input.files, nodes));

  if (input.includeGitHistory ?? true) {
    edges.push(...(await buildChangedWithEdges(input.repoDir, filePaths, input.maxGitCommits ?? 80)));
  }

  const dedupedEdges = dedupeEdges(edges);

  return {
    id: `repo-graph-${Date.now()}`,
    nodes: Array.from(nodes.values()).sort((left, right) => left.id.localeCompare(right.id)),
    edges: dedupedEdges,
    stats: {
      files: input.files.length,
      symbols: input.symbols.length,
      routes: Array.from(nodes.values()).filter((node) => node.kind === "route").length,
      imports: dedupedEdges.filter((edge) => edge.kind === "imports").length,
      tests: dedupedEdges.filter((edge) => edge.kind === "tests").length,
      changedWith: dedupedEdges.filter((edge) => edge.kind === "changed_with").length
    },
    createdAt: new Date().toISOString()
  };
}

function buildTestEdges(files: FileIndexEntry[]): RepoGraphEdge[] {
  const nonTestFiles = files.filter((file) => !file.isTest).map((file) => normalizePath(file.path));
  const edges: RepoGraphEdge[] = [];

  for (const test of files.filter((file) => file.isTest)) {
    const testPath = normalizePath(test.path);
    const testBase = basenameWithoutExtensions(testPath).replace(/\.(test|spec)$/i, "");
    const source =
      nonTestFiles.find((filePath) => basenameWithoutExtensions(filePath) === testBase) ??
      nonTestFiles.find((filePath) => testPath.includes(path.posix.dirname(filePath)));

    if (source) {
      edges.push({
        from: fileNodeId(source),
        to: fileNodeId(testPath),
        kind: "tests",
        confidence: 0.82,
        evidence: [`${testPath} appears to test ${source}`]
      });
    }
  }

  return edges;
}

async function buildImportEdges(repoDir: string, files: FileIndexEntry[], filePaths: Set<string>): Promise<RepoGraphEdge[]> {
  const edges: RepoGraphEdge[] = [];
  const codeFiles = files.filter((file) => codeExtensions.has(file.extension) && file.sizeBytes < 300_000 && !file.isGenerated);

  for (const file of codeFiles) {
    const sourcePath = normalizePath(file.path);
    const content = await readFile(path.join(repoDir, file.path), "utf8").catch(() => "");

    if (!content) {
      continue;
    }

    importPattern.lastIndex = 0;
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier?.startsWith(".")) {
        continue;
      }

      const target = resolveRelativeImport(sourcePath, specifier, filePaths);
      if (!target) {
        continue;
      }

      edges.push({
        from: fileNodeId(sourcePath),
        to: fileNodeId(target),
        kind: "imports",
        confidence: 0.9,
        evidence: [`${sourcePath} imports ${specifier}`]
      });
    }
  }

  return edges;
}

function buildBusinessConceptEdges(businessRules: string[], files: FileIndexEntry[], nodes: Map<string, RepoGraphNode>): RepoGraphEdge[] {
  const edges: RepoGraphEdge[] = [];
  const concepts = Array.from(
    new Set(
      businessRules
        .join("\n")
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((word) => word.length > 3)
        .slice(0, 80)
    )
  );

  for (const concept of concepts) {
    const conceptId = `business:${concept}`;
    nodes.set(conceptId, { id: conceptId, kind: "business-concept", label: concept });

    for (const file of files) {
      const filePath = normalizePath(file.path);
      if (filePath.toLowerCase().includes(concept)) {
        edges.push({
          from: conceptId,
          to: fileNodeId(filePath),
          kind: "mentions_business_concept",
          confidence: 0.65,
          evidence: [`Path contains business concept "${concept}"`]
        });
      }
    }
  }

  return edges;
}

async function buildChangedWithEdges(repoDir: string, filePaths: Set<string>, maxGitCommits: number): Promise<RepoGraphEdge[]> {
  const output = await execFileAsync("git", ["-C", repoDir, "log", `-n${maxGitCommits}`, "--name-only", "--pretty=format:--COMMIT--"], {
    maxBuffer: 2_000_000
  })
    .then((result) => result.stdout)
    .catch(() => "");

  if (!output) {
    return [];
  }

  const pairCounts = new Map<string, number>();

  for (const group of output.split("--COMMIT--")) {
    const touched = Array.from(
      new Set(
        group
          .split("\n")
          .map((line) => normalizePath(line.trim()))
          .filter((line) => filePaths.has(line))
      )
    ).slice(0, 20);

    for (let leftIndex = 0; leftIndex < touched.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < touched.length; rightIndex += 1) {
        const left = touched[leftIndex];
        const right = touched[rightIndex];
        if (!left || !right) {
          continue;
        }
        const key = [left, right].sort().join("\0");
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  return Array.from(pairCounts.entries())
    .filter(([, count]) => count > 1)
    .sort(([, leftCount], [, rightCount]) => rightCount - leftCount)
    .slice(0, 200)
    .flatMap(([key, count]) => {
      const [left, right] = key.split("\0");
      if (!left || !right) {
        return [];
      }
      const confidence = Math.min(0.9, 0.45 + count * 0.1);
      return [
        {
          from: fileNodeId(left),
          to: fileNodeId(right),
          kind: "changed_with" as const,
          confidence,
          evidence: [`Changed together in ${count} recent commits`]
        },
        {
          from: fileNodeId(right),
          to: fileNodeId(left),
          kind: "changed_with" as const,
          confidence,
          evidence: [`Changed together in ${count} recent commits`]
        }
      ];
    });
}

function resolveRelativeImport(sourcePath: string, specifier: string, filePaths: Set<string>): string | undefined {
  const sourceDir = path.posix.dirname(sourcePath);
  const rawTarget = normalizePath(path.posix.normalize(path.posix.join(sourceDir, specifier)));
  const candidates = [
    rawTarget,
    `${rawTarget}.ts`,
    `${rawTarget}.tsx`,
    `${rawTarget}.js`,
    `${rawTarget}.jsx`,
    `${rawTarget}.mjs`,
    `${rawTarget}.cjs`,
    `${rawTarget}/index.ts`,
    `${rawTarget}/index.tsx`,
    `${rawTarget}/index.js`,
    `${rawTarget}/index.jsx`
  ];

  return candidates.find((candidate) => filePaths.has(candidate));
}

function routeFromPath(filePath: string): string | undefined {
  const normalized = normalizePath(filePath);

  if (/^app\/.*\/page\.[jt]sx?$/.test(normalized) || normalized === "app/page.tsx" || normalized === "app/page.jsx") {
    const route = normalized
      .replace(/^app\//, "")
      .replace(/\/page\.[jt]sx?$/, "")
      .replace(/^page\.[jt]sx?$/, "")
      .replace(/\(.*?\)\//g, "")
      .replace(/\[([^\]]+)\]/g, ":$1");
    return `/${route}`.replace(/\/$/, "") || "/";
  }

  if (/^pages\/.*\.[jt]sx?$/.test(normalized) && !normalized.startsWith("pages/api/")) {
    return `/${normalized.replace(/^pages\//, "").replace(/\.[jt]sx?$/, "").replace(/\/index$/, "").replace(/\[([^\]]+)\]/g, ":$1")}`.replace(/\/$/, "") || "/";
  }

  if (/^pages\/api\/.*\.[jt]sx?$/.test(normalized) || /(^|\/)(routes|api)\//.test(normalized)) {
    return `/api/${basenameWithoutExtensions(normalized)}`;
  }

  return undefined;
}

function dedupeEdges(edges: RepoGraphEdge[]): RepoGraphEdge[] {
  const seen = new Set<string>();
  const deduped: RepoGraphEdge[] = [];

  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(edge);
    }
  }

  return deduped;
}

export function fileNodeId(filePath: string): string {
  return `file:${normalizePath(filePath)}`;
}

export function routeNodeId(route: string): string {
  return `route:${route}`;
}

export function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function basenameWithoutExtensions(filePath: string): string {
  return path.posix.basename(filePath).replace(/\.(test|spec)?\.?[cm]?[jt]sx?$/i, "");
}
