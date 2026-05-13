import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateGoldenIssueSuite, renderEvalReportMarkdown, type GoldenIssueCandidate, type GoldenIssueFixture } from "./index.js";

type CliArgs = {
  fixturesDir: string;
  candidatesDir: string;
  outPath?: string;
  markdownPath?: string;
  minScore: number;
};

type CandidateFile = GoldenIssueCandidate & {
  fixtureId?: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixtures = await readJsonDir<GoldenIssueFixture>(args.fixturesDir);
  const candidateFiles = await readJsonDir<CandidateFile>(args.candidatesDir);
  const candidates = new Map<string, GoldenIssueCandidate>();

  for (const item of candidateFiles) {
    const { fixtureId, ...candidate } = item.value;
    candidates.set(fixtureId ?? item.basename, candidate);
  }

  const report = evaluateGoldenIssueSuite(
    fixtures.map((item) => item.value),
    candidates
  );

  if (args.outPath) {
    await writeText(args.outPath, JSON.stringify(report, null, 2));
  }

  if (args.markdownPath) {
    await writeText(args.markdownPath, renderEvalReportMarkdown(report));
  }

  console.log(`Golden issue eval score: ${Math.round(report.score * 1000) / 10}% (${report.passed}/${report.total})`);

  if (report.score < args.minScore) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) {
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(item, "true");
      continue;
    }

    args.set(item, next);
    index += 1;
  }

  return {
    fixturesDir: args.get("--fixtures") ?? "evals/golden-issues",
    candidatesDir: args.get("--candidates") ?? "evals/candidates",
    outPath: args.get("--out"),
    markdownPath: args.get("--markdown"),
    minScore: Number(args.get("--min-score") ?? 0.8)
  };
}

async function readJsonDir<T>(dir: string): Promise<Array<{ basename: string; value: T }>> {
  const entries = await readdir(dir);
  const jsonFiles = entries.filter((entry) => entry.endsWith(".json")).sort((left, right) => left.localeCompare(right));
  const items: Array<{ basename: string; value: T }> = [];

  for (const file of jsonFiles) {
    const filePath = path.join(dir, file);
    const value = JSON.parse(await readFile(filePath, "utf8")) as T;
    items.push({ basename: path.basename(file, ".json"), value });
  }

  return items;
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

await main();
