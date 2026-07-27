import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { resolveCheckedWindowsSecretJobExecutable } from "../secrets/windows-secret-command.js";

const requestEnvironmentName = "MIFTAH_CONFIG_ACL_REQUEST";
const privateConfigWriteRequestEnvironmentName = "MIFTAH_CONFIG_PRIVATE_FILE_WRITE_REQUEST";
const maximumRequestBytes = 12 * 1024;
const aclCommandTimeoutMs = 5_000;
const privateConfigWriteCommitGraceMs = 1_000;
// Node exposes no trusted Windows system-directory API. Use the protected default
// system root rather than a caller-controlled environment override; unsupported
// non-default layouts fail closed instead of launching an arbitrary executable.
const trustedWindowsRoot = "C:\\Windows";

interface CopyFileSecurityRequest {
  readonly operation: "copy-file-security";
  readonly source: string;
  readonly target: string;
}

interface CopyFileSecurityBatchRequest {
  readonly operation: "copy-file-security-batch";
  readonly source: string;
  readonly targets: readonly [string, string];
}

interface CreatePrivateDirectoryRequest {
  readonly operation: "create-private-directory";
  readonly directory: string;
}

interface CreatePrivateDirectoryInPrivateParentRequest {
  readonly operation: "create-private-directory-in-private-parent";
  readonly parent: string;
  readonly directory: string;
}

interface SecurePrivateFileRequest {
  readonly operation: "secure-private-file";
  readonly path: string;
}

interface PrivateConfigWriteRequest {
  readonly path: string;
  readonly byteLength: number;
  readonly commitDeadlineUtcMilliseconds: number;
}

interface VerifyPrivatePathRequest {
  readonly operation: "verify-private-path";
  readonly kind: "file" | "directory";
  readonly path: string;
}

export interface WindowsPrivatePath {
  readonly kind: "file" | "directory";
  readonly path: string;
}

interface VerifyPrivatePathsRequest {
  readonly operation: "verify-private-paths";
  readonly paths: readonly WindowsPrivatePath[];
}

type WindowsConfigAclRequest =
  | CopyFileSecurityRequest
  | CopyFileSecurityBatchRequest
  | CreatePrivateDirectoryRequest
  | CreatePrivateDirectoryInPrivateParentRequest
  | SecurePrivateFileRequest
  | VerifyPrivatePathRequest
  | VerifyPrivatePathsRequest;

export type WindowsPrivateConfigWriteResult = "written" | "exists" | "failed";

/**
 * Copies the source file's non-null owner, group, and DACL, then verifies its
 * persisted access rules after a selected-section reread. Audit/SACL data is not claimed.
 */
export async function copyWindowsConfigSecurityDescriptor(source: string, target: string): Promise<boolean> {
  return runWindowsAclRequest({ operation: "copy-file-security", source, target });
}

/**
 * Copies and verifies the source file's non-null owner, group, and DACL onto
 * a fixed pair of exclusively created migration files in one trusted helper.
 */
export async function copyWindowsConfigSecurityDescriptors(
  source: string,
  targets: readonly [string, string]
): Promise<boolean> {
  return runWindowsAclRequest({ operation: "copy-file-security-batch", source, targets });
}

/** Creates and verifies a current-user-only directory with its DACL applied at creation time. */
export async function createWindowsPrivateDirectory(directory: string): Promise<boolean> {
  return runWindowsAclRequest({ operation: "create-private-directory", directory });
}

/**
 * Verifies an immediate private parent and creates the child under its own
 * current-user-only descriptor in one trusted helper invocation. The helper
 * rejects a non-child path, reparse point, unsafe replaceable ancestor, or failed creation.
 */
export async function createWindowsPrivateDirectoryInPrivateParent(
  parent: string,
  directory: string
): Promise<boolean> {
  return runWindowsAclRequest({ operation: "create-private-directory-in-private-parent", parent, directory });
}

/** Applies and verifies a current-user-only DACL to an already exclusively created file. */
export async function secureWindowsConfigFile(path: string): Promise<boolean> {
  return runWindowsAclRequest({ operation: "secure-private-file", path });
}

/**
 * Creates one new private configuration file while holding every verified
 * Windows path component without delete sharing. The helper receives the
 * bytes on stdin; neither configuration content nor paths are emitted.
 */
export async function writeWindowsPrivateConfigFile(
  path: string,
  content: string | Uint8Array
): Promise<WindowsPrivateConfigWriteResult> {
  if (process.platform !== "win32") return "failed";
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  if (path.includes("\u0000") || !Number.isSafeInteger(bytes.byteLength)) {
    return "failed";
  }
  const launcher = await resolveCheckedWindowsSecretJobExecutable();
  if (launcher === undefined) return "failed";
  const request: PrivateConfigWriteRequest = {
    path,
    byteLength: bytes.byteLength,
    // A forced process termination bypasses native finally blocks. The helper
    // therefore refuses the irreversible move with one second left under the
    // unchanged parent bound, leaving time to clean its secured temporary file.
    commitDeadlineUtcMilliseconds: Date.now() + aclCommandTimeoutMs - privateConfigWriteCommitGraceMs
  };
  if (!Number.isSafeInteger(request.commitDeadlineUtcMilliseconds)) return "failed";
  const encodedRequest = encodePrivateFileWriteRequest(request);
  return encodedRequest === undefined ? "failed" : runWindowsPrivateFileWriteCommand(launcher, encodedRequest, bytes);
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

/**
 * Verifies a bounded stable private-directory boundary and its related paths
 * in one trusted helper. The first path must be the protected directory; its
 * full ancestor chain is checked before the helper accepts the boundary.
 */
export async function verifyWindowsConfigPathsSecurity(paths: readonly WindowsPrivatePath[]): Promise<boolean> {
  if (
    paths.length === 0 ||
    paths.length > 8 ||
    paths[0]?.kind !== "directory" ||
    paths.some((candidate) => (
      typeof candidate !== "object" ||
      candidate === null ||
      (candidate.kind !== "file" && candidate.kind !== "directory") ||
      typeof candidate.path !== "string"
    ))
  ) {
    return false;
  }
  return runWindowsAclRequest({ operation: "verify-private-paths", paths });
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
  if (request.operation === "copy-file-security-batch") {
    return request.source.includes("\u0000") || request.targets.some((target) => target.includes("\u0000"));
  }
  if (request.operation === "create-private-directory-in-private-parent") {
    return request.parent.includes("\u0000") || request.directory.includes("\u0000");
  }
  if (request.operation === "verify-private-paths") return request.paths.some((path) => path.path.includes("\u0000"));
  if (request.operation === "create-private-directory") return request.directory.includes("\u0000");
  return request.path.includes("\u0000");
}

function encodeRequest(request: WindowsConfigAclRequest): string | undefined {
  const fields = request.operation === "copy-file-security"
    ? [request.operation, request.source, request.target]
    : request.operation === "copy-file-security-batch"
      ? [request.operation, request.source, ...request.targets]
      : request.operation === "create-private-directory"
        ? [request.operation, request.directory]
        : request.operation === "create-private-directory-in-private-parent"
          ? [request.operation, request.parent, request.directory]
          : request.operation === "secure-private-file"
            ? [request.operation, request.path]
            : request.operation === "verify-private-paths"
              ? [request.operation, ...request.paths.flatMap((path) => [path.kind, path.path])]
              : [request.operation, request.kind, request.path];
  const payload = fields.join("\u0000");
  const bytes = Buffer.from(payload, "utf8");
  return bytes.byteLength <= maximumRequestBytes && bytes.toString("utf8") === payload
    ? bytes.toString("base64")
    : undefined;
}

function encodePrivateFileWriteRequest(request: PrivateConfigWriteRequest): string | undefined {
  const path = Buffer.from(request.path, "utf8");
  const requestLength = 1 + 4 + path.byteLength + 8 + 8;
  if (
    request.byteLength < 0 ||
    requestLength > maximumRequestBytes ||
    path.toString("utf8") !== request.path
  ) {
    return undefined;
  }

  const payload = Buffer.allocUnsafe(requestLength);
  let offset = 0;
  payload.writeUInt8(3, offset);
  offset += 1;
  payload.writeInt32LE(path.byteLength, offset);
  offset += 4;
  path.copy(payload, offset);
  offset += path.byteLength;
  payload.writeBigInt64LE(BigInt(request.byteLength), offset);
  offset += 8;
  payload.writeBigInt64LE(BigInt(request.commitDeadlineUtcMilliseconds), offset);
  return payload.toString("base64");
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

function privateConfigWriterEnvironment(request: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { SystemRoot: trustedWindowsRoot, windir: trustedWindowsRoot };
  for (const name of ["ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) {
    const value = environmentValue(process.env, name);
    if (value !== undefined) environment[name] = value;
  }
  environment[privateConfigWriteRequestEnvironmentName] = request;
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

function runWindowsPrivateFileWriteCommand(
  launcher: string,
  request: string,
  content: Uint8Array
): Promise<WindowsPrivateConfigWriteResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launcher, ["--write-private-config"], {
        env: privateConfigWriterEnvironment(request),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"]
      });
    } catch {
      resolve("failed");
      return;
    }

    let finished = false;
    const finish = (result: WindowsPrivateConfigWriteResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // A launcher that already exited has no verified result to trust.
      }
      finish("failed");
    }, aclCommandTimeoutMs);
    child.once("error", () => finish("failed"));
    child.once("close", (code) => finish(code === 0 ? "written" : code === 2 ? "exists" : "failed"));
    if (child.stdin === null) {
      try {
        child.kill();
      } catch {
        // The close handler will settle the unverified helper.
      }
      finish("failed");
      return;
    }
    child.stdin.once("error", () => {
      try {
        child.kill();
      } catch {
        // The close handler will settle the unverified helper.
      }
      finish("failed");
    });
    try {
      child.stdin.end(content);
    } catch {
      try {
        child.kill();
      } catch {
        // The close handler will settle the unverified helper.
      }
      finish("failed");
    }
  });
}

const aclCommand = String.raw`$ErrorActionPreference = 'Stop'
$requestName = '${requestEnvironmentName}'
$accessSections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
$dirSections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
$verifySections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
function Test-MiftahPrivatePath {
  param(
    [string]$path,
    [string]$kind,
    [string]$expectedSddl = $null,
    [bool]$requireProtected = $false,
    [bool]$requireOwner = $true
  )

  if ($kind -ne 'file' -and $kind -ne 'directory') { return $false }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $identity) { return $false }
  $reparse = [int][System.IO.FileAttributes]::ReparsePoint
  if ($kind -eq 'file') {
    $entry = [System.IO.FileInfo]::new($path)
    if (-not $entry.Exists) { return $false }
    if (([int]$entry.Attributes -band $reparse) -ne 0) { return $false }
    $acl = [System.IO.File]::GetAccessControl($path, $verifySections)
  } else {
    $entry = [System.IO.DirectoryInfo]::new($path)
    if (-not $entry.Exists) { return $false }
    if (([int]$entry.Attributes -band $reparse) -ne 0) { return $false }
    $acl = [System.IO.Directory]::GetAccessControl($path, $verifySections)
  }
  $entry.Refresh()
  $trusted = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($null -eq $owner -or -not ($trusted -ccontains $owner.Value) -or ($requireOwner -and $owner.Value -cne $identity.Value)) { return $false }
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $raw.DiscretionaryAcl -or -not $acl.AreAccessRulesCanonical) { return $false }
  if ($requireProtected -and -not $acl.AreAccessRulesProtected) { return $false }
  if ($expectedSddl.Length -gt 0 -and $acl.GetSecurityDescriptorSddlForm($dirSections) -ne $expectedSddl) { return $false }
  if (([int]$entry.Attributes -band $reparse) -ne 0) { return $false }
  $creatorOwner = 'S-1-3-0'
  $creatorGroup = 'S-1-3-1'
  $inheritOnly = [int][System.Security.AccessControl.PropagationFlags]::InheritOnly
  $restricted = if ($kind -eq 'file') {
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
    if ($trusted -ccontains $rule.IdentityReference.Value) { continue }
    if (
      ($rule.IdentityReference.Value -ceq $creatorOwner -or $rule.IdentityReference.Value -ceq $creatorGroup) -and
      (([int]$rule.PropagationFlags -band $inheritOnly) -ne 0)
    ) { continue }
    if (([int]$rule.FileSystemRights -band $restricted) -ne 0) { return $false }
  }
  return $true
}
function Test-MiftahAncestors {
  param($ancestor)
  while ($null -ne $ancestor) {
    $next = $ancestor.Parent
    if($null -eq $next -or $next.FullName -ceq $ancestor.FullName){break}
    if(-not(Test-MiftahPrivatePath $ancestor.FullName 'directory' $null $false $false)){return $false}
    $ancestor = $next
  }
  return $true
}
try {
  $encoded = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrEmpty($encoded) -or $encoded.Length -gt 16384) { exit 1 }
  $fields = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)).Split([char]0)
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)

  if (
    ($fields.Count -eq 3 -and $fields[0] -eq 'copy-file-security') -or
    ($fields.Count -eq 4 -and $fields[0] -eq 'copy-file-security-batch')
  ) {
    $sourceAcl = [System.IO.File]::GetAccessControl($fields[1], $accessSections)
    $sourceDescriptor = $sourceAcl.GetSecurityDescriptorBinaryForm()
    $sourceRaw = [System.Security.AccessControl.RawSecurityDescriptor]::new($sourceDescriptor, 0)
    if ($null -eq $sourceRaw.DiscretionaryAcl) { exit 1 }
    $sourceRules = @($sourceAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $targets = if ($fields[0] -eq 'copy-file-security') { @($fields[2]) } else { @($fields[2], $fields[3]) }
    foreach ($target in $targets) {
      $targetAcl = [System.IO.File]::GetAccessControl($target, $accessSections)
      $targetAcl.SetSecurityDescriptorBinaryForm($sourceDescriptor, $accessSections)
      [System.IO.File]::SetAccessControl($target, $targetAcl)
      $verifiedAcl = [System.IO.File]::GetAccessControl($target, $accessSections)
      if ($null -eq $verifiedAcl) { exit 1 }
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
    }
    exit 0
  }

  if ($fields.Count -eq 3 -and $fields[0] -eq 'verify-private-path') {
    $kind = $fields[1]
    $path = $fields[2]
    if (-not (Test-MiftahPrivatePath $path $kind)) { exit 1 }
    exit 0
  }

  if (
    $fields.Count -ge 3 -and
    $fields.Count -le 17 -and
    $fields[0] -eq 'verify-private-paths' -and
    (($fields.Count - 1) % 2 -eq 0)
  ) {
    for ($index = 1; $index -lt $fields.Count; $index += 2) {
      $kind = $fields[$index]
      $path = $fields[$index + 1]
      if (-not (Test-MiftahPrivatePath $path $kind)) { exit 1 }
    }
    if($fields[1] -ne 'directory' -or -not(Test-MiftahAncestors ([System.IO.DirectoryInfo]::new($fields[2]).Parent))){exit 1}
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
    if (-not (Test-MiftahPrivatePath $path 'file' $null $true)) { exit 1 }
    exit 0
  }

  if (
    ($fields.Count -eq 2 -and $fields[0] -eq 'create-private-directory') -or
    ($fields.Count -eq 3 -and $fields[0] -eq 'create-private-directory-in-private-parent')
  ) {
    $parentBound = $fields[0] -eq 'create-private-directory-in-private-parent'
    $directory = [System.IO.DirectoryInfo]::new($fields[($fields.Count - 1)])
    if ($parentBound) {
      $parent = [System.IO.DirectoryInfo]::new($fields[1])
      $trimCharacters = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
      $parentPath = [System.IO.Path]::GetFullPath($parent.FullName).TrimEnd($trimCharacters)
      $directoryParent = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($directory.FullName))
      if ([string]::IsNullOrEmpty($directoryParent)) { exit 1 }
      if (-not [string]::Equals($parentPath, $directoryParent.TrimEnd($trimCharacters), [System.StringComparison]::OrdinalIgnoreCase)) { exit 1 }
      if(-not(Test-MiftahPrivatePath $parent 'directory') -or -not(Test-MiftahAncestors $parent.Parent)){exit 1}
    }
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
    $expected = $security.GetSecurityDescriptorSddlForm($dirSections)
    $directory.Create($security)
    if (-not (Test-MiftahPrivatePath $directory 'directory' $expected $true)) { exit 1 }
    exit 0
  }

  exit 1
} catch {
  exit 1
}`;

const encodedAclCommand = Buffer.from(aclCommand, "utf16le").toString("base64");
