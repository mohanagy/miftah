import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrateConfigCommand } from "../src/cli/migrate-config.js";

const requestEnvironmentName = "MIFTAH_TEST_CONFIG_ACL_REQUEST";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLocaleLowerCase("en-US");
  for (const [candidateName, value] of Object.entries(environment)) {
    if (candidateName.toLocaleLowerCase("en-US") === normalizedName && value !== undefined) return value;
  }
  return undefined;
}

function trustedPowerShellExecutable(): string {
  const systemRoot = environmentValue(process.env, "SystemRoot") ?? environmentValue(process.env, "windir") ?? "C:\\Windows";
  const executable = win32.join(win32.resolve(systemRoot), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(executable)) throw new Error("Windows PowerShell was unavailable for the ACL integration contract");
  return executable;
}

function aclEnvironment(request: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "windir", "ComSpec", "TEMP", "TMP", "PSModulePath", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) {
    const value = environmentValue(process.env, name);
    if (value !== undefined) environment[name] = value;
  }
  environment[requestEnvironmentName] = request;
  return environment;
}

const aclProbe = String.raw`$ErrorActionPreference = 'Stop'
$requestName = '${requestEnvironmentName}'
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
try {
  $encoded = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)
  if ($null -eq $request -or $request.path -isnot [string] -or $request.operation -isnot [string]) { exit 1 }
  if ($request.operation -eq 'restrict') {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = New-Object System.Security.AccessControl.FileSecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.SetAccessRule($rule)
    Set-Acl -LiteralPath $request.path -AclObject $security
  } elseif ($request.operation -ne 'read') {
    exit 1
  }
  $acl = Get-Acl -LiteralPath $request.path
  $sddl = $acl.GetSecurityDescriptorSddlForm($sections)
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sddl)))
  exit 0
} catch {
  [Console]::Error.Write("MIFTAH_ACL_PROBE_EXCEPTION:" + $_.Exception.GetType().FullName)
  exit 1
}`;

const encodedAclProbe = Buffer.from(aclProbe, "utf16le").toString("base64");

async function windowsAclSddl(path: string, operation: "read" | "restrict"): Promise<string> {
  const request = Buffer.from(JSON.stringify({ path, operation }), "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      trustedPowerShellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedAclProbe],
      { env: aclEnvironment(request), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    const output: Buffer[] = [];
    const errorOutput: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errorOutput.push(chunk));
    child.once("error", () => reject(new Error("Windows ACL probe could not start")));
    child.once("close", (code) => {
      if (code !== 0) {
        const diagnostic = Buffer.concat(errorOutput).toString("utf8").trim();
        const safeDiagnostic = /^MIFTAH_ACL_PROBE_EXCEPTION:[A-Za-z0-9_.]+$/.test(diagnostic)
          ? diagnostic
          : "MIFTAH_ACL_PROBE_EXCEPTION:unavailable";
        reject(new Error(`Windows ACL probe failed: ${safeDiagnostic}`));
        return;
      }
      try {
        resolve(Buffer.from(Buffer.concat(output).toString("utf8"), "base64").toString("utf8"));
      } catch {
        reject(new Error("Windows ACL probe returned an invalid descriptor"));
      }
    });
  });
}

describe("Windows migration ACL contract", () => {
  it.runIf(process.platform === "win32")(
    "preserves a restrictive source owner/group/DACL on the migrated config and exact backup",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "miftah-windows-config-acl-"));
      temporaryDirectories.push(directory);
      const configPath = join(directory, "miftah.json");
      const source = `${JSON.stringify(
        {
          version: "1",
          name: "windows-acl-contract",
          defaultProfile: "default",
          upstream: { transport: "http", url: "https://mcp.example.test" },
          profiles: { default: {} }
        },
        null,
        2
      )}\n`;
      await writeFile(configPath, source, "utf8");
      const expectedSddl = await windowsAclSddl(configPath, "restrict");

      await runMigrateConfigCommand({ configPath, write: true });

      expect(await windowsAclSddl(configPath, "read")).toBe(expectedSddl);
      expect(await windowsAclSddl(`${configPath}.bak`, "read")).toBe(expectedSddl);
      expect(await readFile(`${configPath}.bak`, "utf8")).toBe(source);
    },
    20_000
  );
});
