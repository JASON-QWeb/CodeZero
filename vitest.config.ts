import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@agent/config": new URL("./packages/config/src/index.ts", import.meta.url).pathname,
      "@agent/persistence": new URL("./packages/persistence/src/index.ts", import.meta.url).pathname,
      "@agent/orchestrator": new URL("./packages/orchestrator/src/index.ts", import.meta.url).pathname,
      "@agent/codebase-intelligence": new URL("./packages/codebase-intelligence/src/index.ts", import.meta.url).pathname,
      "@agent/sandbox": new URL("./packages/sandbox/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"]
  }
});
