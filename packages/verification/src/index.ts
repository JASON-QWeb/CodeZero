import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import type { QualityGateKind, QualityGateResult } from "@agent/shared";

export type QualityGateCommand = {
  kind: QualityGateKind;
  command: string;
  required: boolean;
};

export type QualityGateConfig = {
  setup?: string;
  build?: string;
  lint?: string;
  typecheck?: string;
  unitTest?: string;
  frontendScreenshot?: string;
};

export function createQualityGateCommands(
  config: QualityGateConfig,
): QualityGateCommand[] {
  return [
    config.setup
      ? { kind: "setup", command: config.setup, required: true }
      : undefined,
    config.build
      ? { kind: "build", command: config.build, required: true }
      : undefined,
    config.lint
      ? { kind: "lint", command: config.lint, required: true }
      : undefined,
    config.typecheck
      ? { kind: "typecheck", command: config.typecheck, required: true }
      : undefined,
    config.unitTest
      ? { kind: "unit_test", command: config.unitTest, required: true }
      : undefined,
    config.frontendScreenshot
      ? {
          kind: "frontend_screenshot",
          command: config.frontendScreenshot,
          required: true,
        }
      : undefined,
  ].filter((command): command is QualityGateCommand => command !== undefined);
}

export async function runQualityGate(
  cwd: string,
  gate: QualityGateCommand,
): Promise<QualityGateResult> {
  const startedAt = Date.now();
  const output: string[] = [];

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(gate.command, {
      cwd,
      shell: true,
      env: process.env,
    });

    child.stdout.on("data", (chunk: Buffer) =>
      output.push(chunk.toString("utf8")),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      output.push(chunk.toString("utf8")),
    );
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  return {
    kind: gate.kind,
    command: gate.command,
    passed: exitCode === 0,
    exitCode,
    durationMs: Date.now() - startedAt,
    output: output.join("").slice(-12_000),
  };
}

export async function runQualityGates(
  cwd: string,
  gates: QualityGateCommand[],
): Promise<QualityGateResult[]> {
  const results: QualityGateResult[] = [];
  const consumed = new Set<QualityGateCommand>();

  await runSequential(cwd, gates, results, consumed, "setup");
  await runSequential(cwd, gates, results, consumed, "build");

  const staticAnalysisGates = gates.filter(
    (gate) =>
      (gate.kind === "lint" || gate.kind === "typecheck") &&
      !consumed.has(gate),
  );
  staticAnalysisGates.forEach((gate) => consumed.add(gate));
  results.push(
    ...(await Promise.all(
      staticAnalysisGates.map((gate) => runQualityGate(cwd, gate)),
    )),
  );

  await runSequential(cwd, gates, results, consumed, "unit_test");
  await runSequential(cwd, gates, results, consumed, "frontend_screenshot");

  for (const gate of gates) {
    if (!consumed.has(gate)) {
      consumed.add(gate);
      results.push(await runQualityGate(cwd, gate));
    }
  }

  return results;
}

async function runSequential(
  cwd: string,
  gates: QualityGateCommand[],
  results: QualityGateResult[],
  consumed: Set<QualityGateCommand>,
  kind: QualityGateKind,
): Promise<void> {
  for (const gate of gates) {
    if (gate.kind === kind && !consumed.has(gate)) {
      consumed.add(gate);
      results.push(await runQualityGate(cwd, gate));
    }
  }
}

export type ScreenshotTarget = {
  url: string;
  name?: string;
};

export type ScreenshotResult = {
  url: string;
  viewport: "desktop" | "mobile";
  path: string;
};

export async function runFrontendScreenshotGate(input: {
  cwd: string;
  devCommand: string;
  targets: ScreenshotTarget[];
  artifactDir: string;
  chromeExecutablePath?: string;
  timeoutMs?: number;
}): Promise<{ gate: QualityGateResult; screenshots: ScreenshotResult[] }> {
  const startedAt = Date.now();
  const output: string[] = [];
  const screenshots: ScreenshotResult[] = [];
  let childExitCode: number | null | undefined;
  const child = spawn(input.devCommand, {
    cwd: input.cwd,
    shell: true,
    env: process.env,
    detached: process.platform !== "win32",
  });

  child.stdout.on("data", (chunk: Buffer) =>
    output.push(chunk.toString("utf8")),
  );
  child.stderr.on("data", (chunk: Buffer) =>
    output.push(chunk.toString("utf8")),
  );
  child.on("close", (code) => {
    childExitCode = code;
  });

  try {
    await mkdir(input.artifactDir, { recursive: true });
    await waitForTargets(
      input.targets.map((target) => target.url),
      input.timeoutMs ?? 60_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const earlyExitCode = observedChildExitCode(child, childExitCode);
    if (earlyExitCode !== undefined) {
      throw new Error(
        `Frontend dev command exited before screenshot capture with code ${earlyExitCode ?? "unknown"}`,
      );
    }

    const browser = await chromium.launch({
      executablePath:
        input.chromeExecutablePath ?? defaultChromeExecutablePath(),
      headless: true,
    });

    try {
      for (const target of input.targets) {
        for (const viewport of [
          { name: "desktop" as const, width: 1440, height: 900 },
          { name: "mobile" as const, width: 390, height: 844 },
        ]) {
          const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height },
          });
          const consoleErrors: string[] = [];
          page.on("console", (message) => {
            if (message.type() === "error") {
              consoleErrors.push(message.text());
            }
          });
          await page.goto(target.url, {
            waitUntil: "networkidle",
            timeout: input.timeoutMs ?? 60_000,
          });
          const fileName = `${sanitizeFileName(target.name ?? target.url)}-${viewport.name}.png`;
          const screenshotPath = path.join(input.artifactDir, fileName);
          await page.screenshot({ path: screenshotPath, fullPage: true });
          await page.close();

          if (consoleErrors.length > 0) {
            output.push(
              `Console errors for ${target.url}: ${consoleErrors.join("\n")}`,
            );
          }

          screenshots.push({
            url: target.url,
            viewport: viewport.name,
            path: screenshotPath,
          });
        }
      }
    } finally {
      await browser.close();
    }

    const finalExitCode = observedChildExitCode(child, childExitCode);
    if (finalExitCode !== undefined) {
      throw new Error(
        `Frontend dev command exited before screenshot capture with code ${finalExitCode ?? "unknown"}`,
      );
    }

    const consoleErrorOutput = output.filter((line) =>
      line.includes("Console errors for"),
    );
    if (consoleErrorOutput.length > 0) {
      throw new Error(
        `Frontend screenshot console errors detected:\n${consoleErrorOutput.join("\n")}`,
      );
    }

    return {
      gate: {
        kind: "frontend_screenshot",
        command: input.devCommand,
        passed: true,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        output: output.join("").slice(-12_000),
      },
      screenshots,
    };
  } catch (error) {
    return {
      gate: {
        kind: "frontend_screenshot",
        command: input.devCommand,
        passed: false,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        output:
          `${output.join("")}\n${error instanceof Error ? error.message : String(error)}`.slice(
            -12_000,
          ),
      },
      screenshots,
    };
  } finally {
    await terminateDevProcess(child);
  }
}

function observedChildExitCode(
  child: ChildProcess,
  closeEventExitCode: number | null | undefined,
): number | null | undefined {
  if (closeEventExitCode !== undefined) {
    return closeEventExitCode;
  }

  return child.exitCode === null ? undefined : child.exitCode;
}

async function terminateDevProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return;
  }

  sendSignal(child, "SIGTERM");
  if (await waitForProcessClose(child, 5_000)) {
    return;
  }

  sendSignal(child, "SIGKILL");
  await waitForProcessClose(child, 1_000);
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the shell process if process-group termination fails.
  }

  try {
    child.kill(signal);
  } catch {
    // The process may have already exited between checks.
  }
}

function waitForProcessClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", onClose);
  });
}

async function waitForTargets(
  urls: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const results = await Promise.all(
      urls.map(async (url) =>
        fetch(url, { method: "GET" }).then(
          (response) => response.ok,
          () => false,
        ),
      ),
    );

    if (results.every(Boolean)) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for screenshot URLs: ${urls.join(", ")}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function defaultChromeExecutablePath(): string | undefined {
  return (
    process.env.CHROME_EXECUTABLE_PATH ??
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined)
  );
}

function sanitizeFileName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "page"
  );
}
