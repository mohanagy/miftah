import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("test harness resource contract", () => {
  it("does not copy the Node runtime merely to create executable path markers", async () => {
    for (const relativePath of ["tests/executable-resolver.test.ts", "tests/secret-providers.test.ts"]) {
      const source = await readFile(join(process.cwd(), relativePath), "utf8");
      expect(source, relativePath).not.toContain("copyFile(process.execPath");
    }
  });

  it("records the direct provider PID before testing post-exit descendant cleanup", async () => {
    const source = await readFile(join(process.cwd(), "tests/fixtures/posix-descendant-provider.sh"), "utf8");

    expect(source).toContain("{\"providerPid\":%s,\"descendantPid\":%s}");
  });

  it("enables the shared Node compile cache before loading the real MCP fixture runtime", async () => {
    const source = await readFile(join(process.cwd(), "tests/fixtures/fake-upstream.mjs"), "utf8");

    expect(source).toContain("module.enableCompileCache()");
    expect(source).toContain('await import("./fake-upstream-bundled.mjs")');
    const bundleCheck = spawnSync(process.execPath, ["scripts/build-test-fixture.mjs", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000
    });
    expect(bundleCheck.error).toBeUndefined();
    expect(bundleCheck.status, bundleCheck.stderr).toBe(0);
  });
});
