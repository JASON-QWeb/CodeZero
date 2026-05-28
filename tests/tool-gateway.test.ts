import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBuiltInToolRegistry, parseJsonActionPlan, runJsonActionPlan, ToolGateway, type PolicyDefinition } from "@agent/tool-gateway";

describe("tool gateway", () => {
  it("executes registered repo tools inside the repository root", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-tool-gateway-"));
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src/refund.ts"), "export const refundStatus = 'pending';\n");

    const gateway = new ToolGateway({ registry: createBuiltInToolRegistry() });
    const result = await gateway.execute(
      {
        toolName: "repo.read_file",
        input: { path: "src/refund.ts" }
      },
      { repoDir }
    );

    expect(result.status).toBe("success");
    expect(JSON.stringify(result.output)).toContain("refundStatus");
  });

  it("registers CodeGraph read-only code graph tools", () => {
    const tools = createBuiltInToolRegistry().list();
    const queryTool = tools.find((item) => item.name === "codegraph.query");
    const contextTool = tools.find((item) => item.name === "codegraph.context");

    expect(queryTool?.permission).toBe("read");
    expect(queryTool?.description).toContain("CodeGraph");
    expect(contextTool?.permission).toBe("read");
  });

  it("blocks dangerous shell commands before execution", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-tool-gateway-"));
    const policies: PolicyDefinition[] = [
      {
        id: "block-dangerous-shell",
        matchCommands: ["rm -rf"],
        action: "block"
      }
    ];
    const gateway = new ToolGateway({ registry: createBuiltInToolRegistry(), policies });
    const result = await gateway.execute(
      {
        toolName: "shell.run",
        input: { command: "rm -rf ." }
      },
      { repoDir }
    );

    expect(result.status).toBe("blocked");
    expect(result.policyDecisions[0]?.policyId).toBe("block-dangerous-shell");
  });

  it("returns approval_required for guarded paths", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-tool-gateway-"));
    await writeFile(path.join(repoDir, ".env.local"), "SECRET=value\n");
    const policies: PolicyDefinition[] = [
      {
        id: "block-secret-files",
        matchPaths: [".env*"],
        action: "require_approval"
      }
    ];
    const gateway = new ToolGateway({ registry: createBuiltInToolRegistry(), policies });
    const result = await gateway.execute(
      {
        toolName: "repo.read_file",
        input: { path: ".env.local" }
      },
      { repoDir }
    );

    expect(result.status).toBe("approval_required");
    expect(result.policyDecisions[0]?.reasons).toContain("path matched .env*");
  });

  it("parses JSON action plans and executes them through the gateway", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-tool-gateway-"));
    await writeFile(path.join(repoDir, "README.md"), "# Demo\n");
    const plan = parseJsonActionPlan(`
      \`\`\`json
      {
        "actions": [
          {
            "id": "read-readme",
            "tool": "repo.read_file",
            "input": { "path": "README.md" }
          }
        ]
      }
      \`\`\`
    `);
    const gateway = new ToolGateway({ registry: createBuiltInToolRegistry() });
    const results = await runJsonActionPlan({ gateway, plan, context: { repoDir }, taskId: "task-1" });

    expect(plan.actions[0]?.toolName).toBe("repo.read_file");
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("success");
    expect(results[0]?.taskId).toBe("task-1");
  });

  it("marks non-zero process tool results as failed", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-tool-gateway-"));
    const gateway = new ToolGateway({ registry: createBuiltInToolRegistry() });
    const result = await gateway.execute(
      {
        toolName: "shell.run",
        input: { command: "printf 'boom' >&2; exit 3" }
      },
      { repoDir }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Process exited with code");
    expect(JSON.stringify(result.output)).toContain("exitCode");
  });

  it("evaluates path policy against repository read paths", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-tool-gateway-"));
    await writeFile(path.join(repoDir, ".env"), "SECRET=old\n");
    const gateway = new ToolGateway({
      registry: createBuiltInToolRegistry(),
      policies: [{ id: "block-secret-files", matchPaths: [".env*"], action: "block" }]
    });
    const result = await gateway.execute(
      {
        toolName: "repo.read_file",
        input: { path: ".env" }
      },
      { repoDir }
    );

    expect(result.status).toBe("blocked");
    expect(result.policyDecisions[0]?.reasons).toContain("path matched .env*");
  });
});
