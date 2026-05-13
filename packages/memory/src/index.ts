import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Artifact, ContextMemory, IssueContext, JsonObject, Task } from "@agent/shared";

export type MemoryKind = "semantic" | "episodic" | "procedural" | "policy";
export type MemoryStatus = "proposed" | "approved" | "rejected";

export type MemoryRecord = {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  scope: "repository" | "global";
  owner?: string;
  repo?: string;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  sourceTaskId?: string;
  evidence: JsonObject;
  createdAt: string;
  updatedAt: string;
};

export type MemoryProposal = {
  taskId: string;
  issueUrl: string;
  repository: string;
  records: MemoryRecord[];
  createdAt: string;
};

export type MemorySearchResult = {
  record: MemoryRecord;
  score: number;
  reasons: string[];
};

export type MemoryStore = {
  list(input?: { owner?: string; repo?: string; status?: MemoryStatus }): Promise<MemoryRecord[]>;
  propose(records: MemoryRecord[]): Promise<MemoryRecord[]>;
  approve(id: string): Promise<MemoryRecord>;
  reject(id: string): Promise<MemoryRecord>;
  search(issue: IssueContext, limit?: number): Promise<MemorySearchResult[]>;
};

type MemoryFile = {
  records: MemoryRecord[];
};

export class FileMemoryStore implements MemoryStore {
  constructor(private readonly filePath: string) {}

  async list(input: { owner?: string; repo?: string; status?: MemoryStatus } = {}): Promise<MemoryRecord[]> {
    const store = await this.read();
    return store.records.filter((record) => {
      if (input.status && record.status !== input.status) {
        return false;
      }

      if (input.owner && record.owner !== input.owner) {
        return false;
      }

      if (input.repo && record.repo !== input.repo) {
        return false;
      }

      return true;
    });
  }

  async propose(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    const store = await this.read();
    const existingIds = new Set(store.records.map((record) => record.id));
    const nextRecords = records.map((record) => ({ ...record, status: "proposed" as const }));

    for (const record of nextRecords) {
      if (!existingIds.has(record.id)) {
        store.records.push(record);
      }
    }

    await this.write(store);
    return nextRecords;
  }

  async approve(id: string): Promise<MemoryRecord> {
    return this.updateStatus(id, "approved");
  }

  async reject(id: string): Promise<MemoryRecord> {
    return this.updateStatus(id, "rejected");
  }

  async search(issue: IssueContext, limit = 8): Promise<MemorySearchResult[]> {
    const records = (await this.list({ status: "approved" })).filter(
      (record) => record.scope === "global" || (record.owner === issue.owner && record.repo === issue.repo)
    );
    return rankMemoryRecords(issue, records).slice(0, limit);
  }

  private async updateStatus(id: string, status: MemoryStatus): Promise<MemoryRecord> {
    const store = await this.read();
    const index = store.records.findIndex((record) => record.id === id);

    if (index < 0) {
      throw new Error(`Memory record not found: ${id}`);
    }

    const current = store.records[index];

    if (!current) {
      throw new Error(`Memory record not found: ${id}`);
    }

    const next = { ...current, status, updatedAt: new Date().toISOString() };
    store.records[index] = next;
    await this.write(store);
    return next;
  }

  private async read(): Promise<MemoryFile> {
    const content = await readFile(this.filePath, "utf8").catch(() => "");
    return content ? (JSON.parse(content) as MemoryFile) : { records: [] };
  }

  private async write(store: MemoryFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(store, null, 2));
    await rename(tempPath, this.filePath);
  }
}

export function createTaskMemoryProposal(input: { task: Task; artifacts?: Artifact[]; now?: Date }): MemoryProposal {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const changedFiles = extractChangedFiles(input.artifacts ?? []);
  const qualityGateSummary = (input.task.qualityGateResults ?? [])
    .map((result) => `${result.kind}:${result.passed ? "passed" : "failed"}`)
    .join(", ");
  const goals = input.task.prd?.goals.join(" ") || input.task.issue.title;
  const reviewRisk = input.task.reviewResult?.riskLevel ?? "unknown";

  return {
    taskId: input.task.id,
    issueUrl: input.task.issue.url,
    repository: `${input.task.issue.owner}/${input.task.issue.repo}`,
    createdAt: timestamp,
    records: [
      {
        id: `memory-${input.task.id}-episodic`,
        kind: "episodic",
        status: "proposed",
        scope: "repository",
        owner: input.task.issue.owner,
        repo: input.task.issue.repo,
        title: `Issue #${input.task.issue.number}: ${input.task.issue.title}`,
        content: [
          `Issue: ${input.task.issue.title}`,
          `Goals: ${goals}`,
          `Changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "not recorded"}`,
          `Quality gates: ${qualityGateSummary || "not recorded"}`,
          `Review risk: ${reviewRisk}`
        ].join("\n"),
        tags: unique(["issue", input.task.prd?.taskType ?? "unknown", ...input.task.issue.labels]),
        confidence: input.task.reviewResult?.approved ? 0.86 : 0.62,
        sourceTaskId: input.task.id,
        evidence: {
          issueUrl: input.task.issue.url,
          prUrl: input.task.prUrl ?? null,
          artifactTypes: unique((input.artifacts ?? []).map((artifact) => artifact.type))
        },
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: `memory-${input.task.id}-procedural`,
        kind: "procedural",
        status: "proposed",
        scope: "repository",
        owner: input.task.issue.owner,
        repo: input.task.issue.repo,
        title: `Verification recipe from #${input.task.issue.number}`,
        content: `Use these quality gates for similar tasks: ${qualityGateSummary || "see repository quality_gates config"}.`,
        tags: unique(["verification", "quality-gates", input.task.prd?.taskType ?? "unknown"]),
        confidence: input.task.qualityGateResults?.every((result) => result.passed) ? 0.82 : 0.55,
        sourceTaskId: input.task.id,
        evidence: {
          qualityGateCount: input.task.qualityGateResults?.length ?? 0,
          prUrl: input.task.prUrl ?? null
        },
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ]
  };
}

export function rankMemoryRecords(issue: IssueContext, records: MemoryRecord[]): MemorySearchResult[] {
  const issueTerms = tokenize([issue.title, issue.body, ...issue.labels].join(" "));

  return records
    .map((record) => {
      const recordTerms = tokenize([record.title, record.content, ...record.tags].join(" "));
      const matched = [...issueTerms].filter((term) => recordTerms.has(term));
      const score = matched.length / Math.max(1, issueTerms.size) + record.confidence * 0.25;
      return {
        record,
        score,
        reasons: matched.slice(0, 8).map((term) => `matched ${term}`)
      };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score);
}

export function toContextMemories(results: MemorySearchResult[]): ContextMemory[] {
  return results.map((result) => ({
    id: result.record.id,
    kind: result.record.kind,
    title: result.record.title,
    content: result.record.content,
    score: Number(result.score.toFixed(4)),
    confidence: result.record.confidence,
    reasons: result.reasons,
    sourceTaskId: result.record.sourceTaskId
  }));
}

function extractChangedFiles(artifacts: Artifact[]): string[] {
  const diffArtifacts = artifacts.filter((artifact) => artifact.type === "diff");
  return diffArtifacts.map((artifact) => artifact.path).filter((value): value is string => Boolean(value));
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3)
  );
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
