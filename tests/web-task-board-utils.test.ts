import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@agent/shared";
import { fetchMemories, fetchRepositoryQueues, fetchTasks, fetchTrace, updateMemoryStatus } from "../apps/web/src/features/tasks/api";
import { mockMemories, mockTasks, mockTrace } from "../apps/web/src/features/tasks/demo-data";
import { buildRepositorySummariesFromTasks, isQueuedStatus, isRunningStatus } from "../apps/web/src/features/tasks/repository-summary";
import { formatTime } from "../apps/web/src/features/tasks/time";

describe("web task board utilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  it("summarizes demo tasks by repository status buckets", () => {
    const summaries = buildRepositorySummariesFromTasks(mockTasks);
    const commerce = summaries.find((summary) => summary.fullName === "demo/commerce");
    const billing = summaries.find((summary) => summary.fullName === "demo/billing");

    expect(commerce).toMatchObject({
      runningCount: 1,
      queuedCount: 1,
      availableSlots: 1
    });
    expect(billing).toMatchObject({
      reviewCount: 1,
      maxConcurrentIssues: 1
    });
    expect(isQueuedStatus("QUEUED")).toBe(true);
    expect(isRunningStatus("IMPLEMENTING")).toBe(true);
    expect(isRunningStatus("DONE")).toBe(false);
  });

  it("formats UTC timestamps for dense task rows", () => {
    expect(formatTime("2026-05-12T10:05:00.000Z")).toBe("May 12, 10:05 UTC");
  });

  it("builds a demo trace with consistent summary counts", () => {
    const trace = mockTrace(mockTasks[0] as Task);

    expect(trace.summary.totalSpans).toBe(trace.spans.length);
    expect(trace.spans.map((span) => span.kind)).toContain("quality_gate");
  });

  it("fetches task board resources from the configured API base URL", async () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tasks")) {
        return ok({ tasks: mockTasks });
      }
      if (url.endsWith("/tasks/repositories")) {
        return ok({ repositories: buildRepositorySummariesFromTasks(mockTasks) });
      }
      if (url.endsWith(`/tasks/${mockTasks[0]?.id}/trace`)) {
        return ok({ trace: mockTrace(mockTasks[0] as Task) });
      }
      if (url.endsWith("/memories?status=proposed")) {
        return ok({ memories: mockMemories });
      }
      return ok({ memory: { ...mockMemories[0], status: "approved" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTasks()).resolves.toHaveLength(mockTasks.length);
    await expect(fetchRepositoryQueues()).resolves.toHaveLength(2);
    await expect(fetchTrace(mockTasks[0]?.id ?? "")).resolves.toMatchObject({ taskId: mockTasks[0]?.id });
    await expect(fetchMemories("proposed")).resolves.toEqual(mockMemories);
    await expect(updateMemoryStatus({ id: mockMemories[0]?.id ?? "", status: "approved" })).resolves.toMatchObject({ status: "approved" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.test/tasks");
  });

  it("raises clear errors for failed task board fetches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));

    await expect(fetchTasks()).rejects.toThrow("Failed to load tasks");
    await expect(fetchRepositoryQueues()).rejects.toThrow("Failed to load repository queues");
    await expect(fetchTrace("task-1")).rejects.toThrow("Failed to load task trace");
    await expect(fetchMemories("proposed")).rejects.toThrow("Failed to load memories");
    await expect(updateMemoryStatus({ id: "memory-1", status: "rejected" })).rejects.toThrow("Failed to update memory");
  });
});

function ok(body: unknown): { ok: true; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: async () => body
  };
}
