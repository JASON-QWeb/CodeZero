import { createRepositoryOnboarding, writeRepositoryOnboarding } from "./repository-onboarding.js";

type CliArgs = {
  repoDir: string;
  owner: string;
  repo: string;
  outDir: string;
  defaultBranch?: string;
  triggerMode?: "auto" | "mention" | "label" | "manual" | "disabled";
  mention?: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await createRepositoryOnboarding({
    repoDir: args.repoDir,
    owner: args.owner,
    repo: args.repo,
    defaultBranch: args.defaultBranch,
    triggerMode: args.triggerMode,
    mention: args.mention
  });
  await writeRepositoryOnboarding(result, args.outDir);

  console.log(`Repository onboarding generated for ${result.repository}`);
  console.log(`Files: ${result.summary.files}, symbols: ${result.summary.symbols}, routes: ${result.summary.routes}, tests: ${result.summary.tests}`);
  console.log(`Documents: ${result.documents.map((document) => document.path).join(", ")}`);
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

  const owner = args.get("--owner");
  const repo = args.get("--repo");

  if (!owner || !repo) {
    throw new Error("Missing required args: --owner and --repo");
  }

  return {
    repoDir: args.get("--repo-dir") ?? process.cwd(),
    owner,
    repo,
    outDir: args.get("--out") ?? args.get("--repo-dir") ?? process.cwd(),
    defaultBranch: args.get("--default-branch"),
    triggerMode: parseTriggerMode(args.get("--trigger-mode")),
    mention: args.get("--mention")
  };
}

function parseTriggerMode(value: string | undefined): CliArgs["triggerMode"] {
  if (!value) {
    return undefined;
  }

  if (["auto", "mention", "label", "manual", "disabled"].includes(value)) {
    return value as CliArgs["triggerMode"];
  }

  throw new Error(`Invalid trigger mode: ${value}`);
}

await main();
