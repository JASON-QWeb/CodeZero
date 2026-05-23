import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.js";

export async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  shell?: boolean;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
}): Promise<ProcessResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: input.shell ?? false,
      env: { ...process.env, ...input.env },
      signal: controller.signal
    });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  clearTimeout(timeout);

  return {
    exitCode,
    stdout: stdout.join("").slice(-24_000),
    stderr: stderr.join("").slice(-24_000)
  };
}
