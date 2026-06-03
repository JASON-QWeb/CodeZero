import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileMemoryStore, createTaskMemoryProposal } from "@agent/memory";
import { createTask } from "@agent/orchestrator";
import type { IssueContext } from "@agent/shared";
import { buildServer } from "../apps/api/src/server.js";
import { resetServicesForTests } from "../apps/api/src/services/task-services.js";

const issue: IssueContext = {
  provider: "github",
  owner: "acme",
  repo: "shop",
  number: 8,
  url: "https://github.com/acme/shop/issues/8",
  title: "Remember checkout policy",
  body: "",
  labels: ["checkout"],
  comments: [],
  baseBranch: "main",
};

describe("memory api", () => {
  afterEach(() => {
    delete process.env.MEMORY_STORE_FILE;
    resetServicesForTests();
  });

  it("updates, prunes, and deletes memory records", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-memory-api-"));
    const filePath = path.join(dir, "memory.json");
    process.env.MEMORY_STORE_FILE = filePath;
    const proposal = createTaskMemoryProposal({ task: createTask(issue) });
    await new FileMemoryStore(filePath).propose(proposal.records);
    const app = await buildServer();
    const id = proposal.records[0]?.id ?? "";

    const updated = await app.inject({
      method: "PATCH",
      url: `/memories/${id}`,
      payload: { title: "Updated checkout policy", confidence: 0.9 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ memory: { title: string } }>().memory.title).toBe(
      "Updated checkout policy",
    );

    const pruned = await app.inject({
      method: "POST",
      url: "/memories/prune",
      payload: { maxRecords: 1 },
    });
    expect(pruned.statusCode).toBe(200);
    expect(pruned.json<{ memories: unknown[] }>().memories).toHaveLength(1);

    const deleted = await app.inject({ method: "DELETE", url: `/memories/${id}` });
    expect(deleted.statusCode).toBe(204);
    await app.close();
  });
});
