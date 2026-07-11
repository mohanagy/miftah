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
    coverage: {
      provider: "v8",
      include: [
        "src/config/**/*.ts",
        "src/secrets/**/*.ts",
        "src/mcp/server/operation-pipeline.ts",
        "src/mcp/server/tool-registry.ts",
        "src/mcp/server/resource-prompt-registry.ts",
        "src/upstream/upstream-process-manager.ts",
        "src/upstream/remote-error.ts"
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        "src/config/**/*.ts": { lines: 95, functions: 95, branches: 85 },
        "src/secrets/**/*.ts": { lines: 93, functions: 95, branches: 90 },
        "src/mcp/server/operation-pipeline.ts": { lines: 85, functions: 95, branches: 75 },
        "src/mcp/server/tool-registry.ts": { lines: 93, functions: 95, branches: 90 },
        "src/mcp/server/resource-prompt-registry.ts": { lines: 95, functions: 95, branches: 90 },
        "src/upstream/upstream-process-manager.ts": { lines: 92, functions: 95, branches: 88 },
        "src/upstream/remote-error.ts": { lines: 90, functions: 95, branches: 78 }
      }
    }
  }
});
