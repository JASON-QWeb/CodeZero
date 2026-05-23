import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQualityGateCommands, runFrontendScreenshotGate, runQualityGate, runQualityGates } from "@agent/verification";

describe("verification", () => {
  it("creates quality gate commands from configured gates only", () => {
    expect(
      createQualityGateCommands({
        build: "pnpm build",
        typecheck: "pnpm typecheck",
        unitTest: "pnpm test"
      })
    ).toEqual([
      { kind: "build", command: "pnpm build", required: true },
      { kind: "typecheck", command: "pnpm typecheck", required: true },
      { kind: "unit_test", command: "pnpm test", required: true }
    ]);
  });

  it("runs quality gates and captures pass/fail output", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-verification-"));
    const passed = await runQualityGate(cwd, { kind: "unit_test", command: "printf ok", required: true });
    const failed = await runQualityGate(cwd, { kind: "lint", command: "printf nope && exit 2", required: true });

    expect(passed).toMatchObject({ passed: true, exitCode: 0, output: "ok" });
    expect(failed.passed).toBe(false);
    expect(failed.exitCode).toBe(2);
    expect(failed.output).toContain("nope");
  });

  it("runs quality gates sequentially", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-verification-"));
    const results = await runQualityGates(cwd, [
      { kind: "build", command: "printf build", required: true },
      { kind: "typecheck", command: "printf types", required: true }
    ]);

    expect(results.map((result) => result.kind)).toEqual(["build", "typecheck"]);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it("returns a failed frontend screenshot gate when configured URLs never become ready", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-verification-"));
    const result = await runFrontendScreenshotGate({
      cwd,
      devCommand: "node -e \"setTimeout(() => {}, 1000)\"",
      targets: [{ url: "http://127.0.0.1:9/", name: "unreachable" }],
      artifactDir: path.join(cwd, "screenshots"),
      timeoutMs: 1
    });

    expect(result.gate.passed).toBe(false);
    expect(result.gate.output).toContain("Timed out waiting for screenshot URLs");
    expect(result.screenshots).toEqual([]);
  });
});
