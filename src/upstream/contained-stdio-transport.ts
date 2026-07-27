import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { PassThrough, type Stream } from "node:stream";
import { getDefaultEnvironment, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import {
  resolveWindowsSecretCommand,
  spawnWindowsSecretCommand,
  type ResolvedWindowsSecretCommand
} from "../secrets/windows-secret-command.js";

const gracefulShutdownDelayMs = 2_000;
const containmentVerificationDelayMs = 25;

/** Resolves the Windows helper before Client.connect can race its child startup. */
export async function createContainedStdioClientTransport(
  server: StdioServerParameters
): Promise<ContainedStdioClientTransport> {
  const environment = { ...getDefaultEnvironment(), ...server.env };
  if (process.platform !== "win32") {
    return new ContainedStdioClientTransport(server, { environment });
  }
  const windowsCommand = await resolveWindowsSecretCommand({
    executable: server.command,
    args: server.args ?? [],
    environment
  });
  if (windowsCommand === undefined) {
    throw new Error("Windows stdio process containment launcher is unavailable");
  }
  return new ContainedStdioClientTransport(server, { environment, windowsCommand });
}

/**
 * Stdio transport with a process-tree containment boundary for locally
 * launched upstreams. POSIX children lead a dedicated process group. On
 * Windows, the checked Job Object helper owns the provider and its children.
 * Every command is passed as an argument array with shell expansion disabled.
 */
export class ContainedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null;
  private child: ChildProcess | undefined;
  private containedPid: number | undefined;
  private childClose: Promise<void> | undefined;
  private resolveChildClose: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;
  private forceTermination: Promise<void> | undefined;
  private explicitlyClosing = false;
  private closeEmitted = false;
  private containmentFailure: Error | undefined;

  constructor(
    private readonly server: StdioServerParameters,
    private readonly launch: {
      readonly environment?: NodeJS.ProcessEnv;
      readonly windowsCommand?: ResolvedWindowsSecretCommand;
    } = {}
  ) {
    this.stderrStream = server.stderr === "pipe" || server.stderr === "overlapped" ? new PassThrough() : null;
  }

  /** Starts an upstream with the same wire protocol behavior as the SDK transport. */
  start(): Promise<void> {
    if (this.child !== undefined || this.childClose !== undefined) {
      throw new Error("ContainedStdioClientTransport already started! If using Client class, note that connect() calls start().");
    }

    const child = this.spawnContainedChild();
    this.child = child;
    this.containedPid = child.pid;
    this.childClose = new Promise((resolve) => {
      this.resolveChildClose = resolve;
    });

    return new Promise((resolve, reject) => {
      let spawned = false;
      child.once("error", (error) => {
        this.onerror?.(error);
        if (!spawned) reject(error);
      });
      child.once("spawn", () => {
        spawned = true;
        this.containedPid = child.pid;
        resolve();
      });
      child.once("exit", () => {
        // Node emits `exit` before `close` when a child leaves descendants
        // holding inherited stdio. Reap at the exit boundary; waiting for
        // `close` here would prevent crash recovery forever.
        if (!this.explicitlyClosing && process.platform !== "win32") void this.forceTerminate();
      });
      child.once("close", () => {
        if (this.child === child) this.child = undefined;
        this.resolveChildClose?.();
        if (!this.explicitlyClosing) void this.finishUnexpectedClose();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.processReadBuffer();
      });
      child.stdout?.on("error", (error) => this.onerror?.(error));
      if (this.stderrStream !== null && child.stderr !== null) child.stderr.pipe(this.stderrStream);
    });
  }

  /** Returns stderr immediately when piping was requested, before the child starts. */
  get stderr(): Stream | null {
    return this.stderrStream ?? this.child?.stderr ?? null;
  }

  /** Returns the direct child PID only while it is still live. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * Requests forceful termination without declaring containment complete.
   * Only a verified close signal permits the manager to recycle capacity.
   */
  forceTerminate(): Promise<void> {
    if (this.forceTermination !== undefined) return this.forceTermination;
    this.forceTermination = this.requestForceTermination();
    return this.forceTermination;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.explicitlyClosing = true;
    this.closePromise = this.closeContainedChild();
    return this.closePromise;
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    void _options;
    return new Promise((resolve) => {
      const stdin = this.child?.stdin;
      if (stdin === undefined || stdin === null) throw new Error("Not connected");
      const serialized = serializeMessage(message);
      if (stdin.write(serialized)) {
        resolve();
      } else {
        stdin.once("drain", resolve);
      }
    });
  }

  private spawnContainedChild(): ChildProcess {
    if (process.platform !== "win32") {
      return spawn(this.server.command, this.server.args ?? [], {
        env: this.launch.environment ?? { ...getDefaultEnvironment(), ...this.server.env },
        stdio: ["pipe", "pipe", this.server.stderr ?? "inherit"],
        shell: false,
        windowsHide: true,
        // A dedicated group lets Miftah address ordinary POSIX descendants.
        detached: true,
        cwd: this.server.cwd
      });
    }

    const command = this.launch.windowsCommand;
    if (command === undefined) {
      throw new Error("Windows stdio process containment launcher is unavailable");
    }
    return spawnWindowsSecretCommand(command, {
      stdin: "pipe",
      ...(this.server.cwd === undefined ? {} : { cwd: this.server.cwd })
    });
  }

  private async closeContainedChild(): Promise<void> {
    try {
      const childClose = this.childClose;
      try {
        this.child?.stdin?.end();
      } catch {
        // The containment boundary below determines whether shutdown completed.
      }

      if (childClose !== undefined) {
        const closedGracefully = await settlesWithin(childClose, gracefulShutdownDelayMs);
        if (!closedGracefully) await this.forceTerminate();
        await childClose;
      }
      await this.verifyContainment();
      this.emitClose();
    } finally {
      this.readBuffer.clear();
    }
  }

  private async requestForceTermination(): Promise<void> {
    const pid = this.containedPid;
    if (pid === undefined) return;

    if (process.platform === "win32") {
      // The direct child is the checked helper. Killing it closes its Job Object,
      // which atomically terminates the provider tree even after the provider
      // parent has already exited.
      const child = this.child;
      if (child === undefined || hasExited(child)) return;
      try {
        if (!child.kill("SIGKILL") && !hasExited(child)) {
          this.recordContainmentFailure("Windows process-tree termination could not be requested");
        }
      } catch {
        this.recordContainmentFailure("Windows process-tree termination could not be requested");
      }
      return;
    }

    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (errorCode(error) !== "ESRCH") {
        this.recordContainmentFailure("POSIX process-tree termination could not be requested");
      }
    }
  }

  private async finishUnexpectedClose(): Promise<void> {
    try {
      if (process.platform !== "win32" && this.forceTermination === undefined) {
        await this.forceTerminate();
      } else {
        await this.forceTermination;
      }
      await this.verifyContainment();
      this.emitClose();
    } catch {
      // Keep the public close signal withheld: the manager must retain its
      // teardown gate rather than recycle capacity after an unverified cleanup.
    }
  }

  private async verifyContainment(): Promise<void> {
    if (this.containmentFailure !== undefined) throw this.containmentFailure;
    const pid = this.containedPid;
    if (pid === undefined) return;

    if (process.platform === "win32") {
      // The helper's close is the Job Object close boundary. Its provider and
      // descendants cannot outlive the helper without an explicit breakaway.
      this.containedPid = undefined;
      return;
    }

    let groupRunning: boolean;
    try {
      groupRunning = isPosixProcessGroupRunning(pid);
    } catch {
      this.recordContainmentFailure("POSIX process-tree state could not be verified");
      throw this.containmentFailure!;
    }
    if (!groupRunning) {
      this.containedPid = undefined;
      return;
    }
    await this.forceTerminate();
    if (this.containmentFailure !== undefined) throw this.containmentFailure;
    await delayUnref(containmentVerificationDelayMs);
    try {
      groupRunning = isPosixProcessGroupRunning(pid);
    } catch {
      this.recordContainmentFailure("POSIX process-tree state could not be verified");
      throw this.containmentFailure!;
    }
    if (groupRunning) {
      this.recordContainmentFailure("POSIX process-tree termination could not be confirmed");
      throw this.containmentFailure!;
    }
    this.containedPid = undefined;
  }

  private recordContainmentFailure(message: string): void {
    if (this.containmentFailure !== undefined) return;
    const error = new Error(message);
    this.containmentFailure = error;
    this.onerror?.(error);
  }

  private emitClose(): void {
    if (this.closeEmitted || this.containmentFailure !== undefined) return;
    this.closeEmitted = true;
    this.onclose?.();
  }

  private processReadBuffer(): void {
    for (;;) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(asError(error));
      }
    }
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPosixProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

function settlesWithin(pending: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
    void pending.then(
      () => finish(true),
      () => finish(false)
    );
  });
}

function delayUnref(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref();
  });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Stdio transport message handling failed");
}
