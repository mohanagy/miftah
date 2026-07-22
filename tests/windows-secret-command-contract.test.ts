import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  encodedWindowsSecretJobAssembly,
  windowsSecretJobSourceSha256
} from "../src/secrets/windows-secret-job-assembly.js";

describe("Windows secret command contract", () => {
  it("verifies the trusted PowerShell launcher with asynchronous filesystem access", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).toContain('import { access, constants } from "node:fs/promises";');
    expect(source).toContain("const launcher = await trustedPowerShellExecutable();");
    expect(source).toContain("await access(executable, constants.X_OK);");
    expect(source).not.toContain("existsSync(");
  });

  it("keeps the Job Object helper source canonical and the generated assembly bounded", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-job.cs", import.meta.url), "utf8");
    const normalizedSource = source.replace(/\r\n?/g, "\n");
    const windowsCheckoutSource = normalizedSource.replace(/\n/g, "\r\n");
    const assembly = gunzipSync(Buffer.from(encodedWindowsSecretJobAssembly, "base64"));

    expect(source).toContain("public static class MiftahSecretJob");
    expect(source).toContain("JobObjectLimitKillOnJobClose");
    expect(source).toContain("AssignProcessToJobObject(createdJob, GetCurrentProcess())");
    expect(createHash("sha256").update(normalizedSource).digest("hex")).toBe(windowsSecretJobSourceSha256);
    expect(createHash("sha256").update(windowsCheckoutSource).digest("hex")).not.toBe(
      windowsSecretJobSourceSha256
    );
    expect(createHash("sha256").update(windowsCheckoutSource.replace(/\r\n?/g, "\n")).digest("hex")).toBe(
      windowsSecretJobSourceSha256
    );
    expect(encodedWindowsSecretJobAssembly.length).toBeLessThanOrEqual(8 * 1024);
    expect(assembly.byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(assembly.subarray(0, 2).toString("ascii")).toBe("MZ");
  });

  it("loads a precompiled Job Object helper without runtime C# compilation", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).not.toContain("Add-Type -TypeDefinition");
    expect(source).toContain("[Reflection.Assembly]::Load");
    expect(source).toContain("encodedWindowsSecretJobAssembly");
    expect(source).toContain("$assemblyOutput.Length + $assemblyCount");
    expect(source).toContain("SetEnvironmentVariable($assemblyName, $null");
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
