import { spawn } from "node:child_process";

const defaultTimeoutMs = 10_000;
const maximumStdoutBytes = 64 * 1024;
const maximumStderrBytes = 8 * 1024;
const forceKillDelayMs = 250;

export type SecretProcessFailureKind = "unavailable" | "timeout" | "cancelled" | "output_limit" | "exit";
export type SecretProcessExitClassification = "locked" | "noninteractive" | "missing" | "other";

export interface SecretCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export interface SecretCommandOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SecretCommandResult {
  readonly stdout: Buffer;
}

/** Process failure that deliberately retains no child output or error text. */
export class SecretProcessError extends Error {
  constructor(
    readonly kind: SecretProcessFailureKind,
    readonly classification?: SecretProcessExitClassification
  ) {
    super(`Secret process ${kind}`);
    this.name = "SecretProcessError";
  }
}

/** Runs a provider helper without a shell and retains only bounded process output. */
export function runSecretCommand(
  command: SecretCommand,
  options: SecretCommandOptions = {}
): Promise<SecretCommandResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (options.signal?.aborted) {
    return Promise.reject(new SecretProcessError("cancelled"));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      env: command.environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalKind: SecretProcessFailureKind | undefined;
    let directChildExited = false;
    let forceKill: NodeJS.Timeout | undefined;
    let finished = false;

    const finish = (result: SecretCommandResult | SecretProcessError) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", onAbort);
      if (result instanceof SecretProcessError) {
        child.stdout.destroy();
        child.stderr.destroy();
        reject(result);
      } else resolve(result);
    };

    const terminate = (kind: SecretProcessFailureKind) => {
      if (terminalKind !== undefined) return;
      terminalKind = kind;
      if (directChildExited) {
        finish(new SecretProcessError(kind));
        return;
      }
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), forceKillDelayMs);
    };

    const onAbort = () => terminate("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);

    child.stdout.on("data", (value: Buffer) => {
      if (terminalKind !== undefined) return;
      if (stdoutBytes + value.length > maximumStdoutBytes) {
        terminate("output_limit");
        return;
      }
      stdoutBytes += value.length;
      stdoutChunks.push(value);
    });
    child.stderr.on("data", (value: Buffer) => {
      if (stderrBytes >= maximumStderrBytes) return;
      const retained = value.subarray(0, maximumStderrBytes - stderrBytes);
      stderrBytes += retained.length;
      stderrChunks.push(retained);
    });
    child.on("error", () => {
      terminalKind ??= "unavailable";
    });
    child.on("exit", () => {
      directChildExited = true;
      if (terminalKind !== undefined) finish(new SecretProcessError(terminalKind));
    });
    child.on("close", (code) => {
      if (terminalKind !== undefined) {
        finish(new SecretProcessError(terminalKind));
        return;
      }
      if (code !== 0) {
        finish(new SecretProcessError("exit", classifyStderr(Buffer.concat(stderrChunks))));
        return;
      }
      finish({ stdout: Buffer.concat(stdoutChunks) });
    });
  });
}

function classifyStderr(stderr: Buffer): SecretProcessExitClassification {
  const text = stderr.toString("utf8");
  if (/(locked|authentication|authorization|not signed in|sign in|unauthorized|invalid token)/iu.test(text)) {
    return "locked";
  }
  if (/(interaction.*not allowed|non-interactive|cannot prompt|no tty)/iu.test(text)) {
    return "noninteractive";
  }
  if (/(not found|not exist|no matching|could not be found)/iu.test(text)) {
    return "missing";
  }
  return "other";
}
