import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { resetServicesForTests } from "../apps/api/src/services/task-services.js";
import { resetUnderstandAnythingProcessesForTests } from "../apps/api/src/services/understand-anything.js";

describe("Understand-Anything project knowledge graph API", () => {
  afterEach(() => {
    delete process.env.PROJECT_ROOT;
    delete process.env.UNDERSTAND_ANYTHING_PLUGIN_ROOT;
    resetServicesForTests();
    resetUnderstandAnythingProcessesForTests();
  });

  it("reports the official graph artifact for a configured repository", async () => {
    const dir = await createConfigFixture();
    const pluginRoot = path.join(dir, "official-plugin");
    await mkdir(path.join(pluginRoot, "skills", "understand"), {
      recursive: true,
    });
    await writeFile(
      path.join(pluginRoot, "skills", "understand", "SKILL.md"),
      "# official understand skill\n",
    );
    await mkdir(
      path.join(
        dir,
        "data",
        "understand-anything",
        "your-org--your-repo",
        "repo",
        ".understand-anything",
      ),
      { recursive: true },
    );
    await writeFile(
      path.join(
        dir,
        "data",
        "understand-anything",
        "your-org--your-repo",
        "repo",
        ".understand-anything",
        "knowledge-graph.json",
      ),
      JSON.stringify({
        project: { name: "Checkout", analyzedAt: "2026-05-27T10:00:00.000Z" },
        nodes: [{ id: "file:src/index.ts" }],
        edges: [{ source: "file:src/index.ts", target: "file:src/api.ts" }],
      }),
    );
    process.env.PROJECT_ROOT = dir;
    process.env.UNDERSTAND_ANYTHING_PLUGIN_ROOT = pluginRoot;
    const app = await buildServer();

    const response = await app.inject({
      method: "GET",
      url: "/repositories/example-web/knowledge-graph",
    });
    const state = response.json<{
      knowledgeGraph: {
        status: string;
        graphAvailable: boolean;
        pluginInstalled: boolean;
        graph: { projectName: string; nodes: number; edges: number };
        provider: {
          projectUrl: string;
          outputFile: string;
          testedVersion: string;
        };
      };
    }>().knowledgeGraph;

    expect(response.statusCode).toBe(200);
    expect(state).toMatchObject({
      status: "ready",
      graphAvailable: true,
      pluginInstalled: true,
      graph: { projectName: "Checkout", nodes: 1, edges: 1 },
      provider: {
        projectUrl: "https://github.com/Lum1104/Understand-Anything",
        outputFile: ".understand-anything/knowledge-graph.json",
        testedVersion: "v2.7.3",
      },
    });

    await app.close();
  });

  it("refuses generation when the official plugin is not installed", async () => {
    const dir = await createConfigFixture();
    process.env.PROJECT_ROOT = dir;
    process.env.UNDERSTAND_ANYTHING_PLUGIN_ROOT = path.join(
      dir,
      "missing-plugin",
    );
    const app = await buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/repositories/example-web/knowledge-graph/generate",
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toContain(
      "official Codex integration",
    );

    await app.close();
  });

  it("requires a generated graph before starting the upstream dashboard", async () => {
    const dir = await createConfigFixture();
    process.env.PROJECT_ROOT = dir;
    const app = await buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/repositories/example-web/knowledge-graph/dashboard",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toContain(
      "Generate it first",
    );

    await app.close();
  });

  it("lists and saves repository skill and rule files", async () => {
    const dir = await createConfigFixture();
    const repoDir = path.join(
      dir,
      "data",
      "understand-anything",
      "your-org--your-repo",
      "repo",
    );
    await mkdir(path.join(repoDir, ".git"), { recursive: true });
    await mkdir(path.join(repoDir, ".agent", "skills", "refunds"), {
      recursive: true,
    });
    await mkdir(path.join(repoDir, ".agent", "rules"), { recursive: true });
    await writeFile(
      path.join(repoDir, ".agent", "skills", "refunds", "SKILL.md"),
      "# Refund skill\n",
    );
    await writeFile(
      path.join(repoDir, ".agent", "rules", "checkout.md"),
      "# Checkout rule\n",
    );
    process.env.PROJECT_ROOT = dir;
    const app = await buildServer();

    const listResponse = await app.inject({
      method: "GET",
      url: "/repositories/example-web/context-files",
    });
    const files = listResponse.json<{
      files: Array<{
        kind: string;
        path: string;
        name: string;
        content: string;
      }>;
    }>().files;

    expect(listResponse.statusCode).toBe(200);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          path: ".agent/skills/refunds/SKILL.md",
          name: "refunds",
          content: "# Refund skill\n",
        }),
        expect.objectContaining({
          kind: "rule",
          path: ".agent/rules/checkout.md",
          name: "checkout.md",
          content: "# Checkout rule\n",
        }),
      ]),
    );

    const saveResponse = await app.inject({
      method: "PUT",
      url: "/repositories/example-web/context-files",
      payload: {
        kind: "rule",
        path: ".agent/rules/testing.md",
        content: "# Testing rule\n",
      },
    });

    expect(saveResponse.statusCode).toBe(200);
    await expect(
      readFile(path.join(repoDir, ".agent", "rules", "testing.md"), "utf8"),
    ).resolves.toBe("# Testing rule\n");

    const blockedResponse = await app.inject({
      method: "PUT",
      url: "/repositories/example-web/context-files",
      payload: {
        kind: "rule",
        path: "../outside.md",
        content: "# Outside\n",
      },
    });

    expect(blockedResponse.statusCode).toBe(409);

    const englishBlockedResponse = await app.inject({
      method: "PUT",
      url: "/repositories/example-web/context-files",
      headers: { "accept-language": "en-US" },
      payload: {
        kind: "skill",
        path: ".agent/skills/refunds/not-skill.md",
        content: "# Invalid skill\n",
      },
    });

    expect(englishBlockedResponse.statusCode).toBe(409);
    expect(
      englishBlockedResponse.json<{ message: string }>().message,
    ).toContain("SKILL.md");

    await app.close();
  });
});

async function createConfigFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-knowledge-graph-"));
  const configDir = path.join(dir, "config");
  await mkdir(configDir, { recursive: true });
  await Promise.all([
    copyFile(
      path.join(process.cwd(), "config", "codezero.example.yaml"),
      path.join(configDir, "codezero.yaml"),
    ),
    copyFile(
      path.join(process.cwd(), "config", "codezero.example.yaml"),
      path.join(configDir, "codezero.example.yaml"),
    ),
  ]);
  return dir;
}
