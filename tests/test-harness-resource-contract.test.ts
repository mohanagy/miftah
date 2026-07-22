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
});
