import { access, constants, open } from "node:fs/promises";
import { posix, win32 } from "node:path";

const windowsDirectExecutable = /\.(?:com|exe)$/iu;

export interface ExecutableResolverOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
}

/**
 * Resolves an executable without allowing a bare command to fall back to the
 * current working directory. Relative paths remain explicit caller choices.
 */
export async function resolveExecutablePath(
  command: string,
  options: ExecutableResolverOptions = {}
): Promise<string | undefined> {
  if (command.length === 0 || command.includes("\u0000")) return undefined;

  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const paths = platform === "win32" ? win32 : posix;
  const hasPath = command.includes("/") || command.includes("\\") || paths.isAbsolute(command);
  const candidates = hasPath
    ? [paths.isAbsolute(command) ? command : paths.resolve(options.cwd ?? process.cwd(), command)]
    : bareCommandCandidates(command, environment, platform);

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // An unavailable path is deliberately indistinguishable from other filesystem failures.
    }
  }
  return undefined;
}

/**
 * Resolves a Windows command only when it is a direct executable. Unlike the
 * general resolver, this intentionally never considers PATHEXT entries such
 * as .cmd or .bat and never resolves a relative path through the current
 * directory.
 */
export async function resolveWindowsDirectExecutablePath(
  command: string,
  options: ExecutableResolverOptions = {}
): Promise<string | undefined> {
  if (command.length === 0 || command.includes("\u0000")) return undefined;

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const environment = options.environment ?? process.env;
  const hasPath = command.includes("/") || command.includes("\\") || win32.isAbsolute(command);
  if (hasPath) {
    if (!win32.isAbsolute(command) || !windowsDirectExecutable.test(command)) return undefined;
    return accessibleExecutable(command);
  }

  if (win32.extname(command).length > 0 && !windowsDirectExecutable.test(command)) return undefined;
  const pathValue = environmentValue(environment, "PATH");
  if (pathValue === undefined) return undefined;
  const names = windowsDirectExecutable.test(command) ? [command] : [`${command}.exe`, `${command}.com`];

  for (const entry of pathValue.split(win32.delimiter)) {
    const directory = normalizePathEntry(entry);
    if (directory === undefined || !win32.isAbsolute(directory)) continue;
    for (const name of names) {
      const resolved = await accessibleExecutable(win32.join(directory, name));
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

function bareCommandCandidates(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  const paths = platform === "win32" ? win32 : posix;
  const pathValue = environmentValue(environment, "PATH");
  if (pathValue === undefined) return [];
  const extensions = platform === "win32" ? windowsExtensions(command, environment) : [""];
  const separator = paths.delimiter;
  const candidates: string[] = [];

  for (const entry of pathValue.split(separator)) {
    const directory = normalizePathEntry(entry);
    if (directory === undefined || !paths.isAbsolute(directory)) continue;
    for (const extension of extensions) candidates.push(paths.join(directory, `${command}${extension}`));
  }
  return candidates;
}

function windowsExtensions(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (win32.extname(command).length > 0) return [""];
  const pathExtensions = environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  return ["", ...pathExtensions.split(";").filter((extension) => extension.length > 0)];
}

async function accessibleExecutable(candidate: string): Promise<string | undefined> {
  try {
    await access(candidate, constants.X_OK);
    const file = await open(candidate, "r");
    try {
      const header = Buffer.alloc(2);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      // cross-spawn reparses shebang files through an interpreter before it
      // decides whether to invoke cmd.exe. A direct extension alone is not a
      // safe Windows stdio launch boundary.
      if (bytesRead >= header.length && header[0] === 0x23 && header[1] === 0x21) return undefined;
      return candidate;
    } finally {
      await file.close();
    }
  } catch {
    // An unavailable path is deliberately indistinguishable from other filesystem failures.
    return undefined;
  }
}

function normalizePathEntry(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  if (environment[name] !== undefined) return environment[name];
  const normalizedName = name.toLocaleLowerCase("en-US");
  for (const [candidateName, value] of Object.entries(environment)) {
    if (candidateName.toLocaleLowerCase("en-US") === normalizedName && value !== undefined) return value;
  }
  return undefined;
}
