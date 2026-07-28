import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const testDirectory = new URL("./", import.meta.url);

function readTestFile(name: string): string {
  const target = new URL(name, testDirectory);
  return existsSync(target) ? readFileSync(target, "utf8") : "";
}

describe("upstream manager suite layout", () => {
  it("runs process-heavy lifecycle groups through separate fresh-fork entry files", () => {
    expect(existsSync(new URL("upstream-manager.test.ts", testDirectory))).toBe(false);

    for (const [file, group] of [
      ["upstream-manager-basics.test.ts", "basics"],
      ["upstream-manager-recovery.test.ts", "recovery"],
      ["upstream-manager-teardown.test.ts", "teardown"]
    ] as const) {
      expect(readTestFile(file)).toContain(`registerUpstreamManagerContracts("${group}")`);
    }

    const contracts = readTestFile("helpers/upstream-manager-contracts.ts");
    expect(contracts).toContain('export type UpstreamManagerContractGroup = "basics" | "recovery" | "teardown"');
    expect(contracts).toContain("export function registerUpstreamManagerContracts(");
    expect(contracts).toContain('if (group === "basics")');
    expect(contracts).toContain('if (group === "recovery")');
    expect(contracts).toContain('if (group === "teardown")');
    expect(contracts).toContain("does not idle-shutdown a profile while an upstream request is in flight");
    expect(contracts).toContain("forces a delayed shutdown to respect the configured timeout");
  });
});
