import { defineConfig } from "vitest/config";
import { packageVersion } from "./build/package-version.js";

export default defineConfig({
  define: {
    __MIFTAH_VERSION__: JSON.stringify(packageVersion)
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    // Real upstream fixtures have one-second startup limits; run files serially to prevent contention.
    fileParallelism: false,
    // Replace the fork between serial files so process-backed tests cannot retain
    // handles or lifecycle state from an earlier file; module isolation remains enabled.
    poolOptions: { forks: { singleFork: false, isolate: true } },
    coverage: {
      provider: "v8",
      include: [
        "src/config/**/*.ts",
        "src/http/authenticated-request-context.ts",
        "src/profiles/profile-context-handle.ts",
        "src/secrets/**/*.ts",
        "src/mcp/server/operation-pipeline.ts",
        "src/mcp/server/tool-registry.ts",
        "src/mcp/server/resource-prompt-registry.ts",
        "src/upstream/contained-stdio-transport.ts",
        "src/upstream/upstream-process-manager.ts",
        "src/upstream/remote-error.ts"
      ],
      reporter: ["text", "json-summary"],
      exclude: process.platform === "win32" ? [] : ["src/secrets/windows-secret-command.ts"],
      thresholds: {
        "src/config/**/*.ts": { lines: 95, functions: 95, branches: 85 },
        "src/http/authenticated-request-context.ts": { lines: 95, functions: 100, branches: 90 },
        "src/profiles/profile-context-handle.ts": { lines: 95, functions: 100, branches: 90 },
        "src/secrets/**/*.ts": { lines: 93, functions: 95, branches: 90 },
        "src/mcp/server/operation-pipeline.ts": { lines: 85, functions: 95, branches: 75 },
        "src/mcp/server/tool-registry.ts": { lines: 93, functions: 95, branches: 90 },
        "src/mcp/server/resource-prompt-registry.ts": { lines: 95, functions: 95, branches: 90 },
        "src/upstream/contained-stdio-transport.ts": { lines: 90, functions: 95, branches: 85 },
        "src/upstream/upstream-process-manager.ts": { lines: 92, functions: 95, branches: 88 },
        "src/upstream/remote-error.ts": { lines: 90, functions: 95, branches: 78 }
      }
    }
  }
});
