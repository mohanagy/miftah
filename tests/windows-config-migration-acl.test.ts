import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrateConfigCommand } from "../src/cli/migrate-config.js";
import {
  createWindowsPrivateDirectoryInPrivateParent,
  verifyWindowsConfigPathSecurity
} from "../src/cli/windows-config-acl.js";
import { createPrivateConsoleTestRoot } from "./helpers/private-console-directory.js";

const requestEnvironmentName = "MIFTAH_TEST_CONFIG_ACL_REQUEST";
const privateDirectoryRequestEnvironmentName = "MIFTAH_TEST_PRIVATE_DIRECTORY_ACL_REQUEST";
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

function restrictedAclEnvironment(request: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows", windir: "C:\\Windows" };
  for (const name of ["ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) {
    const value = environmentValue(process.env, name);
    if (value !== undefined) environment[name] = value;
  }
  environment[privateDirectoryRequestEnvironmentName] = request;
  return environment;
}

const aclProbe = String.raw`$ErrorActionPreference = 'Stop'
$requestName = '${requestEnvironmentName}'
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
$stage = 'bootstrap'
try {
  $stage = 'request'
  $encoded = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)
  if ($null -eq $request -or $request.path -isnot [string] -or $request.operation -isnot [string]) { exit 1 }
  if ($request.operation -eq 'restrict') {
    $stage = 'identity'
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $stage = 'descriptor'
    $security = New-Object System.Security.AccessControl.FileSecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.SetAccessRule($rule)
    $stage = 'apply'
    [System.IO.File]::SetAccessControl($request.path, $security)
  } elseif ($request.operation -ne 'read') {
    exit 1
  }
  $stage = 'verify'
  $acl = [System.IO.File]::GetAccessControl($request.path, $sections)
  $sddl = $acl.GetSecurityDescriptorSddlForm($sections)
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sddl)))
  exit 0
} catch {
  $suffix = ''
  if ($stage -eq 'apply') {
    $suffix = switch ($_.CategoryInfo.Category.ToString()) {
      'PermissionDenied' { ':permission' }
      'ObjectNotFound' { ':missing' }
      'InvalidOperation' { ':invalid' }
      default { ':other' }
    }
  }
  [Console]::Out.Write("MIFTAH_ACL_PROBE_STAGE:" + $stage + $suffix)
  exit 1
}`;

const encodedAclProbe = Buffer.from(aclProbe, "utf16le").toString("base64");
const encodedHangingAclProbe = Buffer.from("Start-Sleep -Seconds 10", "utf16le").toString("base64");

const unsafeAncestorProbe = String.raw`$ErrorActionPreference = 'Stop'
$requestName = '${privateDirectoryRequestEnvironmentName}'
try {
  $encoded = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrEmpty($path)) { exit 1 }
  $security = [System.IO.Directory]::GetAccessControl($path)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
    [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $security.AddAccessRule($rule)
  [System.IO.Directory]::SetAccessControl($path, $security)
  exit 0
} catch {
  exit 1
}`;
const encodedUnsafeAncestorProbe = Buffer.from(unsafeAncestorProbe, "utf16le").toString("base64");

const ancestorDiagnosticProbe = String.raw`$ErrorActionPreference = 'Stop'
$requestName = '${privateDirectoryRequestEnvironmentName}'
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
function Write-Result {
  param([string]$value)
  [Console]::Out.Write($value)
  exit 0
}
try {
  $encoded = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrEmpty($path)) { Write-Result 'probe' }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $identity) { Write-Result 'probe' }
  $trusted = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $creatorOwner = 'S-1-3-0'
  $creatorGroup = 'S-1-3-1'
  $inheritOnly = [int][System.Security.AccessControl.PropagationFlags]::InheritOnly
  $entry = [System.IO.DirectoryInfo]::new($path)
  $index = 0
  while ($null -ne $entry) {
    if (-not $entry.Exists) { Write-Result "missing:$index" }
    $reparse = [int][System.IO.FileAttributes]::ReparsePoint
    if (([int]$entry.Attributes -band $reparse) -ne 0) { Write-Result "reparse:$index" }
    try {
      $acl = [System.IO.Directory]::GetAccessControl($entry.FullName, $sections)
      $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
      if ($null -eq $owner -or -not ($trusted -ccontains $owner.Value)) { Write-Result "owner:$index" }
      $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
      if ($null -eq $raw.DiscretionaryAcl -or -not $acl.AreAccessRulesCanonical) { Write-Result "acl:$index" }
      $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
      if ($rules.Count -eq 0) { Write-Result "rules:$index" }
      foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        if ($trusted -ccontains $rule.IdentityReference.Value) { continue }
        if (
          ($rule.IdentityReference.Value -ceq $creatorOwner -or $rule.IdentityReference.Value -ceq $creatorGroup) -and
          (([int]$rule.PropagationFlags -band $inheritOnly) -ne 0)
        ) { continue }
        $rights = [int]$rule.FileSystemRights
        if (($rights -band [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -ne 0) { Write-Result "delete-child:$index" }
        if (($rights -band [int][System.Security.AccessControl.FileSystemRights]::Delete) -ne 0) { Write-Result "delete:$index" }
        if (($rights -band [int]([System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership)) -ne 0) { Write-Result "ownership:$index" }
        if (($rights -band [int]([System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes)) -ne 0) { Write-Result "attributes:$index" }
        if (($rights -band [int][System.Security.AccessControl.FileSystemRights]::AppendData) -ne 0) { Write-Result "create-child:$index" }
        if (($rights -band [int][System.Security.AccessControl.FileSystemRights]::WriteData) -ne 0) { Write-Result "create-file:$index" }
      }
    } catch {
      Write-Result "read:$index"
    }
    $next = $entry.Parent
    if ($null -eq $next -or $next.FullName -ceq $entry.FullName) { break }
    $entry = $next
    $index++
  }
  Write-Result 'ok'
} catch {
  Write-Result 'probe'
}`;
const encodedAncestorDiagnosticProbe = Buffer.from(ancestorDiagnosticProbe, "utf16le").toString("base64");

const privateDirectoryProbe = String.raw`[Console]::Out.Write('MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_BOOTSTRAP')
$ErrorActionPreference = 'Stop'
$requestName = '${privateDirectoryRequestEnvironmentName}'
$directorySections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
[Console]::Out.Write('MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_SECTIONS')
$stage = 'bootstrap'
try {
  $stage = 'request'
  $encoded = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrEmpty($encoded) -or $encoded.Length -gt 16384) { exit 1 }
  $fields = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)).Split([char]0)
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)
  [Console]::Out.Write('MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_REQUEST')
  if ($fields.Count -ne 2 -or $fields[0] -ne 'create-private-directory') { exit 1 }
  $stage = 'directory'
  $directory = [System.IO.DirectoryInfo]::new($fields[1])
  if ($directory.Exists) { exit 1 }
  $stage = 'identity'
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $identity) { exit 1 }
  $stage = 'descriptor'
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($identity)
  $stage = 'rule'
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
  $stage = 'create'
  $directory.Create($security)
  $stage = 'verify'
  $directory.Refresh()
  $actual = $directory.GetAccessControl()
  if (-not $actual.AreAccessRulesProtected) { exit 1 }
  if ($actual.GetSecurityDescriptorSddlForm($directorySections) -ne $expected) { exit 1 }
  exit 0
} catch {
  $suffix = switch ($_.CategoryInfo.Category.ToString()) {
    'PermissionDenied' { ':permission' }
    'ObjectNotFound' { ':missing' }
    'InvalidOperation' { ':invalid' }
    default { ':other' }
  }
  [Console]::Out.Write("MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_STAGE:" + $stage + $suffix)
  exit 1
}`;

const encodedPrivateDirectoryProbe = Buffer.from(privateDirectoryProbe, "utf16le").toString("base64");

const copyFileSecurityProbe = String.raw`[Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_BOOTSTRAP')
$ErrorActionPreference = 'Stop'
$requestName = '${privateDirectoryRequestEnvironmentName}'
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
[Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_SECTIONS')
$stage = 'bootstrap'
try {
  $stage = 'request'
  $encoded = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  if ($null -eq $encoded) {
    [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_REQUEST:missing')
    exit 1
  }
  if ($encoded.Length -eq 0) {
    [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_REQUEST:empty')
    exit 1
  }
  if ($encoded.Length -gt 16384) {
    [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_REQUEST:oversize')
    exit 1
  }
  $fields = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)).Split([char]0)
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)
  [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_REQUEST')
  if ($fields.Count -ne 3) {
    [Console]::Out.Write("MIFTAH_ACL_COPY_FILE_PROBE_REQUEST:field-count-" + $fields.Count)
    exit 1
  }
  if (
    $fields[0] -ne 'copy-file-security' -and
    $fields[0] -ne 'copy-file-security-fresh' -and
    $fields[0] -ne 'copy-file-security-verify-rules'
  ) {
    [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_REQUEST:operation')
    exit 1
  }
  $stage = 'source'
  [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_BOUNDARY:source-get')
  $sourceAcl = [System.IO.File]::GetAccessControl($fields[1], $sections)
  [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_BOUNDARY:source-binary')
  $sourceDescriptor = $sourceAcl.GetSecurityDescriptorBinaryForm()
  [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_BOUNDARY:source-raw')
  $sourceRaw = [System.Security.AccessControl.RawSecurityDescriptor]::new($sourceDescriptor, 0)
  if ($null -eq $sourceRaw.DiscretionaryAcl) { exit 1 }
  $stage = 'target'
  if ($fields[0] -eq 'copy-file-security-fresh') {
    [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_BOUNDARY:target-fresh')
    $targetAcl = [System.Security.AccessControl.FileSecurity]::new()
  } else {
    [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_BOUNDARY:target-get')
    $targetAcl = [System.IO.File]::GetAccessControl($fields[2], $sections)
  }
  $stage = 'apply'
  [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_BOUNDARY:target-set-binary')
  $targetAcl.SetSecurityDescriptorBinaryForm($sourceDescriptor, $sections)
  [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_BOUNDARY:target-apply')
  [System.IO.File]::SetAccessControl($fields[2], $targetAcl)
  $stage = 'verify'
  [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_BOUNDARY:verify-get')
  $verifiedAcl = [System.IO.File]::GetAccessControl($fields[2], $sections)
  if ($null -eq $verifiedAcl) { exit 1 }
  if ($fields[0] -eq 'copy-file-security-verify-rules') {
    [Console]::Out.Write('MIFTAH_ACL_COPY_FILE_PROBE_BOUNDARY:verify-rules')
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
  }
  exit 0
} catch {
  $suffix = switch ($_.CategoryInfo.Category.ToString()) {
    'PermissionDenied' { ':permission' }
    'ObjectNotFound' { ':missing' }
    'InvalidOperation' { ':invalid' }
    default { ':other' }
  }
  [Console]::Out.Write("MIFTAH_ACL_COPY_FILE_PROBE_STAGE:" + $stage + $suffix)
  exit 1
}`;

const encodedCopyFileSecurityProbe = Buffer.from(copyFileSecurityProbe, "utf16le").toString("base64");

function safeAclProbeStage(output: readonly Buffer[]): string {
  const bytes = Buffer.concat(output);
  for (const encoding of ["utf8", "utf16le"] as const) {
    const diagnostic = bytes.toString(encoding).trim().replace(/^\uFEFF/, "");
    const stage = diagnostic.match(
      /MIFTAH_ACL_PROBE_STAGE:(bootstrap|request|identity|descriptor|apply|verify)(?::(permission|missing|invalid|other))?/
    )?.[0];
    if (stage !== undefined) return stage;
  }
  return "MIFTAH_ACL_PROBE_STAGE:unavailable";
}

function safePrivateDirectoryProbeStage(output: readonly Buffer[]): string {
  const bytes = Buffer.concat(output);
  for (const encoding of ["utf8", "utf16le"] as const) {
    const diagnostic = bytes.toString(encoding).trim().replace(/^\uFEFF/, "");
    const stage = diagnostic.match(
      /MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_STAGE:(bootstrap|request|directory|identity|descriptor|rule|create|verify)(?::(permission|missing|invalid|other))?/
    )?.[0];
    if (stage !== undefined) return stage;
  }
  if (bytes.toString("utf8").includes("MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_REQUEST")) {
    return "MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_STAGE:request";
  }
  if (bytes.toString("utf8").includes("MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_SECTIONS")) {
    return "MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_STAGE:sections";
  }
  if (bytes.toString("utf8").includes("MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_BOOTSTRAP")) {
    return "MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_STAGE:bootstrap";
  }
  return "MIFTAH_ACL_PRIVATE_DIRECTORY_PROBE_STAGE:unavailable";
}

function safeCopyFileSecurityProbeStage(output: readonly Buffer[]): string {
  const bytes = Buffer.concat(output);
  for (const encoding of ["utf8", "utf16le"] as const) {
    const diagnostic = bytes.toString(encoding).trim().replace(/^\uFEFF/, "");
    const stage = diagnostic.match(
      /MIFTAH_ACL_COPY_FILE_PROBE_STAGE:(bootstrap|request|source|target|apply|verify)(?::(permission|missing|invalid|other))?/
    )?.[0];
    if (stage !== undefined) return stage;
    const requestFailure = diagnostic.match(
      /MIFTAH_ACL_COPY_FILE_PROBE_REQUEST:(missing|empty|oversize|field-count-[1-9][0-9]*|operation)/
    )?.[0];
    if (requestFailure !== undefined) return requestFailure;
    const boundaries = diagnostic.match(/MIFTAH_ACL_COPY_FILE_PROBE_BOUNDARY:(source-get|source-binary|source-raw|target-get|target-fresh|target-set-binary|target-apply|verify-get|verify-rules)/g);
    const boundary = boundaries?.[boundaries.length - 1];
    if (boundary !== undefined) return boundary;
  }
  if (bytes.toString("utf8").includes("MIFTAH_ACL_COPY_FILE_PROBE_REQUEST")) {
    return "MIFTAH_ACL_COPY_FILE_PROBE_STAGE:request";
  }
  if (bytes.toString("utf8").includes("MIFTAH_ACL_COPY_FILE_PROBE_SECTIONS")) {
    return "MIFTAH_ACL_COPY_FILE_PROBE_STAGE:sections";
  }
  if (bytes.toString("utf8").includes("MIFTAH_ACL_COPY_FILE_PROBE_BOOTSTRAP")) {
    return "MIFTAH_ACL_COPY_FILE_PROBE_STAGE:bootstrap";
  }
  return "MIFTAH_ACL_COPY_FILE_PROBE_STAGE:unavailable";
}

/** Windows marks an unprotected DACL containing inherited ACEs as auto-inherited when it persists the descriptor. */
function expectedPersistedInheritedDaclSddl(sourceSddl: string): string {
  const daclIndex = sourceSddl.indexOf("D:");
  const dacl = sourceSddl.slice(daclIndex + 2);
  if (daclIndex < 0 || !dacl.startsWith("(") || !dacl.includes(";ID;")) {
    throw new Error("Windows ACL fixture must use an unmarked DACL with an inherited ACE");
  }
  return `${sourceSddl.slice(0, daclIndex)}D:AI${dacl}`;
}

async function windowsAclSddl(
  path: string,
  operation: "read" | "restrict",
  encodedCommand: string = encodedAclProbe
): Promise<string> {
  const request = Buffer.from(JSON.stringify({ path, operation }), "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      trustedPowerShellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      { env: aclEnvironment(request), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    const output: Buffer[] = [];
    const errorOutput: Buffer[] = [];
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The probe has no verified result after its bounded execution time.
      }
      reject(new Error(`Windows ACL probe timed out: ${safeAclProbeStage([...output, ...errorOutput])}`));
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errorOutput.push(chunk));
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Windows ACL probe could not start"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Windows ACL probe failed: ${safeAclProbeStage([...output, ...errorOutput])}`));
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

async function windowsPrivateDirectoryProbe(directory: string): Promise<void> {
  const request = Buffer.from(["create-private-directory", directory].join("\u0000"), "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      trustedPowerShellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPrivateDirectoryProbe],
      { env: restrictedAclEnvironment(request), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    const output: Buffer[] = [];
    const errorOutput: Buffer[] = [];
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The probe has no verified result after its bounded execution time.
      }
      reject(new Error(`Windows private-directory ACL probe timed out: ${safePrivateDirectoryProbeStage([...output, ...errorOutput])}`));
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errorOutput.push(chunk));
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Windows private-directory ACL probe could not start"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Windows private-directory ACL probe failed: ${safePrivateDirectoryProbeStage([...output, ...errorOutput])}`));
    });
  });
}

async function grantUntrustedAncestorMutation(directory: string): Promise<void> {
  const request = Buffer.from(directory, "utf8").toString("base64");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      trustedPowerShellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedUnsafeAncestorProbe],
      { env: restrictedAclEnvironment(request), shell: false, windowsHide: true, stdio: "ignore" }
    );
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The test probe has no verified result after its bounded execution time.
      }
      reject(new Error("Windows unsafe-ancestor ACL probe timed out"));
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Windows unsafe-ancestor ACL probe could not start"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error("Windows unsafe-ancestor ACL probe failed"));
    });
  });
}

async function windowsCopyFileSecurityProbe(
  source: string,
  target: string,
  mode: "existing-target" | "fresh-security" | "verify-access-rules" = "existing-target"
): Promise<void> {
  const operation = mode === "fresh-security"
    ? "copy-file-security-fresh"
    : mode === "verify-access-rules"
      ? "copy-file-security-verify-rules"
      : "copy-file-security";
  const request = Buffer.from([operation, source, target].join("\u0000"), "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      trustedPowerShellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCopyFileSecurityProbe],
      { env: restrictedAclEnvironment(request), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    const output: Buffer[] = [];
    const errorOutput: Buffer[] = [];
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The probe has no verified result after its bounded execution time.
      }
      reject(new Error(`Windows copy-file ACL probe timed out: ${safeCopyFileSecurityProbeStage([...output, ...errorOutput])}`));
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errorOutput.push(chunk));
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Windows copy-file ACL probe could not start"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Windows copy-file ACL probe failed: ${safeCopyFileSecurityProbeStage([...output, ...errorOutput])}`));
    });
  });
}

async function windowsAncestorDiagnostic(directory: string): Promise<string> {
  const request = Buffer.from(directory, "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      trustedPowerShellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedAncestorDiagnosticProbe],
      { env: restrictedAclEnvironment(request), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    const output: Buffer[] = [];
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The diagnostic probe has no verified result after its bounded execution time.
      }
      reject(new Error("Windows ancestor diagnostic probe timed out"));
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Windows ancestor diagnostic probe could not start"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error("Windows ancestor diagnostic probe failed"));
        return;
      }
      const result = Buffer.concat(output).toString("utf8");
      if (!/^(?:missing|reparse|owner|acl|rules|delete-child|delete|ownership|attributes|create-child|create-file|read):\d+$|^(?:ok|probe)$/.test(result)) {
        reject(new Error("Windows ancestor diagnostic probe returned an invalid category"));
        return;
      }
      resolve(result);
    });
  });
}

describe("Windows migration ACL contract", () => {
  it.runIf(process.platform === "win32")(
    "accepts a first-run child under a current-user-profile ancestor chain",
    async () => {
      const root = await createPrivateConsoleTestRoot("miftah-windows-profile-ancestor-");
      temporaryDirectories.push(root);
      const category = await windowsAncestorDiagnostic(root);
      console.info(`MIFTAH_WINDOWS_PROFILE_ANCESTOR_DIAGNOSTIC:${category}`);
      expect(category).toBe("ok");
      const privateParent = join(root, "private-parent");
      await windowsPrivateDirectoryProbe(privateParent);

      await expect(createWindowsPrivateDirectoryInPrivateParent(privateParent, join(privateParent, "miftah"))).resolves.toBe(true);
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "reports a redacted rejection category for a temporary configuration ancestor chain",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "miftah-windows-ancestor-diagnostic-"));
      temporaryDirectories.push(root);
      const privateParent = join(root, "private-parent");
      await windowsPrivateDirectoryProbe(privateParent);

      const category = await windowsAncestorDiagnostic(root);
      console.info(`MIFTAH_WINDOWS_ANCESTOR_DIAGNOSTIC:${category}`);
      expect(category).toMatch(/^(?:missing|reparse|owner|acl|rules|delete-child|delete|ownership|attributes|create-child|create-file|read):\d+$/);
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "rejects a private child whose grandparent lets untrusted users replace its parent",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "miftah-windows-unsafe-ancestor-"));
      temporaryDirectories.push(root);
      const unsafeGrandparent = join(root, "unsafe-grandparent");
      const privateParent = join(unsafeGrandparent, "private-parent");
      const child = join(privateParent, "miftah");
      await mkdir(unsafeGrandparent);
      await grantUntrustedAncestorMutation(unsafeGrandparent);
      await windowsPrivateDirectoryProbe(privateParent);

      await expect(createWindowsPrivateDirectoryInPrivateParent(privateParent, child)).resolves.toBe(false);
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "creates a private migration directory under the production ACL environment",
    async () => {
      const parentDirectory = await mkdtemp(join(tmpdir(), "miftah-windows-private-directory-"));
      temporaryDirectories.push(parentDirectory);

      await expect(windowsPrivateDirectoryProbe(join(parentDirectory, ".miftah-migrate-transaction"))).resolves.toBeUndefined();
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "terminates a hanging ACL descriptor probe",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "miftah-windows-hanging-acl-probe-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "miftah.json");
      await writeFile(path, "source", "utf8");

      await expect(windowsAclSddl(path, "read", encodedHangingAclProbe)).rejects.toThrow(
        "Windows ACL probe timed out: MIFTAH_ACL_PROBE_STAGE:unavailable"
      );
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "copies a restrictive file descriptor under the production ACL environment",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "miftah-windows-copy-file-acl-"));
      temporaryDirectories.push(directory);
      const sourcePath = join(directory, "source.json");
      const targetPath = join(directory, "target.json");
      await writeFile(sourcePath, "source", "utf8");
      await writeFile(targetPath, "target", "utf8");
      const expectedSddl = await windowsAclSddl(sourcePath, "restrict");

      await expect(windowsCopyFileSecurityProbe(sourcePath, targetPath)).resolves.toBeUndefined();
      expect(await windowsAclSddl(targetPath, "read")).toBe(expectedSddl);
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "accepts a current-user-only file descriptor through the production verifier",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "miftah-windows-private-file-verifier-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "miftah.json");
      await writeFile(path, "source", "utf8");

      await windowsAclSddl(path, "restrict");

      await expect(verifyWindowsConfigPathSecurity(path, "file")).resolves.toBe(true);
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "copies a restrictive file descriptor while the migration writer holds its new target open",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "miftah-windows-copy-held-file-acl-"));
      temporaryDirectories.push(directory);
      const sourcePath = join(directory, "source.json");
      const targetPath = join(directory, "target.json");
      await writeFile(sourcePath, "source", "utf8");
      const expectedSddl = await windowsAclSddl(sourcePath, "restrict");
      const targetHandle = await open(targetPath, "wx", 0o600);

      try {
        await expect(windowsCopyFileSecurityProbe(sourcePath, targetPath)).resolves.toBeUndefined();
      } finally {
        await targetHandle.close();
      }

      expect(await windowsAclSddl(targetPath, "read")).toBe(expectedSddl);
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "copies an inherited source descriptor after it moves into a private migration directory",
    async () => {
      const parentDirectory = await mkdtemp(join(tmpdir(), "miftah-windows-copy-inherited-acl-"));
      temporaryDirectories.push(parentDirectory);
      const originalSourcePath = join(parentDirectory, "miftah.json");
      const privateDirectory = join(parentDirectory, ".miftah-migrate-transaction");
      const sourcePath = join(privateDirectory, "source.miftah-migrate-hold");
      const targetPath = join(privateDirectory, "backup.miftah-migrate.tmp");
      await writeFile(originalSourcePath, "source", "utf8");
      await expect(windowsPrivateDirectoryProbe(privateDirectory)).resolves.toBeUndefined();
      await rename(originalSourcePath, sourcePath);
      const expectedSddl = await windowsAclSddl(sourcePath, "read");
      const targetHandle = await open(targetPath, "wx", 0o600);

      try {
        await expect(windowsCopyFileSecurityProbe(sourcePath, targetPath)).resolves.toBeUndefined();
      } finally {
        await targetHandle.close();
      }

      expect(await windowsAclSddl(targetPath, "read")).toBe(expectedPersistedInheritedDaclSddl(expectedSddl));
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "copies an inherited source descriptor after its migration writer closes",
    async () => {
      const parentDirectory = await mkdtemp(join(tmpdir(), "miftah-windows-copy-inherited-closed-acl-"));
      temporaryDirectories.push(parentDirectory);
      const originalSourcePath = join(parentDirectory, "miftah.json");
      const privateDirectory = join(parentDirectory, ".miftah-migrate-transaction");
      const sourcePath = join(privateDirectory, "source.miftah-migrate-hold");
      const targetPath = join(privateDirectory, "backup.miftah-migrate.tmp");
      await writeFile(originalSourcePath, "source", "utf8");
      await expect(windowsPrivateDirectoryProbe(privateDirectory)).resolves.toBeUndefined();
      await rename(originalSourcePath, sourcePath);
      const expectedSddl = await windowsAclSddl(sourcePath, "read");
      const targetHandle = await open(targetPath, "wx", 0o600);
      await targetHandle.close();

      await expect(windowsCopyFileSecurityProbe(sourcePath, targetPath)).resolves.toBeUndefined();
      expect(await windowsAclSddl(targetPath, "read")).toBe(expectedPersistedInheritedDaclSddl(expectedSddl));
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "diagnoses access-rule comparison after an inherited descriptor persists",
    async () => {
      const parentDirectory = await mkdtemp(join(tmpdir(), "miftah-windows-copy-inherited-rules-acl-"));
      temporaryDirectories.push(parentDirectory);
      const originalSourcePath = join(parentDirectory, "miftah.json");
      const privateDirectory = join(parentDirectory, ".miftah-migrate-transaction");
      const sourcePath = join(privateDirectory, "source.miftah-migrate-hold");
      const targetPath = join(privateDirectory, "backup.miftah-migrate.tmp");
      await writeFile(originalSourcePath, "source", "utf8");
      await expect(windowsPrivateDirectoryProbe(privateDirectory)).resolves.toBeUndefined();
      await rename(originalSourcePath, sourcePath);
      const expectedSddl = await windowsAclSddl(sourcePath, "read");
      const targetHandle = await open(targetPath, "wx", 0o600);
      await targetHandle.close();

      await expect(windowsCopyFileSecurityProbe(sourcePath, targetPath, "verify-access-rules")).resolves.toBeUndefined();
      expect(await windowsAclSddl(targetPath, "read")).toBe(expectedPersistedInheritedDaclSddl(expectedSddl));
    },
    10_000
  );

  it.runIf(process.platform === "win32")(
    "preserves inherited descriptor data when Windows marks the persisted DACL auto-inherited",
    async () => {
      const parentDirectory = await mkdtemp(join(tmpdir(), "miftah-windows-copy-inherited-fresh-acl-"));
      temporaryDirectories.push(parentDirectory);
      const originalSourcePath = join(parentDirectory, "miftah.json");
      const privateDirectory = join(parentDirectory, ".miftah-migrate-transaction");
      const sourcePath = join(privateDirectory, "source.miftah-migrate-hold");
      const targetPath = join(privateDirectory, "backup.miftah-migrate.tmp");
      await writeFile(originalSourcePath, "source", "utf8");
      await expect(windowsPrivateDirectoryProbe(privateDirectory)).resolves.toBeUndefined();
      await rename(originalSourcePath, sourcePath);
      const expectedSddl = await windowsAclSddl(sourcePath, "read");
      const targetHandle = await open(targetPath, "wx", 0o600);
      await targetHandle.close();

      await expect(windowsCopyFileSecurityProbe(sourcePath, targetPath, "fresh-security")).resolves.toBeUndefined();
      expect(await windowsAclSddl(targetPath, "read")).toBe(expectedPersistedInheritedDaclSddl(expectedSddl));
    },
    10_000
  );

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
