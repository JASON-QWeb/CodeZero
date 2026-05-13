import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBuiltInToolRegistry, ToolGateway } from "@agent/tool-gateway";
import { createRepositoryPermissionPolicies, repositoryAllowsTool } from "@agent/workflows";

describe("repository tool permissions", () => {
  it("narrows available tools and blocks disallowed tool calls", async () => {
    const repositoryConfig: Parameters<typeof createRepositoryPermissionPolicies>[0] = {
      id: "locked-repo",
      permissions: {
        allowed_tools: ["repo.read_file"],
        blocked_tools: [],
        allowed_permissions: ["read"],
        blocked_permissions: ["dangerous"]
      }
    };
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-repo-permissions-"));
    await writeFile(path.join(repoDir, "README.md"), "# Locked\n");
    const registry = createBuiltInToolRegistry();
    const tools = registry.list();

    expect(repositoryAllowsTool(repositoryConfig, tools.find((tool) => tool.name === "repo.read_file")!)).toBe(true);
    expect(repositoryAllowsTool(repositoryConfig, tools.find((tool) => tool.name === "repo.apply_patch")!)).toBe(false);

    const gateway = new ToolGateway({
      registry,
      policies: createRepositoryPermissionPolicies(repositoryConfig, tools)
    });
    const result = await gateway.execute(
      {
        toolName: "repo.apply_patch",
        input: {
          unifiedDiff: [
            "diff --git a/README.md b/README.md",
            "--- a/README.md",
            "+++ b/README.md",
            "@@ -1 +1 @@",
            "-# Locked",
            "+# Changed",
            ""
          ].join("\n")
        }
      },
      { repoDir }
    );

    expect(result.status).toBe("blocked");
    expect(result.policyDecisions[0]?.policyId).toBe("repo-locked-repo-tool-allowlist");
  });
});
