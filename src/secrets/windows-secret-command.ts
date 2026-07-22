import { spawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { win32 } from "node:path";
import { gzipSync } from "node:zlib";
import { resolveExecutablePath } from "./executable-resolver.js";
import { encodedWindowsSecretJobAssembly } from "./windows-secret-job-assembly.js";

const maximumRequestBytes = 16 * 1024;
const maximumEncodedInputLength = 21_848;
const maximumArgumentCount = 128;
const requestEnvironmentName = "MIFTAH_SECRET_RUNNER_REQUEST";
const standardInputEnvironmentName = "MIFTAH_SECRET_RUNNER_STDIN";
const helperSourceEnvironmentName = "MIFTAH_SECRET_RUNNER_HELPER";
const helperAssemblyEnvironmentName = "MIFTAH_SECRET_RUNNER_ASSEMBLY";
const maximumEncodedAssemblyLength = 8 * 1024;
const maximumAssemblyBytes = 16 * 1024;

export interface WindowsSecretCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin?: Buffer;
}

export interface ResolvedWindowsSecretCommand extends WindowsSecretCommand {
  readonly launcher: string;
}

/**
 * Resolves Windows provider executables before spawn so Node never performs a
 * current-directory lookup for a bare command.
 */
export async function resolveWindowsSecretCommand(
  command: WindowsSecretCommand
): Promise<ResolvedWindowsSecretCommand | undefined> {
  const launcher = await trustedPowerShellExecutable();
  if (launcher === undefined) return undefined;

  const executable = await resolveTargetExecutable(command.executable, command.environment, launcher);
  if (executable === undefined || isBatchFile(executable)) return undefined;
  return { ...command, executable, launcher };
}

/**
 * Starts a fixed helper which joins a kill-on-close Job Object before it
 * creates the provider process. The helper source contains no command data.
 */
export function spawnWindowsSecretCommand(command: ResolvedWindowsSecretCommand): ChildProcess {
  const request = encodeRequest(command);
  const standardInput = encodeStandardInput(command.stdin);
  if (request === undefined || (command.stdin !== undefined && standardInput === undefined)) {
    throw new Error("Invalid Windows secret command request");
  }

  const child = spawn(
    command.launcher,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedWindowsJobBootstrap],
    {
      env: helperEnvironment(command.environment, request, standardInput),
      shell: false,
      windowsHide: true,
      // Windows PowerShell consumes the inherited stdin pipe before an encoded
      // command runs, so the helper creates a dedicated child pipe instead.
      stdio: ["ignore", "pipe", "pipe"] as const
    }
  );
  return child;
}

async function resolveTargetExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
  launcher: string
): Promise<string | undefined> {
  const pathQualified =
    executable.includes("/") || executable.includes("\\") || win32.isAbsolute(executable);
  if (pathQualified) {
    return win32.isAbsolute(executable)
      ? resolveExecutablePath(executable, { environment, platform: "win32" })
      : undefined;
  }
  if (executable.toLocaleLowerCase("en-US") === "powershell.exe") return launcher;
  return resolveExecutablePath(executable, { environment, platform: "win32" });
}

async function trustedPowerShellExecutable(): Promise<string | undefined> {
  const systemRoot = environmentValue(process.env, "SystemRoot") ?? environmentValue(process.env, "windir") ?? "C:\\Windows";
  if (!win32.isAbsolute(systemRoot)) return undefined;
  const executable = win32.join(
    win32.resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  try {
    await access(executable, constants.X_OK);
    return executable;
  } catch {
    return undefined;
  }
}

function isBatchFile(executable: string): boolean {
  const extension = win32.extname(executable).toLocaleLowerCase("en-US");
  return extension === ".bat" || extension === ".cmd";
}

function encodeRequest(command: ResolvedWindowsSecretCommand): string | undefined {
  if (command.args.length > maximumArgumentCount || containsNul(command.executable)) return undefined;
  if (command.args.some(containsNul)) return undefined;

  const request = Buffer.from(
    JSON.stringify({
      executable: command.executable,
      arguments: command.args
    }),
    "utf8"
  );
  if (request.byteLength > maximumRequestBytes) return undefined;
  return request.toString("base64");
}

function encodeStandardInput(standardInput: Buffer | undefined): string | undefined {
  if (standardInput === undefined) return undefined;
  if (standardInput.byteLength > maximumRequestBytes) return undefined;
  return standardInput.toString("base64");
}

function containsNul(value: string): boolean {
  return value.includes("\u0000");
}

function helperEnvironment(
  environment: NodeJS.ProcessEnv,
  request: string,
  standardInput: string | undefined
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...environment };
  // Windows PowerShell can hang before its encoded bootstrap runs without this module-path setting.
  for (const name of ["SystemRoot", "windir", "ComSpec", "TEMP", "TMP", "PSModulePath"]) {
    if (environmentValue(result, name) === undefined) {
      const inherited = environmentValue(process.env, name);
      if (inherited !== undefined) setEnvironmentValue(result, name, inherited);
    }
  }
  setEnvironmentValue(result, requestEnvironmentName, request);
  deleteEnvironmentValue(result, standardInputEnvironmentName);
  if (standardInput !== undefined) setEnvironmentValue(result, standardInputEnvironmentName, standardInput);
  setEnvironmentValue(result, helperSourceEnvironmentName, encodedWindowsJobHelper);
  setEnvironmentValue(result, helperAssemblyEnvironmentName, encodedWindowsSecretJobAssembly);
  return result;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLocaleLowerCase("en-US");
  for (const [candidateName, value] of Object.entries(environment)) {
    if (candidateName.toLocaleLowerCase("en-US") === normalizedName && value !== undefined) return value;
  }
  return undefined;
}

function setEnvironmentValue(environment: NodeJS.ProcessEnv, name: string, value: string): void {
  deleteEnvironmentValue(environment, name);
  environment[name] = value;
}

function deleteEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): void {
  const normalizedName = name.toLocaleLowerCase("en-US");
  for (const candidateName of Object.keys(environment)) {
    if (candidateName.toLocaleLowerCase("en-US") === normalizedName) delete environment[candidateName];
  }
}

const windowsJobHelper = String.raw`$ErrorActionPreference = 'Stop'
$requestName = '${requestEnvironmentName}'
$standardInputName = '${standardInputEnvironmentName}'
$assemblyName = '${helperAssemblyEnvironmentName}'
try {
  $encodedRequest = [Environment]::GetEnvironmentVariable($requestName, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrEmpty($encodedRequest) -or $encodedRequest.Length -gt 21848) { exit 1 }
  $requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedRequest))
  $encodedStandardInput = [Environment]::GetEnvironmentVariable($standardInputName, [EnvironmentVariableTarget]::Process)
  $encodedAssembly = [Environment]::GetEnvironmentVariable($assemblyName, [EnvironmentVariableTarget]::Process)
  [Environment]::SetEnvironmentVariable($requestName, $null, [EnvironmentVariableTarget]::Process)
  [Environment]::SetEnvironmentVariable($standardInputName, $null, [EnvironmentVariableTarget]::Process)
  [Environment]::SetEnvironmentVariable($assemblyName, $null, [EnvironmentVariableTarget]::Process)
  $standardInput = $null
  if ($null -ne $encodedStandardInput) {
    if ($encodedStandardInput.Length -gt ${maximumEncodedInputLength}) { exit 1 }
    $standardInput = [Convert]::FromBase64String($encodedStandardInput)
    if ($standardInput.Length -gt ${maximumRequestBytes}) { exit 1 }
  }
  $request = $requestJson | ConvertFrom-Json
  if ($null -eq $request -or $null -eq $request.executable -or $null -eq $request.arguments) { exit 1 }
  if ([string]::IsNullOrEmpty($encodedAssembly) -or $encodedAssembly.Length -gt ${maximumEncodedAssemblyLength}) { exit 1 }
  $assemblyInput = [IO.MemoryStream]::new([Convert]::FromBase64String($encodedAssembly), $false)
  $assemblyGzip = [IO.Compression.GzipStream]::new($assemblyInput, [IO.Compression.CompressionMode]::Decompress, $false)
  $assemblyOutput = [IO.MemoryStream]::new()
  $assemblyBuffer = [byte[]]::new(4096)
  try {
    while (($assemblyCount = $assemblyGzip.Read($assemblyBuffer, 0, $assemblyBuffer.Length)) -gt 0) {
      if ($assemblyOutput.Length + $assemblyCount -gt ${maximumAssemblyBytes}) { exit 1 }
      $assemblyOutput.Write($assemblyBuffer, 0, $assemblyCount)
    }
  } finally {
    $assemblyGzip.Dispose()
    $assemblyInput.Dispose()
  }
  if ($assemblyOutput.Length -eq 0 -or $assemblyOutput.Length -gt ${maximumAssemblyBytes}) { exit 1 }
  [Reflection.Assembly]::Load($assemblyOutput.ToArray()) | Out-Null
  $assemblyOutput.Dispose()
  if (-not [MiftahSecretJob]::Initialize()) { exit 1 }
  $arguments = @($request.arguments | ForEach-Object {
    if ($null -eq $_) { throw 'Invalid argument' }
    [string]$_
  })
  $exitCode = [MiftahSecretJob]::Run([string]$request.executable, [string[]]$arguments, [byte[]]$standardInput)
  exit $exitCode
} catch {
  exit 1
}`;

const encodedWindowsJobHelper = gzipSync(windowsJobHelper).toString("base64");
const windowsJobBootstrap = String.raw`$ErrorActionPreference = 'Stop'
$helperName = '${helperSourceEnvironmentName}'
try {
  $encodedHelper = [Environment]::GetEnvironmentVariable($helperName, [EnvironmentVariableTarget]::Process)
  [Environment]::SetEnvironmentVariable($helperName, $null, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrEmpty($encodedHelper) -or $encodedHelper.Length -gt 8192) { exit 1 }
  $input = [IO.MemoryStream]::new([Convert]::FromBase64String($encodedHelper), $false)
  $gzip = [IO.Compression.GzipStream]::new($input, [IO.Compression.CompressionMode]::Decompress, $false)
  $reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
  try {
    $source = $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
  if ([string]::IsNullOrEmpty($source)) { exit 1 }
  & ([ScriptBlock]::Create($source))
} catch {
  exit 1
}`;
const encodedWindowsJobBootstrap = Buffer.from(windowsJobBootstrap, "utf16le").toString("base64");
