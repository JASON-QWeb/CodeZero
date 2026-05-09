import { describe, expect, it } from "vitest";
import { createSearchHypothesis, hybridSearch, toRelevantFiles, type FileIndexEntry } from "@agent/codebase-intelligence";

const files: FileIndexEntry[] = [
  {
    path: "src/billing/refund-service.ts",
    extension: ".ts",
    sizeBytes: 2000,
    isTest: false,
    isGenerated: false,
    moduleName: "src",
    modifiedAt: "2026-01-01T00:00:00.000Z"
  },
  {
    path: "dist/billing/refund-service.js",
    extension: ".js",
    sizeBytes: 2000,
    isTest: false,
    isGenerated: true,
    moduleName: "dist",
    modifiedAt: "2026-01-01T00:00:00.000Z"
  }
];

describe("codebase intelligence", () => {
  it("turns issue text into a small evidence-backed context candidate set", () => {
    const hypothesis = createSearchHypothesis("Refund status is wrong on order detail");
    const results = hybridSearch(files, hypothesis);
    const relevant = toRelevantFiles(results);

    expect(relevant).toHaveLength(1);
    expect(relevant[0]?.path).toBe("src/billing/refund-service.ts");
    expect(relevant[0]?.evidence.length).toBeGreaterThan(0);
  });
});

