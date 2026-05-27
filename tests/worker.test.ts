import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkerConcurrency, processIssueWorkflowJob } from "../apps/worker/src/worker.js";

describe("worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes worker concurrency to at least one", () => {
    expect(getWorkerConcurrency("6")).toBe(6);
    expect(getWorkerConcurrency("0")).toBe(1);
    expect(getWorkerConcurrency("not-a-number")).toBe(1);
  });

  it("requeues deferred issue workflows with a retry delay", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const processor = vi.fn().mockResolvedValue({
      taskId: "task-1",
      status: "QUEUED",
      deferred: true,
      retryDelayMs: 1234
    });

    const result = await processIssueWorkflowJob({ taskId: "task-1" }, queue, processor);

    expect(result.deferred).toBe(true);
    expect(queue.add).toHaveBeenCalledWith(
      "run-issue-workflow",
      { taskId: "task-1" },
      expect.objectContaining({ delay: 1234 })
    );
  });

  it("returns completed workflow results without requeueing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const processor = vi.fn().mockResolvedValue({
      taskId: "task-2",
      status: "HUMAN_REVIEW",
      prUrl: "https://github.com/acme/shop/pull/1"
    });

    const result = await processIssueWorkflowJob({ taskId: "task-2" }, queue, processor);

    expect(result.prUrl).toContain("/pull/1");
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does not requeue skipped duplicate workflow jobs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const processor = vi.fn().mockResolvedValue({
      taskId: "task-3",
      status: "IMPLEMENTING",
      skipped: true
    });

    const result = await processIssueWorkflowJob({ taskId: "task-3" }, queue, processor);

    expect(result.skipped).toBe(true);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
