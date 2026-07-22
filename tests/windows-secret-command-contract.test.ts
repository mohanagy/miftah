import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows secret command contract", () => {
  it("verifies the trusted PowerShell launcher with asynchronous filesystem access", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).toContain('import { access, constants } from "node:fs/promises";');
    expect(source).toContain("const launcher = await trustedPowerShellExecutable();");
    expect(source).toContain("await access(executable, constants.X_OK);");
    expect(source).not.toContain("existsSync(");
  });

  it("preserves C# escape sequences in the embedded helper", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).toContain("const windowsJobHelper = String.raw`");
  });

  it("loads a precompiled Job Object helper without runtime C# compilation", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).not.toContain("Add-Type -TypeDefinition");
    expect(source).toContain("[Reflection.Assembly]::Load");
    expect(source).toContain("encodedWindowsSecretJobAssembly");
  });

  it("runs the multiline helper through a fixed encoded bootstrap", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).toContain("const windowsJobBootstrap = String.raw`");
    expect(source).toContain('import { gzipSync } from "node:zlib";');
    expect(source).toContain('const encodedWindowsJobHelper = gzipSync(windowsJobHelper).toString("base64");');
    expect(source).toContain("setEnvironmentValue(result, helperSourceEnvironmentName, encodedWindowsJobHelper);");
    expect(source).toContain(
      'const encodedWindowsJobBootstrap = Buffer.from(windowsJobBootstrap, "utf16le").toString("base64");'
    );
    expect(source).toContain('"-EncodedCommand", encodedWindowsJobBootstrap');
    expect(source).toContain("[ScriptBlock]::Create($source)");
  });
});
