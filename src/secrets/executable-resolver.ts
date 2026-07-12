import { access, constants } from "node:fs/promises";
import { delimiter, posix, win32 } from "node:path";

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

function bareCommandCandidates(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  const paths = platform === "win32" ? win32 : posix;
  const pathValue = environmentValue(environment, "PATH");
  if (pathValue === undefined) return [];
  const extensions = platform === "win32" ? windowsExtensions(command, environment) : [""];
  const separator = platform === "win32" ? ";" : delimiter;
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
