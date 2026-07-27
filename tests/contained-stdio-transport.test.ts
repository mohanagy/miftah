import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedWindowsSecretCommand } from "../src/secrets/windows-secret-command.js";

const windowsSecretCommandMocks = vi.hoisted(() => ({
  resolveWindowsSecretCommand: vi.fn(),
  spawnWindowsSecretCommand: vi.fn()
}));

vi.mock("../src/secrets/windows-secret-command.js", () => ({
  resolveWindowsSecretCommand: windowsSecretCommandMocks.resolveWindowsSecretCommand,
  spawnWindowsSecretCommand: windowsSecretCommandMocks.spawnWindowsSecretCommand
}));

import {
  ContainedStdioClientTransport,
  createContainedStdioClientTransport
} from "../src/upstream/contained-stdio-transport.js";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = join(fixtureDirectory, "fixtures", "fake-upstream.mjs");
const retainedDescendantFixture = join(fixtureDirectory, "fixtures", "retained-stdio-descendant.mjs");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function createFakeChild(pid = 41_042): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true)
  }) as FakeChild;
}

function fixtureProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitFor<Value>(
  read: () => Value | Promise<Value>,
  matches: (value: Value) => boolean,
  timeoutMs = 2_000
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!matches(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for transport state; last value: ${JSON.stringify(value)}`);
    }
    await delay(10);
    value = await read();
  }
  return value;
}

afterEach(() => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
  windowsSecretCommandMocks.resolveWindowsSecretCommand.mockReset();
  windowsSecretCommandMocks.spawnWindowsSecretCommand.mockReset();
});

describe("contained stdio transport", () => {
  it.runIf(process.platform !== "win32")("ends stdin, confirms a POSIX process group is gone, and emits one close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-contained-stdio-close-"));
    const shutdownEndPath = join(directory, "shutdown-ended");
    const transport = await createContainedStdioClientTransport({
      command: process.execPath,
      args: [fixture],
      env: { TEST_SHUTDOWN_END_PATH: shutdownEndPath },
      stderr: "pipe"
    });
    const closed = vi.fn();
    transport.onclose = closed;

    try {
      await transport.start();
      expect(transport.pid).not.toBeNull();
      expect(transport.stderr).not.toBeNull();

      await transport.close();

      await expect(readFile(shutdownEndPath, "utf8")).resolves.toBe("ended");
      expect(transport.pid).toBeNull();
      expect(closed).toHaveBeenCalledOnce();
      await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow("Not connected");
    } finally {
      await transport.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("reaps a stdout-retaining descendant after an unexpected direct-child exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-contained-stdio-crash-"));
    const descendantPidPath = join(directory, "descendant-pid");
    const transport = await createContainedStdioClientTransport({
      command: process.execPath,
      args: [retainedDescendantFixture],
      env: { TEST_RETAINED_STDIO_DESCENDANT_PID_PATH: descendantPidPath },
      stderr: "pipe"
    });
    let descendantPid: number | undefined;
    const transportClosed = new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });

    try {
      await transport.start();
      await waitFor(() => existsSync(descendantPidPath), Boolean);
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      const parentPid = transport.pid;
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(parentPid).not.toBeNull();
      if (parentPid === null) throw new Error("Expected contained child PID");

      process.kill(parentPid, "SIGKILL");
      await transportClosed;
      const recordedDescendantPid = descendantPid;
      if (recordedDescendantPid === undefined) throw new Error("Expected retained descendant PID");
      await waitFor(
        () => fixtureProcessIsAlive(recordedDescendantPid),
        (alive) => alive === false
      );
    } finally {
      if (descendantPid !== undefined && fixtureProcessIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
      await transport.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the checked Windows Job Object launcher as a piped MCP transport", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const command: ResolvedWindowsSecretCommand = {
      executable: "C:\\tools\\provider.exe",
      args: ["--mcp"],
      environment: { PATH: "C:\\tools" },
      launcher: "C:\\miftah\\windows-secret-job.exe"
    };
    const child = createFakeChild();
    const sent: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => sent.push(chunk));
    child.stdin.once("finish", () => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    windowsSecretCommandMocks.resolveWindowsSecretCommand.mockResolvedValue(command);
    windowsSecretCommandMocks.spawnWindowsSecretCommand.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    });

    const transport = await createContainedStdioClientTransport({
      command: command.executable,
      args: [...command.args],
      env: { TEST_ACCOUNT_NAME: "work" },
      cwd: "C:\\workspace",
      // Overlapped stderr must still be readable through the checked Windows
      // Job Object launcher.
      stderr: "overlapped"
   });
   const messages: unknown[] = [];
    const errors: Error[] = [];
    const closed = vi.fn();
    transport.onmessage = (message) => messages.push(message);
    transport.onerror = (error) => errors.push(error);
    transport.onclose = closed;

    await transport.start();
    expect(transport.stderr).not.toBeNull();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    child.emit("error", new Error("helper reported an error after spawn"));
    child.stdin.emit("error", new Error("provider stdin failed"));
    child.stdout.emit("error", new Error("provider stdout failed"));
    child.stdout.write(Buffer.from("not-json\n"));
    child.stdout.write(Buffer.from('{"jsonrpc":"2.0","method":"notifications/test"}\n'));

    const write = vi.spyOn(child.stdin, "write").mockReturnValue(false);
    let drained = false;
    const sendAfterBackpressure = transport.send({ jsonrpc: "2.0", id: 2, method: "drain" }).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    child.stdin.emit("drain");
    await sendAfterBackpressure;
    write.mockRestore();

    await transport.close();

    expect(windowsSecretCommandMocks.resolveWindowsSecretCommand).toHaveBeenCalledWith({
      executable: command.executable,
      args: command.args,
      environment: expect.objectContaining({ TEST_ACCOUNT_NAME: "work" })
    });
    expect(windowsSecretCommandMocks.spawnWindowsSecretCommand).toHaveBeenCalledWith(command, {
      stdin: "pipe",
      cwd: "C:\\workspace"
    });
    expect(Buffer.concat(sent).toString("utf8")).toContain('"method":"ping"');
    expect(messages).toEqual([{ jsonrpc: "2.0", method: "notifications/test" }]);
    expect(errors).toHaveLength(4);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("fails before startup when the Windows containment launcher cannot be verified", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    windowsSecretCommandMocks.resolveWindowsSecretCommand.mockResolvedValue(undefined);

    await expect(
      createContainedStdioClientTransport({ command: "C:\\tools\\provider.exe", env: {} })
    ).rejects.toThrow("containment launcher is unavailable");
    expect(windowsSecretCommandMocks.resolveWindowsSecretCommand).toHaveBeenCalledWith(
      expect.objectContaining({ executable: "C:\\tools\\provider.exe", args: [] })
    );
    expect(windowsSecretCommandMocks.spawnWindowsSecretCommand).not.toHaveBeenCalled();
  });

  it("withholds its close signal when Windows Job Object termination cannot be requested", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const command: ResolvedWindowsSecretCommand = {
      executable: "C:\\tools\\provider.exe",
      args: [],
      environment: {},
      launcher: "C:\\miftah\\windows-secret-job.exe"
    };
    const child = createFakeChild();
    child.kill.mockReturnValue(false);
    windowsSecretCommandMocks.resolveWindowsSecretCommand.mockResolvedValue(command);
    windowsSecretCommandMocks.spawnWindowsSecretCommand.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    });
    const transport = await createContainedStdioClientTransport({ command: command.executable, args: [], env: {} });
    const errors: Error[] = [];
    const closed = vi.fn();
    transport.onerror = (error) => errors.push(error);
    transport.onclose = closed;

    await transport.start();
    await transport.forceTerminate();
    child.emit("close", null, "SIGKILL");
    await delay(0);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(errors).toEqual([expect.objectContaining({ message: "Windows process-tree termination could not be requested" })]);
    expect(closed).not.toHaveBeenCalled();
    await expect(transport.close()).rejects.toThrow("Windows process-tree termination could not be requested");
  });

  it("rejects direct Windows startup without a previously verified Job Object launcher", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const transport = new ContainedStdioClientTransport({ command: "C:\\tools\\provider.exe", args: [] });

    expect(() => transport.start()).toThrow("containment launcher is unavailable");
    expect(windowsSecretCommandMocks.spawnWindowsSecretCommand).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "re-checks a POSIX process group after forceful cleanup before declaring containment complete",
    async () => {
      const transport = new ContainedStdioClientTransport({ command: process.execPath, args: [fixture] });
      const internal = transport as unknown as {
        containedPid: number | undefined;
        verifyContainment(): Promise<void>;
      };
      const pid = 41_043;
      let probes = 0;
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid && signal === 0) {
          probes += 1;
          if (probes === 1) return true;
          const error = Object.assign(new Error("process group is gone"), { code: "ESRCH" });
          throw error;
        }
        if (target === -pid && signal === "SIGKILL") return true;
        return true;
      });
      internal.containedPid = pid;

      await internal.verifyContainment();

      expect(kill).toHaveBeenNthCalledWith(1, -pid, 0);
      expect(kill).toHaveBeenNthCalledWith(2, -pid, "SIGKILL");
      expect(kill).toHaveBeenNthCalledWith(3, -pid, 0);
      expect(internal.containedPid).toBeUndefined();
      kill.mockRestore();
    }
  );

  it.runIf(process.platform !== "win32")(
    "treats a permission-denied POSIX process-group probe as still live until cleanup is verified",
    async () => {
      const transport = new ContainedStdioClientTransport({ command: process.execPath, args: [fixture] });
      const internal = transport as unknown as {
        containedPid: number | undefined;
        verifyContainment(): Promise<void>;
      };
      const pid = 41_044;
      let probes = 0;
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid && signal === 0) {
          probes += 1;
          const code = probes === 1 ? "EPERM" : "ESRCH";
          throw Object.assign(new Error(`process group probe ${code}`), { code });
        }
        if (target === -pid && signal === "SIGKILL") return true;
        return true;
      });
      internal.containedPid = pid;

      await internal.verifyContainment();

      expect(kill).toHaveBeenNthCalledWith(1, -pid, 0);
      expect(kill).toHaveBeenNthCalledWith(2, -pid, "SIGKILL");
      expect(kill).toHaveBeenNthCalledWith(3, -pid, 0);
      expect(internal.containedPid).toBeUndefined();
      kill.mockRestore();
    }
  );

  it.runIf(process.platform !== "win32")(
    "keeps polling after SIGKILL until a POSIX process group has exited",
    async () => {
      const transport = new ContainedStdioClientTransport({ command: process.execPath, args: [fixture] });
      const internal = transport as unknown as {
        containedPid: number | undefined;
        verifyContainment(): Promise<void>;
      };
      const pid = 41_045;
      let probes = 0;
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid && signal === 0) {
          probes += 1;
          if (probes < 4) return true;
          throw Object.assign(new Error("process group is gone"), { code: "ESRCH" });
        }
        if (target === -pid && signal === "SIGKILL") return true;
        return true;
      });
      internal.containedPid = pid;

      await internal.verifyContainment();

      expect(probes).toBe(4);
      expect(internal.containedPid).toBeUndefined();
      kill.mockRestore();
    }
  );

  it.runIf(process.platform !== "win32")(
    "does not wait indefinitely for a missing child close event once POSIX containment is verified",
    async () => {
      vi.useFakeTimers();
      const transport = new ContainedStdioClientTransport({ command: process.execPath, args: [fixture] });
      const internal = transport as unknown as {
        child: ChildProcess | undefined;
        containedPid: number | undefined;
        childClose: Promise<void> | undefined;
      };
      const pid = 41_046;
      const child = createFakeChild(pid);
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid && signal === "SIGKILL") return true;
        if (target === -pid && signal === 0) {
          throw Object.assign(new Error("process group is gone"), { code: "ESRCH" });
        }
        return true;
      });
      internal.child = child as unknown as ChildProcess;
      internal.containedPid = pid;
      internal.childClose = new Promise<void>(() => undefined);
      let result: "closed" | "failed" | undefined;
      transport.onclose = () => undefined;

      try {
        void transport.close().then(
          () => {
            result = "closed";
          },
          () => {
            result = "failed";
          }
        );
        // Two seconds cover graceful shutdown; the final second is the bounded
        // post-kill close confirmation window.
        await vi.advanceTimersByTimeAsync(3_000);
        await Promise.resolve();

        expect(result).toBe("closed");
        expect(transport.pid).toBeNull();
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it.runIf(process.platform !== "win32")("rejects a second start rather than spawning a second contained child", async () => {
    const transport = new ContainedStdioClientTransport({ command: process.execPath, args: [fixture] });
    try {
      await transport.start();
      expect(() => transport.start()).toThrow("already started");
    } finally {
      await transport.close().catch(() => undefined);
    }
  });
});
