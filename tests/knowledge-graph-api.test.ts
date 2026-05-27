import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
});

async function createConfigFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-knowledge-graph-"));
  const configDir = path.join(dir, "config");
  await mkdir(configDir, { recursive: true });
  await Promise.all(
    ["agents", "repositories", "sandbox", "policies", "tools"].map((section) =>
      copyFile(
        path.join(process.cwd(), "config", `${section}.example.yaml`),
        path.join(configDir, `${section}.example.yaml`),
      ),
    ),
  );
  return dir;
}
