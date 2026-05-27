import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonObject } from "@agent/shared";
import { runProcess } from "./process-runner.js";
import { expectOptionalNumber, expectString, normalizeRelativePath, resolveInsideRepo } from "./utils.js";
import { ToolRegistry } from "./gateway.js";

export function createBuiltInToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    {
      name: "repo.read_file",
      description: "Read a UTF-8 file inside the task repository.",
      permission: "read",
      timeoutMs: 10_000
    },
    async (input, context) => {
      const relativePath = expectString(input.path, "path");
      const maxBytes = expectOptionalNumber(input.maxBytes) ?? 24_000;
      const filePath = resolveInsideRepo(context.repoDir, relativePath);
      const content = await readFile(filePath, "utf8");
      return {
        path: normalizeRelativePath(relativePath),
        content: content.slice(0, maxBytes),
        truncated: content.length > maxBytes
      };
    }
  );

  registry.register(
    {
      name: "repo.apply_patch",
      description: "Apply a unified diff to the task repository.",
      permission: "repo_write",
      timeoutMs: 30_000
    },
    async (input, context) => {
      const unifiedDiff = typeof input.unifiedDiff === "string" ? input.unifiedDiff : expectString(input.patch, "patch");
      const patchPath = path.join(context.repoDir, `.agent-tool-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);
      await writeFile(patchPath, unifiedDiff);

      try {
        return await runProcess({
          command: "git",
          args: ["apply", "--recount", "--whitespace=nowarn", patchPath],
          cwd: context.repoDir,
          timeoutMs: 30_000,
          env: context.env
        });
      } finally {
        await rm(patchPath, { force: true });
      }
    }
  );

  registry.register(
    {
      name: "repo.write_file",
      description: "Create or replace a UTF-8 file inside the task repository.",
      permission: "repo_write",
      timeoutMs: 30_000
    },
    async (input, context) => {
      const relativePath = expectString(input.path, "path");
      const content = expectText(input.content, "content");
      const filePath = resolveInsideRepo(context.repoDir, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");

      return {
        path: normalizeRelativePath(relativePath),
        bytes: Buffer.byteLength(content, "utf8")
      };
    }
  );

  registry.register(
    {
      name: "repo.replace_text",
      description: "Replace exact text in a UTF-8 file inside the task repository.",
      permission: "repo_write",
      timeoutMs: 30_000
    },
    async (input, context) => {
      const relativePath = expectString(input.path, "path");
      const search = expectString(input.search, "search");
      const replace = expectText(input.replace, "replace");
      const replaceAll = input.replaceAll === true;
      const filePath = resolveInsideRepo(context.repoDir, relativePath);
      const current = await readFile(filePath, "utf8");
      const occurrences = countOccurrences(current, search);

      if (occurrences === 0) {
        throw new Error(`Search text was not found in ${normalizeRelativePath(relativePath)}`);
      }

      if (occurrences > 1 && !replaceAll) {
        throw new Error(`Search text matched ${occurrences} times in ${normalizeRelativePath(relativePath)}; set replaceAll true or provide a more specific search`);
      }

      const updated = replaceAll ? current.split(search).join(replace) : current.replace(search, replace);
      await writeFile(filePath, updated, "utf8");

      return {
        path: normalizeRelativePath(relativePath),
        replacements: replaceAll ? occurrences : 1
      };
    }
  );

  registry.register(
    {
      name: "repo.search",
      description: "Search repository text with ripgrep.",
      permission: "read",
      timeoutMs: 10_000
    },
    async (input, context) => {
      const query = expectString(input.query, "query");
      const glob = typeof input.glob === "string" ? input.glob : undefined;
      const maxResults = expectOptionalNumber(input.maxResults) ?? 50;
      const args = ["--line-number", "--no-heading", "--color", "never", query];

      if (glob) {
        args.push("--glob", glob);
      }

      const result = await runProcess({
        command: "rg",
        args,
        cwd: context.repoDir,
        timeoutMs: 10_000,
        env: context.env
      });
      return {
        query,
        exitCode: result.exitCode,
        matches: result.stdout
          .split("\n")
          .filter(Boolean)
          .slice(0, maxResults)
          .map(parseRipgrepLine)
      };
    }
  );

  registry.register(
    {
      name: "codegraph.query",
      description: "Query the prebuilt CodeGraph index for symbols and source locations.",
      permission: "read",
      timeoutMs: 30_000
    },
    async (input, context) => {
      const query = expectString(input.query, "query");
      const packageName =
        typeof input.packageName === "string" ? input.packageName : process.env.CODEGRAPH_PACKAGE ?? "@colbymchenry/codegraph@0.9.3";
      const args = ["-y", packageName, "query", query, "--path", context.repoDir, "--json"];
      const kind = typeof input.kind === "string" ? input.kind : undefined;
      const limit = expectOptionalNumber(input.limit);

      if (kind) {
        args.push("--kind", kind);
      }

      if (limit) {
        args.push("--limit", String(limit));
      }

      const result = await runProcess({
        command: "npx",
        args,
        cwd: context.repoDir,
        timeoutMs: expectOptionalNumber(input.timeoutMs) ?? 30_000,
        env: context.env
      });
      return {
        query,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }
  );

  registry.register(
    {
      name: "codegraph.context",
      description: "Build task context from the prebuilt CodeGraph index.",
      permission: "read",
      timeoutMs: 30_000
    },
    async (input, context) => {
      const task = expectString(input.task, "task");
      const packageName =
        typeof input.packageName === "string" ? input.packageName : process.env.CODEGRAPH_PACKAGE ?? "@colbymchenry/codegraph@0.9.3";
      const args = ["-y", packageName, "context", task, "--path", context.repoDir, "--format", "json"];
      const maxNodes = expectOptionalNumber(input.maxNodes);
      const maxCode = expectOptionalNumber(input.maxCode);

      if (maxNodes) {
        args.push("--max-nodes", String(maxNodes));
      }

      if (maxCode) {
        args.push("--max-code", String(maxCode));
      }

      if (input.includeCode === false) {
        args.push("--no-code");
      }

      const result = await runProcess({
        command: "npx",
        args,
        cwd: context.repoDir,
        timeoutMs: expectOptionalNumber(input.timeoutMs) ?? 30_000,
        env: context.env
      });
      return {
        task,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }
  );

  registry.register(
    {
      name: "shell.run",
      description: "Run an allowlisted shell command in the task repository.",
      permission: "repo_write",
      timeoutMs: 120_000,
      policyRefs: ["block-dangerous-shell"]
    },
    async (input, context) => {
      const command = expectString(input.command, "command");
      const result = await runProcess({
        command,
        args: [],
        cwd: context.repoDir,
        shell: true,
        timeoutMs: expectOptionalNumber(input.timeoutMs) ?? 120_000,
        env: context.env
      });
      return result;
    }
  );

  return registry;
}

function parseRipgrepLine(line: string): JsonObject {
  const [file, lineNumber, ...rest] = line.split(":");
  return {
    path: file ?? "",
    line: Number(lineNumber ?? 0),
    text: rest.join(":")
  };
}

function expectText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  return value;
}

function countOccurrences(content: string, search: string): number {
  return content.split(search).length - 1;
}
