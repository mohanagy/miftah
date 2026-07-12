import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows secret command contract", () => {
  it("preserves C# escape sequences in the embedded helper", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).toContain("const windowsJobHelper = String.raw`");
  });
});
