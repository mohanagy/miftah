import { spawn, type ChildProcess } from "node:child_process";

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
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalKind: SecretProcessFailureKind | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let terminationPoll: NodeJS.Timeout | undefined;
    let childClosed = false;
    let terminationComplete = true;
    let finished = false;

    const finish = (result: SecretCommandResult | SecretProcessError) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (terminationPoll) clearInterval(terminationPoll);
      options.signal?.removeEventListener("abort", onAbort);
      if (result instanceof SecretProcessError) {
        reject(result);
      } else resolve(result);
    };

    const finishTerminalFailure = () => {
      if (terminalKind === undefined || !childClosed || !terminationComplete) return;
      finish(new SecretProcessError(terminalKind));
    };

    const terminatePosixProcessGroup = (): Promise<void> => {
      const pid = child.pid;
      if (pid === undefined) return Promise.resolve();
      signalPosixProcessGroup(pid, "SIGTERM");
      return new Promise((resolve) => {
        const complete = () => {
          if (forceKill) clearTimeout(forceKill);
          if (terminationPoll) clearInterval(terminationPoll);
          forceKill = undefined;
          terminationPoll = undefined;
          resolve();
        };
        forceKill = setTimeout(() => {
          signalPosixProcessGroup(pid, "SIGKILL");
          complete();
        }, forceKillDelayMs);
        terminationPoll = setInterval(() => {
          if (!isPosixProcessGroupRunning(pid)) complete();
        }, 10);
        if (!isPosixProcessGroupRunning(pid)) complete();
      });
    };

    const terminateWindowsProcessTree = (): Promise<void> => {
      const pid = child.pid;
      if (pid === undefined) return Promise.resolve();
      return new Promise((resolve) => {
        let settled = false;
        let taskkill: ChildProcess | undefined;
        const settle = () => {
          if (settled) return;
          settled = true;
          taskkill?.removeListener("error", settle);
          taskkill?.removeListener("close", settle);
          resolve();
        };
        try {
          taskkill = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore"
          });
        } catch {
          resolve();
          return;
        }
        taskkill.once("error", settle);
        taskkill.once("close", settle);
      });
    };

    const terminate = (kind: SecretProcessFailureKind) => {
      if (terminalKind !== undefined) return;
      terminalKind = kind;
      terminationComplete = false;
      const cleanup = process.platform === "win32" ? terminateWindowsProcessTree() : terminatePosixProcessGroup();
      void cleanup.then(
        () => {
          terminationComplete = true;
          finishTerminalFailure();
        },
        () => {
          terminationComplete = true;
          finishTerminalFailure();
        }
      );
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
    child.on("close", (code) => {
      childClosed = true;
      if (terminalKind !== undefined) {
        finishTerminalFailure();
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

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // A failed group signal has no provider output to expose.
  }
}

function isPosixProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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
