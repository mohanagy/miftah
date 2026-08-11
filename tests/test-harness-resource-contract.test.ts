import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface TestFixtureBuilder {
  buildTestFixtureSource(entryPoint?: string): Promise<string>;
}

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

  it("preserves indented blank lines inside bundled template literals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-fixture-template-"));
    try {
      const entryPath = join(directory, "entry.mjs");
      const outputPath = join(directory, "output.mjs");
      const expected = "first\n   \nlast";
      await writeFile(entryPath, ["export const fixture = `first", "   ", "last`;", ""].join("\n"));
      // @ts-expect-error The production fixture builder is intentionally plain Node ESM.
      const builder = await import("../scripts/build-test-fixture.mjs") as TestFixtureBuilder;
      const output = await builder.buildTestFixtureSource(entryPath);
      expect(output).not.toMatch(/^[\t ]+$/mu);
      await writeFile(outputPath, output);
      const bundled = await import(`${pathToFileURL(outputPath).href}?test=${Date.now()}`) as { fixture: string };
      expect(bundled.fixture).toBe(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
