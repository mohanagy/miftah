import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  windowsSecretJobExecutableSha256,
  windowsSecretJobSourceSha256
} from "../src/secrets/windows-secret-job-artifact.js";

describe("Windows secret command contract", () => {
  it("enters the precompiled Job Object helper without a PowerShell cold-start boundary", () => {
    const commandSource = readFileSync(
      new URL("../src/secrets/windows-secret-command.ts", import.meta.url),
      "utf8"
    );
    const helperSource = readFileSync(
      new URL("../src/secrets/windows-secret-job.cs", import.meta.url),
      "utf8"
    );

    expect(helperSource).toContain("public static int Main(string[] arguments)");
    expect(commandSource).toContain('new URL("../../assets/windows-secret-job.exe", import.meta.url)');
    expect(commandSource).toContain("return spawn(command.launcher, [], {");
    expect(commandSource).not.toContain("-EncodedCommand");
    expect(commandSource).not.toContain("[Reflection.Assembly]::Load");
    expect(commandSource).not.toContain("[ScriptBlock]::Create");
  });

  it("verifies the checked helper before resolving it as the launcher", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).toContain('import { access, constants, readFile } from "node:fs/promises";');
    expect(source).toContain('createHash("sha256").update(contents).digest("hex")');
    expect(source).toContain("fingerprint !== windowsSecretJobExecutableSha256");
    expect(source).not.toContain("existsSync(");
  });

  it("resolves trusted System32 PowerShell only when it is the requested provider", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).toContain('executable.toLocaleLowerCase("en-US") === "powershell.exe"');
    expect(source).toContain("return trustedPowerShellExecutable();");
    expect(source).not.toContain("const launcher = await trustedPowerShellExecutable();");
    expect(source).toContain("await access(executable, constants.X_OK);");
  });

  it("keeps the Job Object helper source and checked executable canonical and bounded", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-job.cs", import.meta.url), "utf8");
    const executable = readFileSync(new URL("../assets/windows-secret-job.exe", import.meta.url));
    const normalizedSource = source.replace(/\r\n?/g, "\n");
    const windowsCheckoutSource = normalizedSource.replace(/\n/g, "\r\n");

    expect(source).toContain("public static class MiftahSecretJob");
    expect(source).toContain("JobObjectLimitKillOnJobClose");
    expect(source).toContain("AssignProcessToJobObject(createdJob, GetCurrentProcess())");
    expect(source).toContain("if (ownsProviderInput && providerInput != IntPtr.Zero) CloseHandle(providerInput);");
    expect(createHash("sha256").update(normalizedSource).digest("hex")).toBe(windowsSecretJobSourceSha256);
    expect(createHash("sha256").update(windowsCheckoutSource).digest("hex")).not.toBe(
      windowsSecretJobSourceSha256
    );
    expect(createHash("sha256").update(windowsCheckoutSource.replace(/\r\n?/g, "\n")).digest("hex")).toBe(
      windowsSecretJobSourceSha256
    );
    expect(createHash("sha256").update(executable).digest("hex")).toBe(windowsSecretJobExecutableSha256);
    expect(executable.byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(executable.subarray(0, 2).toString("ascii")).toBe("MZ");
  });

  it("uses one bounded binary request envelope and clears it before provider launch", () => {
    const commandSource = readFileSync(
      new URL("../src/secrets/windows-secret-command.ts", import.meta.url),
      "utf8"
    );
    const helperSource = readFileSync(
      new URL("../src/secrets/windows-secret-job.cs", import.meta.url),
      "utf8"
    );

    expect(commandSource).toContain("request.writeUInt8(1, offset);");
    expect(commandSource).toContain("request.writeInt32LE(arguments_.length, offset);");
    expect(commandSource).toContain("if (requestLength > maximumRequestBytes) return undefined;");
    expect(helperSource).toContain("if (reader.ReadByte() != 1) return null;");
    expect(helperSource).toContain(
      "Environment.SetEnvironmentVariable(RequestEnvironmentName, null, EnvironmentVariableTarget.Process);"
    );
    expect(helperSource).toContain(
      "Environment.SetEnvironmentVariable(StandardInputEnvironmentName, null, EnvironmentVariableTarget.Process);"
    );
  });

  it("contains no runtime C# compilation, compressed helper, or reflection loader", () => {
    const source = readFileSync(new URL("../src/secrets/windows-secret-command.ts", import.meta.url), "utf8");

    expect(source).not.toContain("Add-Type -TypeDefinition");
    expect(source).not.toContain("encodedWindowsSecretJobAssembly");
    expect(source).not.toContain("gzipSync");
    expect(source).not.toContain("MIFTAH_SECRET_RUNNER_HELPER:");
    expect(source).not.toContain("MIFTAH_SECRET_RUNNER_ASSEMBLY:");
  });
});
