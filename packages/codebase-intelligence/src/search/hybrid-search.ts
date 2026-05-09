import type { FileEvidence, RelevantFile } from "@agent/shared";
import type { FileIndexEntry } from "../indexer/file-indexer.js";
import { scoreEvidence } from "../evidence/evidence-scorer.js";

export type SearchHypothesis = {
  businessTerms: string[];
  technicalTerms: string[];
  likelyEntrypoints: string[];
  likelyTests: string[];
  negativeFilters: string[];
};

export type SearchResult = {
  file: FileIndexEntry;
  evidence: FileEvidence[];
  score: number;
};

export function createSearchHypothesis(text: string): SearchHypothesis {
  const words = Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((word) => word.length > 2)
    )
  );

  return {
    businessTerms: words.slice(0, 12),
    technicalTerms: words.filter((word) => ["api", "route", "service", "component", "page", "test"].includes(word)),
    likelyEntrypoints: ["app", "pages", "routes", "api", "components", "services"],
    likelyTests: ["test", "spec", "__tests__"],
    negativeFilters: ["dist", "build", "generated", "snapshot", "node_modules"]
  };
}

export function hybridSearch(files: FileIndexEntry[], hypothesis: SearchHypothesis, limit = 20): SearchResult[] {
  const terms = [...hypothesis.businessTerms, ...hypothesis.technicalTerms].filter(Boolean);

  return files
    .filter((file) => !file.isGenerated)
    .filter((file) => !hypothesis.negativeFilters.some((term) => file.path.toLowerCase().includes(term)))
    .map((file) => {
      const evidence: FileEvidence[] = [];
      const lowerPath = file.path.toLowerCase();

      for (const term of terms) {
        if (lowerPath.includes(term)) {
          evidence.push({
            kind: "path",
            score: 8,
            summary: `Path matched term "${term}"`
          });
        }
      }

      if (hypothesis.likelyEntrypoints.some((entrypoint) => lowerPath.includes(entrypoint))) {
        evidence.push({
          kind: "path",
          score: 4,
          summary: "Path is in a likely entrypoint directory"
        });
      }

      if (file.isTest || hypothesis.likelyTests.some((term) => lowerPath.includes(term))) {
        evidence.push({
          kind: "keyword",
          score: 3,
          summary: "File appears to be a relevant test target"
        });
      }

      return {
        file,
        evidence,
        score: scoreEvidence(evidence)
      };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function toRelevantFiles(results: SearchResult[]): RelevantFile[] {
  return results.map((result) => ({
    path: result.file.path,
    reason: result.evidence.map((item) => item.summary).join("; "),
    evidence: result.evidence,
    readMode: result.file.sizeBytes < 40_000 ? "full" : "excerpt"
  }));
}

