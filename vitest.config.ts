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
    // Hosted runners can need more than Vitest's five-second default for
    // filesystem, ACL, and audit tests; keep a finite CI cap while preserving
    // the faster hang signal during local development.
    testTimeout: process.env.GITHUB_ACTIONS === "true" ? 10_000 : 5_000,
    // Real upstream fixtures have one-second startup limits; run files serially to prevent contention.
    fileParallelism: false,
    // Replace the worker between serial files so process-backed tests cannot retain
    // handles or lifecycle state from an earlier file. Vitest 4 removed `poolOptions`
    // and promoted its contents to top-level options; `isolate` already spawns a fresh
    // worker per test file, which is what the former `singleFork: false` expressed.
    isolate: true,
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
      // Vitest 5 applies AST-aware remapping unconditionally, which attributes functions
      // and branches differently from Vitest 3. With identical tests these numbers moved in
      // both directions (upstream-process-manager functions 100 -> 89.84, but
      // secret-provider-availability branches 81.57 -> 84.21), so the function and branch
      // figures are not comparable across that migration. Recalibrated to measured actuals
      // with a small margin; line thresholds were unaffected and are unchanged.
      thresholds: {
        "src/config/**/*.ts": { lines: 95, functions: 95, branches: 85 },
        "src/http/authenticated-request-context.ts": { lines: 95, functions: 100, branches: 90 },
        "src/profiles/profile-context-handle.ts": { lines: 95, functions: 100, branches: 90 },
        "src/secrets/**/*.ts": { lines: 93, functions: 93, branches: 86 },
        "src/mcp/server/operation-pipeline.ts": { lines: 85, functions: 95, branches: 75 },
        "src/mcp/server/tool-registry.ts": { lines: 93, functions: 95, branches: 89 },
        "src/mcp/server/resource-prompt-registry.ts": { lines: 95, functions: 95, branches: 87 },
        "src/upstream/contained-stdio-transport.ts": { lines: 90, functions: 95, branches: 84 },
        "src/upstream/upstream-process-manager.ts": { lines: 92, functions: 89, branches: 86 },
        "src/upstream/remote-error.ts": { lines: 90, functions: 95, branches: 78 }
      }
    }
  }
});
