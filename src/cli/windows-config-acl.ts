import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

const requestEnvironmentName = "MIFTAH_CONFIG_ACL_REQUEST";
const maximumRequestBytes = 12 * 1024;
const aclCommandTimeoutMs = 5_000;
// Node exposes no trusted Windows system-directory API. Use the protected default
// system root rather than a caller-controlled environment override; unsupported
// non-default layouts fail closed instead of launching an arbitrary executable.
const trustedWindowsRoot = "C:\\Windows";

interface CopyFileSecurityRequest {
  readonly operation: "copy-file-security";
  readonly source: string;
  readonly target: string;
}

interface CreatePrivateDirectoryRequest {
  readonly operation: "create-private-directory";
  readonly directory: string;
}

type WindowsConfigAclRequest = CopyFileSecurityRequest | CreatePrivateDirectoryRequest;

/**
 * Copies and verifies the source file's owner, group, and DACL before writing
 * source-derived bytes. Audit/SACL data is intentionally not claimed here.
 */
export async function copyWindowsConfigSecurityDescriptor(source: string, target: string): Promise<boolean> {
  return runWindowsAclRequest({ operation: "copy-file-security", source, target });
}

/** Creates a current-user-only transaction directory with its DACL applied at creation time. */
export async function createWindowsPrivateMigrationDirectory(directory: string): Promise<boolean> {
  return runWindowsAclRequest({ operation: "create-private-directory", directory });
}

async function runWindowsAclRequest(request: WindowsConfigAclRequest): Promise<boolean> {
  if (process.platform !== "win32") return true;
  const launcher = trustedPowerShellExecutable();
  if (launcher === undefined || requestHasNul(request)) return false;
  const encodedRequest = encodeRequest(request);
  if (encodedRequest === undefined) return false;
  return runWindowsAclCommand(launcher, encodedRequest);
}

function requestHasNul(request: WindowsConfigAclRequest): boolean {
  return request.operation === "copy-file-security"
    ? request.source.includes("\u0000") || request.target.includes("\u0000")
    : request.directory.includes("\u0000");
}

function encodeRequest(request: WindowsConfigAclRequest): string | undefined {
  const bytes = Buffer.from(JSON.stringify(request), "utf8");
  return bytes.byteLength <= maximumRequestBytes ? bytes.toString("base64") : undefined;
}

function trustedPowerShellExecutable(): string | undefined {
  const executable = win32.join(
    trustedWindowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return existsSync(executable) ? executable : undefined;
}

function aclEnvironment(request: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { SystemRoot: trustedWindowsRoot, windir: trustedWindowsRoot };
  for (const name of ["ComSpec", "TEMP", "TMP", "PSModulePath", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) {
    const value = environmentValue(process.env, name);
    if (value !== undefined) environment[name] = value;
  }
  environment[requestEnvironmentName] = request;
  return environment;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLocaleLowerCase("en-US");
  for (const [candidateName, value] of Object.entries(environment)) {
    if (candidateName.toLocaleLowerCase("en-US") === normalizedName && value !== undefined) return value;
  }
  return undefined;
}

function runWindowsAclCommand(launcher: string, request: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launcher, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedAclCommand], {
        env: aclEnvironment(request),
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
    } catch {
      resolve(false);
      return;
    }

    let finished = false;
    const finish = (success: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(success);
    };
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // A launcher that already exited has no verified result to trust.
      }
      finish(false);
    }, aclCommandTimeoutMs);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

const aclCommand = String.raw`$ErrorActionPreference = 'Stop'
$requestName = '${requestEnvironmentName}'
$accessSections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
$directorySections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
try {
  $encoded = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrEmpty($encoded) -or $encoded.Length -gt 16384) { exit 1 }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)
  $request = $json | ConvertFrom-Json
  if ($null -eq $request -or $request.operation -isnot [string]) { exit 1 }

  if ($request.operation -eq 'copy-file-security') {
    if ($request.source -isnot [string] -or $request.target -isnot [string]) { exit 1 }
    $sourceAcl = Get-Acl -LiteralPath $request.source
    Set-Acl -LiteralPath $request.target -AclObject $sourceAcl
    $targetAcl = Get-Acl -LiteralPath $request.target
    if ($sourceAcl.GetSecurityDescriptorSddlForm($accessSections) -ne $targetAcl.GetSecurityDescriptorSddlForm($accessSections)) { exit 1 }
    exit 0
  }

  if ($request.operation -eq 'create-private-directory') {
    if ($request.directory -isnot [string]) { exit 1 }
    $directory = New-Object System.IO.DirectoryInfo($request.directory)
    if ($directory.Exists) { exit 1 }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $identity) { exit 1 }
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]$inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.SetAccessRule($rule)
    $expected = $security.GetSecurityDescriptorSddlForm($directorySections)
    $directory.Create($security)
    $directory.Refresh()
    $actual = $directory.GetAccessControl()
    if (-not $actual.AreAccessRulesProtected) { exit 1 }
    if ($actual.GetSecurityDescriptorSddlForm($directorySections) -ne $expected) { exit 1 }
    exit 0
  }

  exit 1
} catch {
  exit 1
}`;

const encodedAclCommand = Buffer.from(aclCommand, "utf16le").toString("base64");
