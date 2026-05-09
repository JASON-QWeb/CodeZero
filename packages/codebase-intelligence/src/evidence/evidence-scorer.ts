import type { FileEvidence } from "@agent/shared";

export function scoreEvidence(evidence: FileEvidence[]): number {
  return evidence.reduce((total, item) => total + item.score, 0);
}

