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

interface SecurePrivateFileRequest {
  readonly operation: "secure-private-file";
  readonly path: string;
}

interface VerifyPrivatePathRequest {
  readonly operation: "verify-private-path";
  readonly kind: "file" | "directory";
  readonly path: string;
}

type WindowsConfigAclRequest =
  | CopyFileSecurityRequest
  | CreatePrivateDirectoryRequest
  | SecurePrivateFileRequest
  | VerifyPrivatePathRequest;

/**
 * Copies the source file's non-null owner, group, and DACL, then verifies its
 * persisted access rules after a selected-section reread. Audit/SACL data is not claimed.
 */
export async function copyWindowsConfigSecurityDescriptor(source: string, target: string): Promise<boolean> {
  return runWindowsAclRequest({ operation: "copy-file-security", source, target });
}

/** Creates a current-user-only directory with its DACL applied at creation time. */
export async function createWindowsPrivateDirectory(directory: string): Promise<boolean> {
  return runWindowsAclRequest({ operation: "create-private-directory", directory });
}

/** Applies and verifies a current-user-only DACL to an already exclusively created file. */
export async function secureWindowsConfigFile(path: string): Promise<boolean> {
  return runWindowsAclRequest({ operation: "secure-private-file", path });
}

/** Backwards-compatible name for migration transaction directories. */
export async function createWindowsPrivateMigrationDirectory(directory: string): Promise<boolean> {
  return createWindowsPrivateDirectory(directory);
}

/**
 * Verifies that a current-user-owned configuration path is not a reparse point
 * and grants no untrusted principal content access (files) or mutation access
 * (directories). It returns false rather than exposing ACL diagnostics.
 */
export async function verifyWindowsConfigPathSecurity(
  path: string,
  kind: "file" | "directory"
): Promise<boolean> {
  return runWindowsAclRequest({ operation: "verify-private-path", path, kind });
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
  if (request.operation === "copy-file-security") {
    return request.source.includes("\u0000") || request.target.includes("\u0000");
  }
  if (request.operation === "create-private-directory") return request.directory.includes("\u0000");
  return request.path.includes("\u0000");
}

function encodeRequest(request: WindowsConfigAclRequest): string | undefined {
  const fields = request.operation === "copy-file-security"
    ? [request.operation, request.source, request.target]
    : request.operation === "create-private-directory"
      ? [request.operation, request.directory]
      : request.operation === "secure-private-file"
        ? [request.operation, request.path]
        : [request.operation, request.kind, request.path];
  const payload = fields.join("\u0000");
  const bytes = Buffer.from(payload, "utf8");
  return bytes.byteLength <= maximumRequestBytes && bytes.toString("utf8") === payload
    ? bytes.toString("base64")
    : undefined;
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
  for (const name of ["ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) {
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
$verifySections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
function Test-MiftahPrivatePath {
  param(
    [string]$path,
    [string]$kind
  )

  if ($kind -ne 'file' -and $kind -ne 'directory') { return $false }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $identity) { return $false }
  $reparsePoint = [int][System.IO.FileAttributes]::ReparsePoint
  if ($kind -eq 'file') {
    $entry = [System.IO.FileInfo]::new($path)
    if (-not $entry.Exists) { return $false }
    if (([int]$entry.Attributes -band $reparsePoint) -ne 0) { return $false }
    $acl = [System.IO.File]::GetAccessControl($path, $verifySections)
  } else {
    $entry = [System.IO.DirectoryInfo]::new($path)
    if (-not $entry.Exists) { return $false }
    if (([int]$entry.Attributes -band $reparsePoint) -ne 0) { return $false }
    $acl = [System.IO.Directory]::GetAccessControl($path, $verifySections)
  }
  $entry.Refresh()
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($null -eq $owner -or $owner.Value -cne $identity.Value) { return $false }
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $raw.DiscretionaryAcl -or -not $acl.AreAccessRulesCanonical) { return $false }
  if (([int]$entry.Attributes -band $reparsePoint) -ne 0) { return $false }
  # OWNER RIGHTS applies only to the owner. CREATOR OWNER/GROUP are safe only
  # on inherit-only ACEs, where they have no access to this entry itself.
  $trustedSids = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4')
  $creatorOwnerSid = 'S-1-3-0'
  $creatorGroupSid = 'S-1-3-1'
  $inheritOnly = [int][System.Security.AccessControl.PropagationFlags]::InheritOnly
  $restrictedRights = if ($kind -eq 'file') {
    [int](
      [System.Security.AccessControl.FileSystemRights]::ReadData -bor
      [System.Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor
      [System.Security.AccessControl.FileSystemRights]::ReadAttributes -bor
      [System.Security.AccessControl.FileSystemRights]::WriteData -bor
      [System.Security.AccessControl.FileSystemRights]::AppendData -bor
      [System.Security.AccessControl.FileSystemRights]::Delete -bor
      [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
      [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
      [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
      [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    )
  } else {
    [int](
      [System.Security.AccessControl.FileSystemRights]::WriteData -bor
      [System.Security.AccessControl.FileSystemRights]::AppendData -bor
      [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
      [System.Security.AccessControl.FileSystemRights]::Delete -bor
      [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
      [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
      [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
      [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    )
  }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { return $false }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if ($trustedSids -ccontains $rule.IdentityReference.Value) { continue }
    if (
      ($rule.IdentityReference.Value -ceq $creatorOwnerSid -or $rule.IdentityReference.Value -ceq $creatorGroupSid) -and
      (([int]$rule.PropagationFlags -band $inheritOnly) -ne 0)
    ) { continue }
    if (([int]$rule.FileSystemRights -band $restrictedRights) -ne 0) { return $false }
  }
  return $true
}
try {
  $encoded = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrEmpty($encoded) -or $encoded.Length -gt 16384) { exit 1 }
  $fields = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)).Split([char]0)
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)

  if ($fields.Count -eq 3 -and $fields[0] -eq 'copy-file-security') {
    $sourceAcl = [System.IO.File]::GetAccessControl($fields[1], $accessSections)
    $sourceDescriptor = $sourceAcl.GetSecurityDescriptorBinaryForm()
    $sourceRaw = [System.Security.AccessControl.RawSecurityDescriptor]::new($sourceDescriptor, 0)
    if ($null -eq $sourceRaw.DiscretionaryAcl) { exit 1 }
    $targetAcl = [System.IO.File]::GetAccessControl($fields[2], $accessSections)
    $targetAcl.SetSecurityDescriptorBinaryForm($sourceDescriptor, $accessSections)
    [System.IO.File]::SetAccessControl($fields[2], $targetAcl)
    $verifiedAcl = [System.IO.File]::GetAccessControl($fields[2], $accessSections)
    if ($null -eq $verifiedAcl) { exit 1 }
    $sourceRules = @($sourceAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $verifiedRules = @($verifiedAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($sourceRules.Count -ne $verifiedRules.Count) { exit 1 }
    for ($index = 0; $index -lt $sourceRules.Count; $index++) {
      $sourceRule = $sourceRules[$index]
      $verifiedRule = $verifiedRules[$index]
      if (
        $sourceRule.IdentityReference.Value -cne $verifiedRule.IdentityReference.Value -or
        ([int]$sourceRule.FileSystemRights) -ne ([int]$verifiedRule.FileSystemRights) -or
        ([int]$sourceRule.AccessControlType) -ne ([int]$verifiedRule.AccessControlType) -or
        $sourceRule.IsInherited -ne $verifiedRule.IsInherited -or
        ([int]$sourceRule.InheritanceFlags) -ne ([int]$verifiedRule.InheritanceFlags) -or
        ([int]$sourceRule.PropagationFlags) -ne ([int]$verifiedRule.PropagationFlags)
      ) { exit 1 }
    }
    exit 0
  }

  if ($fields.Count -eq 3 -and $fields[0] -eq 'verify-private-path') {
    $kind = $fields[1]
    $path = $fields[2]
    if (-not (Test-MiftahPrivatePath $path $kind)) { exit 1 }
    exit 0
  }

  if ($fields.Count -eq 2 -and $fields[0] -eq 'secure-private-file') {
    $path = $fields[1]
    $entry = [System.IO.FileInfo]::new($path)
    if (-not $entry.Exists) { exit 1 }
    $reparsePoint = [int][System.IO.FileAttributes]::ReparsePoint
    if (([int]$entry.Attributes -band $reparsePoint) -ne 0) { exit 1 }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $identity) { exit 1 }
    $security = [System.Security.AccessControl.FileSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.SetAccessRule($rule)
    [System.IO.File]::SetAccessControl($path, $security)
    $entry.Refresh()
    if (([int]$entry.Attributes -band $reparsePoint) -ne 0) { exit 1 }
    $actual = [System.IO.File]::GetAccessControl($path, $verifySections)
    if (-not $actual.AreAccessRulesProtected) { exit 1 }
    if (-not (Test-MiftahPrivatePath $path 'file')) { exit 1 }
    exit 0
  }

  if ($fields.Count -eq 2 -and $fields[0] -eq 'create-private-directory') {
    $directory = [System.IO.DirectoryInfo]::new($fields[1])
    if ($directory.Exists) { exit 1 }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $identity) { exit 1 }
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
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
