import { win32 } from "node:path";
import {
  resolveWindowsDirectExecutablePath,
  type ExecutableResolverOptions
} from "../secrets/executable-resolver.js";
import { MiftahError } from "../utils/errors.js";

const shellExecutable = /^(?:bash|cmd|command|fish|powershell|pwsh|sh|zsh)$/iu;
const directExecutable = /\.(?:com|exe)$/iu;

function executableStem(executable: string): string {
  return win32.basename(executable).replace(directExecutable, "");
}

export interface ResolvedStdioCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Deterministic overrides used by focused resolver tests. */
export interface WindowsStdioCommandResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly resolveExecutable?: (
    command: string,
    options?: ExecutableResolverOptions
  ) => Promise<string | undefined>;
}

/**
 * Normalizes a stdio launch to a direct Windows executable before the MCP SDK
 * receives it. cross-spawn otherwise routes bare and command-shim names through
 * cmd.exe even when its shell option is false.
 */
export async function resolveWindowsStdioCommand(
  command: string,
  args: readonly string[],
  options: WindowsStdioCommandResolutionOptions = {}
): Promise<ResolvedStdioCommand> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args };

  const resolveExecutable = options.resolveExecutable ?? resolveWindowsDirectExecutablePath;
  const executable = await resolveExecutable(command, {
    platform,
    ...(options.environment === undefined ? {} : { environment: options.environment })
  });
  if (
    executable === undefined ||
    !directExecutable.test(executable) ||
    shellExecutable.test(executableStem(executable))
  ) {
    throw new MiftahError(
      "UPSTREAM_START_FAILED",
      "UPSTREAM_START_FAILED: Windows stdio upstreams require a direct .exe or .com executable; command shells and command shims are not supported."
    );
  }

  return { command: executable, args };
}
