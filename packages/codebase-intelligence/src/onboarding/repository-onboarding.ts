import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { indexFiles, type FileIndexEntry } from "../indexer/file-indexer.js";
import { indexSymbols } from "../indexer/symbol-indexer.js";
import { buildRepoNavigationGraph, normalizePath, type RepoNavigationGraph } from "../navigation-graph/repo-graph-builder.js";

export type RepositoryOnboardingInput = {
  repoDir: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
  triggerMode?: "auto" | "mention" | "label" | "manual" | "disabled";
  mention?: string;
  businessRules?: string[];
  qualityGates?: string[];
};

export type RepositoryOnboardingDocumentType = "project" | "module-map" | "route-map" | "testing-guide" | "repository-config";

export type RepositoryOnboardingDocument = {
  path: string;
  type: RepositoryOnboardingDocumentType;
  content: string;
};

export type RepositoryOnboardingResult = {
  repository: string;
  graph: RepoNavigationGraph;
  documents: RepositoryOnboardingDocument[];
  summary: {
    files: number;
    symbols: number;
    routes: number;
    tests: number;
    packageManager: string;
    topModules: Array<{ name: string; files: number }>;
  };
};

export async function createRepositoryOnboarding(input: RepositoryOnboardingInput): Promise<RepositoryOnboardingResult> {
  const files = await indexFiles(input.repoDir);
  const symbols = await indexSymbols(input.repoDir, files);
  const graph = await buildRepoNavigationGraph({
    repoDir: input.repoDir,
    files,
    symbols,
    businessRules: input.businessRules,
    includeGitHistory: false
  });
  const topModules = rankModules(files).slice(0, 8);
  const packageManager = detectPackageManager(files);
  const routes = graph.nodes.filter((node) => node.kind === "route").map((node) => ({ route: node.label, path: node.path ?? "unknown" }));
  const tests = files.filter((file) => file.isTest).map((file) => normalizePath(file.path));
  const qualityGates = input.qualityGates ?? defaultQualityGates(packageManager, tests.length > 0);
  const repository = `${input.owner}/${input.repo}`;

  return {
    repository,
    graph,
    documents: [
      {
        path: ".agent/project.md",
        type: "project",
        content: renderProjectDoc({ repository, files, graph, packageManager, topModules, qualityGates, businessRules: input.businessRules ?? [] })
      },
      {
        path: ".agent/module-map.md",
        type: "module-map",
        content: renderModuleMap(topModules, files)
      },
      {
        path: ".agent/route-map.md",
        type: "route-map",
        content: renderRouteMap(routes)
      },
      {
        path: ".agent/testing-guide.md",
        type: "testing-guide",
        content: renderTestingGuide({ packageManager, tests, qualityGates })
      },
      {
        path: "config/repositories.suggested.yaml",
        type: "repository-config",
        content: renderRepositoryConfigSuggestion(input, qualityGates)
      }
    ],
    summary: {
      files: files.length,
      symbols: symbols.length,
      routes: routes.length,
      tests: tests.length,
      packageManager,
      topModules
    }
  };
}

export async function writeRepositoryOnboarding(result: RepositoryOnboardingResult, outputDir: string): Promise<RepositoryOnboardingDocument[]> {
  for (const document of result.documents) {
    const targetPath = path.join(outputDir, document.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, document.content);
  }

  return result.documents;
}

function rankModules(files: FileIndexEntry[]): Array<{ name: string; files: number }> {
  const counts = new Map<string, number>();

  for (const file of files) {
    const moduleName = normalizePath(file.path).split("/")[0] ?? ".";
    counts.set(moduleName, (counts.get(moduleName) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, files: count }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));
}

function detectPackageManager(files: FileIndexEntry[]): string {
  const paths = new Set(files.map((file) => normalizePath(file.path)));

  if (paths.has("pnpm-lock.yaml")) {
    return "pnpm";
  }

  if (paths.has("yarn.lock")) {
    return "yarn";
  }

  if (paths.has("package-lock.json")) {
    return "npm";
  }

  if (paths.has("uv.lock") || paths.has("pyproject.toml")) {
    return "uv";
  }

  if (paths.has("go.mod")) {
    return "go";
  }

  return "unknown";
}

function defaultQualityGates(packageManager: string, hasTests: boolean): string[] {
  if (packageManager === "pnpm") {
    return ["pnpm lint", "pnpm typecheck", hasTests ? "pnpm test" : "pnpm build"].filter(Boolean);
  }

  if (packageManager === "npm") {
    return ["npm run lint", "npm run typecheck", hasTests ? "npm test" : "npm run build"].filter(Boolean);
  }

  if (packageManager === "yarn") {
    return ["yarn lint", "yarn typecheck", hasTests ? "yarn test" : "yarn build"].filter(Boolean);
  }

  if (packageManager === "uv") {
    return ["uv run pytest"];
  }

  if (packageManager === "go") {
    return ["go test ./..."];
  }

  return hasTests ? ["run repository tests"] : ["run repository build"];
}

function renderProjectDoc(input: {
  repository: string;
  files: FileIndexEntry[];
  graph: RepoNavigationGraph;
  packageManager: string;
  topModules: Array<{ name: string; files: number }>;
  qualityGates: string[];
  businessRules: string[];
}): string {
  return [
    `# ${input.repository}`,
    "",
    "## Repository Snapshot",
    "",
    `- Files indexed: ${input.files.length}`,
    `- Symbols indexed: ${input.graph.stats.symbols}`,
    `- Routes detected: ${input.graph.stats.routes}`,
    `- Tests detected: ${input.graph.stats.tests}`,
    `- Package manager: ${input.packageManager}`,
    "",
    "## Main Modules",
    "",
    ...input.topModules.map((module) => `- ${module.name}: ${module.files} files`),
    "",
    "## Quality Gates",
    "",
    ...input.qualityGates.map((command) => `- \`${command}\``),
    "",
    "## Business Rules",
    "",
    ...(input.businessRules.length > 0 ? input.businessRules.map((rule) => `- ${rule}`) : ["- Add repository-specific business rules here before enabling auto mode."]),
    ""
  ].join("\n");
}

function renderModuleMap(topModules: Array<{ name: string; files: number }>, files: FileIndexEntry[]): string {
  const lines = ["# Module Map", ""];

  for (const module of topModules) {
    const examples = files
      .filter((file) => normalizePath(file.path).startsWith(`${module.name}/`) || normalizePath(file.path) === module.name)
      .slice(0, 8)
      .map((file) => normalizePath(file.path));
    lines.push(`## ${module.name}`, "", `- Files: ${module.files}`, ...examples.map((file) => `- ${file}`), "");
  }

  return lines.join("\n");
}

function renderRouteMap(routes: Array<{ route: string; path: string }>): string {
  if (routes.length === 0) {
    return "# Route Map\n\nNo route-like files were detected. Add service entrypoints manually after review.\n";
  }

  return ["# Route Map", "", "| Route | File |", "| --- | --- |", ...routes.map((route) => `| ${route.route} | ${route.path} |`), ""].join("\n");
}

function renderTestingGuide(input: { packageManager: string; tests: string[]; qualityGates: string[] }): string {
  return [
    "# Testing Guide",
    "",
    `Package manager: ${input.packageManager}`,
    "",
    "## Required Gates",
    "",
    ...input.qualityGates.map((command) => `- \`${command}\``),
    "",
    "## Representative Tests",
    "",
    ...(input.tests.length > 0 ? input.tests.slice(0, 30).map((test) => `- ${test}`) : ["- No tests detected during onboarding."]),
    ""
  ].join("\n");
}

function renderRepositoryConfigSuggestion(input: RepositoryOnboardingInput, qualityGates: string[]): string {
  return [
    "repositories:",
    `  - owner: ${input.owner}`,
    `    repo: ${input.repo}`,
    `    default_branch: ${input.defaultBranch ?? "main"}`,
    "    trigger:",
    `      mode: ${input.triggerMode ?? "mention"}`,
    `      mention: ${input.mention ?? "@agent"}`,
    "    quality_gates:",
    ...qualityGates.map((command) => `      - ${JSON.stringify(command)}`),
    ""
  ].join("\n");
}
