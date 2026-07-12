import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows secret command contract", () => {
  it("preserves C# escape sequences in the embedded helper", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).toContain("const windowsJobHelper = String.raw`");
  });

  it("runs the multiline helper through a fixed encoded bootstrap", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).toContain("const windowsJobBootstrap = String.raw`");
    expect(source).toContain(
      'const encodedWindowsJobBootstrap = Buffer.from(windowsJobBootstrap, "utf16le").toString("base64");'
    );
    expect(source).toContain('"-EncodedCommand", encodedWindowsJobBootstrap');
    expect(source).toContain("[ScriptBlock]::Create($source)");
  });
});
