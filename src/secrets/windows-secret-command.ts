import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutablePath } from "./executable-resolver.js";
import { windowsSecretJobExecutableSha256 } from "./windows-secret-job-artifact.js";

const maximumRequestBytes = 16 * 1024;
const maximumArgumentCount = 128;
const requestEnvironmentName = "MIFTAH_SECRET_RUNNER_REQUEST";
const standardInputEnvironmentName = "MIFTAH_SECRET_RUNNER_STDIN";
const obsoleteHelperEnvironmentNames = [
  "MIFTAH_SECRET_RUNNER_HELPER",
  "MIFTAH_SECRET_RUNNER_ASSEMBLY"
] as const;
const windowsSecretJobExecutableCandidates = [
  fileURLToPath(new URL("./windows-secret-job.exe", import.meta.url)),
  fileURLToPath(new URL("../windows-secret-job.exe", import.meta.url)),
  fileURLToPath(new URL("../../assets/windows-secret-job.exe", import.meta.url))
] as const;

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
 * Resolves both the checked helper and the provider executable before spawn so
 * Node never performs a current-directory lookup for a bare command.
 */
export async function resolveWindowsSecretCommand(
  command: WindowsSecretCommand
): Promise<ResolvedWindowsSecretCommand | undefined> {
  const executable = await resolveTargetExecutable(command.executable, command.environment);
  if (executable === undefined || isBatchFile(executable)) return undefined;

  const launcher = await trustedWindowsSecretJobExecutable();
  if (launcher === undefined) return undefined;
  return { ...command, executable, launcher };
}

/**
 * Starts a checked, precompiled helper which joins a kill-on-close Job Object
 * before it creates the provider process. Provider command data is carried only
 * in the helper's bounded environment envelope, never in its command line.
 */
export function spawnWindowsSecretCommand(command: ResolvedWindowsSecretCommand): ChildProcess {
  const request = encodeRequest(command);
  const standardInput = encodeStandardInput(command.stdin);
  if (request === undefined || (command.stdin !== undefined && standardInput === undefined)) {
    throw new Error("Invalid Windows secret command request");
  }

  return spawn(command.launcher, [], {
    env: helperEnvironment(command.environment, request, standardInput),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"] as const
  });
}

async function resolveTargetExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const pathQualified =
    executable.includes("/") || executable.includes("\\") || win32.isAbsolute(executable);
  if (pathQualified) {
    return win32.isAbsolute(executable)
      ? resolveExecutablePath(executable, { environment, platform: "win32" })
      : undefined;
  }
  if (executable.toLocaleLowerCase("en-US") === "powershell.exe") {
    return trustedPowerShellExecutable();
  }
  return resolveExecutablePath(executable, { environment, platform: "win32" });
}

async function trustedWindowsSecretJobExecutable(): Promise<string | undefined> {
  for (const executable of windowsSecretJobExecutableCandidates) {
    let contents: Buffer;
    try {
      contents = await readFile(executable);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      return undefined;
    }

    const fingerprint = createHash("sha256").update(contents).digest("hex");
    if (fingerprint !== windowsSecretJobExecutableSha256) return undefined;
    return executable;
  }
  return undefined;
}

async function trustedPowerShellExecutable(): Promise<string | undefined> {
  const systemRoot =
    environmentValue(process.env, "SystemRoot") ??
    environmentValue(process.env, "windir") ??
    "C:\\Windows";
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

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isBatchFile(executable: string): boolean {
  const extension = win32.extname(executable).toLocaleLowerCase("en-US");
  return extension === ".bat" || extension === ".cmd";
}

function encodeRequest(command: ResolvedWindowsSecretCommand): string | undefined {
  if (
    command.executable.length === 0 ||
    command.args.length > maximumArgumentCount ||
    containsNul(command.executable) ||
    command.args.some(containsNul)
  ) {
    return undefined;
  }

  const executable = Buffer.from(command.executable, "utf8");
  const arguments_ = command.args.map((argument) => Buffer.from(argument, "utf8"));
  const requestLength =
    1 + 4 + executable.byteLength + 4 + arguments_.reduce((total, argument) => total + 4 + argument.byteLength, 0);
  if (requestLength > maximumRequestBytes) return undefined;

  const request = Buffer.allocUnsafe(requestLength);
  let offset = 0;
  request.writeUInt8(1, offset);
  offset += 1;
  offset = writeRequestString(request, offset, executable);
  request.writeInt32LE(arguments_.length, offset);
  offset += 4;
  for (const argument of arguments_) offset = writeRequestString(request, offset, argument);
  return request.toString("base64");
}

function writeRequestString(target: Buffer, offset: number, value: Buffer): number {
  target.writeInt32LE(value.byteLength, offset);
  offset += 4;
  value.copy(target, offset);
  return offset + value.byteLength;
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
  for (const name of ["SystemRoot", "windir", "ComSpec", "TEMP", "TMP", "PSModulePath"]) {
    if (environmentValue(result, name) === undefined) {
      const inherited = environmentValue(process.env, name);
      if (inherited !== undefined) setEnvironmentValue(result, name, inherited);
    }
  }
  setEnvironmentValue(result, requestEnvironmentName, request);
  deleteEnvironmentValue(result, standardInputEnvironmentName);
  if (standardInput !== undefined) setEnvironmentValue(result, standardInputEnvironmentName, standardInput);
  for (const name of obsoleteHelperEnvironmentNames) deleteEnvironmentValue(result, name);
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
