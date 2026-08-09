import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { ContainedStdioClientTransport } from "../../src/upstream/contained-stdio-transport.js";
import { MultiUpstreamProcessManager } from "../../src/upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../../src/upstream/upstream-process-manager.js";
import { SecretRedactor } from "../../src/secrets/redact.js";
import { MiftahError } from "../../src/utils/errors.js";
import { startupDiagnosticFromError } from "../../src/upstream/startup-diagnostic.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-upstream.mjs");
const retainedStdioDescendantFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "retained-stdio-descendant.mjs"
);
const shutdownDelayFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "shutdown-delay-upstream.mjs"
);
const backToBackProgressFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "back-to-back-progress-upstream.mjs"
);

async function countStarts(path: string): Promise<number> {
  const contents = await readFile(path, "utf8");
  return contents.split("\n").filter(Boolean).length;
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
      throw new Error(`Timed out after ${timeoutMs}ms waiting for lifecycle state; last value: ${JSON.stringify(value)}`);
    }
    await delay(10);
    value = await read();
  }
  return value;
}

function terminateFixtureProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
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

/** Observes the public close callback without coupling the test to its private child handle. */
function observeTransportClose(transport: ContainedStdioClientTransport, onClose: () => void): void {
  const wrap = (callback: (() => void) | undefined): (() => void) | undefined =>
    callback === undefined
      ? undefined
      : () => {
          onClose();
          callback();
        };
  let delegate = wrap(transport.onclose);
  Object.defineProperty(transport, "onclose", {
    configurable: true,
    get: () => delegate,
    set: (callback: (() => void) | undefined) => {
      delegate = wrap(callback);
    }
  });
}

export type UpstreamManagerContractGroup = "basics" | "recovery" | "teardown";

export function registerUpstreamManagerContracts(group: UpstreamManagerContractGroup): void {
  if (group === "basics") return registerBasics();
  if (group === "recovery") return registerRecovery();
  if (group === "teardown") return registerTeardown();
}

function registerBasics(): void {
  describe("upstream process manager", () => {
  it.runIf(process.platform === "win32")("rejects a command shim before it can create a child process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-windows-command-shim-"));
    const markerPath = join(directory, "command-shim-ran");
    const commandShim = join(directory, "upstream.cmd");
    await writeFile(commandShim, `@echo off\r\necho command-shim-ran > "${markerPath}"\r\nexit /b 0\r\n`);
    const manager = new UpstreamProcessManager(
      { transport: "stdio", command: commandShim, args: [] },
      { work: {} },
      { startupTimeoutMs: 1_000 }
    );

    try {
      await expect(manager.get("work")).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      await manager.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves progress emitted immediately before an upstream response", async () => {
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [backToBackProgressFixture]
      },
      { work: {} },
      { startupTimeoutMs: 1_000 }
    );
    const progress: Array<{ progress: number; total?: number }> = [];

    try {
      const session = await manager.get("work");
      await session.listResourceTemplates(undefined, {
        onprogress: (update) => progress.push(update)
      });

      expect(progress).toEqual([{ progress: 1, total: 2 }]);
    } finally {
      await manager.close();
    }
  });

  it("isolates lifecycle listener failures from upstream state transitions", async () => {
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      {
        work: { env: { TEST_ACCOUNT_NAME: "work" } }
      },
      { startupTimeoutMs: 1_000 }
    );
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    manager.addLifecycleListener((event) => {
      if (event.type === "start") throw new Error("listener failure");
    });

    try {
      await expect(manager.get("work")).resolves.toMatchObject({ profile: "work" });
      expect(manager.listHealth()).toMatchObject([{ profile: "work", processState: "running" }]);
      expect(emitWarning).toHaveBeenCalledWith("MIFTAH_LISTENER_FAILED: ignored a failing lifecycle listener", {
        code: "MIFTAH_LISTENER_FAILED"
      });
    } finally {
      emitWarning.mockRestore();
      await manager.close().catch(() => undefined);
    }
  });

  it("isolates multi-upstream lifecycle listeners from each other's mutations", async () => {
    const manager = new MultiUpstreamProcessManager({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: { work: {} }
    });
    const received: Array<{ type: string; status: string }> = [];
    manager.addLifecycleListener((event) => {
      event.status = "failure";
    });
    manager.addLifecycleListener((event) => {
      received.push(event);
    });

    try {
      await manager.get("work", "github");
      expect(received).toEqual(expect.arrayContaining([expect.objectContaining({ type: "start", status: "success" })]));
    } finally {
      await manager.close();
    }
  });

  it("continues multi-upstream lifecycle delivery after a listener fails", async () => {
    const manager = new MultiUpstreamProcessManager({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: { work: {} }
    });
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const received: Array<{ type: string; status: string }> = [];
    manager.addLifecycleListener((event) => {
      if (event.type === "start") throw new Error("listener failure");
    });
    manager.addLifecycleListener((event) => {
      received.push(event);
    });

    try {
      await manager.get("work", "github");
      expect(received).toEqual(expect.arrayContaining([expect.objectContaining({ type: "start", status: "success" })]));
      expect(emitWarning).toHaveBeenCalledWith("MIFTAH_LISTENER_FAILED: ignored a failing lifecycle listener", {
        code: "MIFTAH_LISTENER_FAILED"
      });
    } finally {
      emitWarning.mockRestore();
      await manager.close();
    }
  });

  it("starts one cached upstream per profile and forwards MCP operations", async () => {
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      { startupTimeoutMs: 5_000 }
    );

    const work = await manager.get("work");
    expect((await work.listTools()).tools.map((tool) => tool.name)).toContain("whoami");
    expect(await work.callTool({ name: "whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "work" }]
    });
    expect(await manager.get("work")).toBe(work);
    expect(await (await manager.get("personal")).callTool({ name: "whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "personal" }]
    });

    await manager.close();
  });

  it("keeps the default startup timeout when an undefined option is supplied", async () => {
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      {
        work: { env: { TEST_ACCOUNT_NAME: "work" } }
      },
      { startupTimeoutMs: undefined }
    );

    try {
      expect((await (await manager.get("work")).listTools()).tools.map((tool) => tool.name)).toContain("whoami");
    } finally {
      await manager.close();
    }
  });

  it("redacts dynamically resolved secrets from manager stderr and capability diagnostics", async () => {
    const secret = "dynamic-profile-secret";
    const stderr: string[] = [];
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      {
        work: {
          env: {
            API_TOKEN: secret,
            TEST_STDERR_MESSAGE: `test stderr: ${secret}`,
            TEST_FAIL_LIST_TOOLS: "true"
          }
        }
      },
      {
        startupTimeoutMs: 1_000,
        onStderr: (_profile, message) => stderr.push(message)
      }
    );

    try {
      await manager.get("work");
      await waitFor(() => stderr.join("\n"), (output) => output.includes("test stderr"));
      expect(stderr.join("\n")).not.toContain(secret);
      expect(stderr.join("\n")).toContain("[REDACTED]");

      let failure: unknown;
      try {
        await manager.listTools("work");
      } catch (error) {
        failure = error;
      }
      if (!(failure instanceof MiftahError)) throw new Error("Expected a Miftah error from failed tool discovery");
      const cause = failure.details?.cause;
      if (typeof cause !== "string") throw new Error("Expected a redacted diagnostic cause");
      expect(cause).not.toContain(secret);
      expect(cause).toContain("[REDACTED]");
    } finally {
      await manager.close();
    }
  });

  it("shares dynamically resolved values with split stderr redaction", async () => {
    const secret = "split-stderr-secret";
    const message = `upstream stderr: ${secret}`;
    const stderr: string[] = [];
    const redactor = new SecretRedactor();
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      {
        work: {
          env: {
            API_TOKEN: secret,
            TEST_STDERR_MESSAGE: message,
            TEST_STDERR_SPLIT_AT: String(message.indexOf(secret) + 5)
          }
        }
      },
      {
        startupTimeoutMs: 1_000,
        redactor,
        onStderr: (_profile, output) => stderr.push(output)
      }
    );

    try {
      await manager.get("work");
      await waitFor(() => stderr.join(""), (output) => output.includes("[REDACTED]"));
      expect(stderr.join("")).not.toContain(secret);
      expect(redactor.redact({ secret })).toEqual({ secret: "[REDACTED]" });
    } finally {
      await manager.close();
    }
  });

  it("redacts dynamically resolved secrets from startup diagnostics", async () => {
    const secret = "dynamic-startup-secret";
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      {
        work: {
          env: {
            API_TOKEN: secret,
            TEST_FAIL_INITIALIZE: "true"
          }
        }
      },
      { startupTimeoutMs: 1_000 }
    );

    try {
      let failure: unknown;
      try {
        await manager.get("work");
      } catch (error) {
        failure = error;
      }
      if (!(failure instanceof MiftahError)) throw new Error("Expected a Miftah startup error");
      const cause = failure.details?.cause;
      if (typeof cause !== "string") throw new Error("Expected a redacted startup diagnostic cause");
      expect(cause).not.toContain(secret);
      expect(cause).toContain("[REDACTED]");
    } finally {
      await manager.close();
    }
  });

  it("captures a bounded redacted diagnostic when a child exits before initialization", async () => {
    const secret = "split-startup-diagnostic-secret";
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [
          "--eval",
          [
            "const secret = process.env.API_TOKEN;",
            "process.stderr.write('ModuleNotFoundError: missing safe dependency\\n');",
            "process.stderr.write(secret.slice(0, 7));",
            "setImmediate(() => {",
            "  process.stderr.write(secret.slice(7) + '\\n' + Array.from({ length: 300 }, () => 'x'.repeat(40)).join('\\n'));",
            "  process.exit(23);",
            "});"
          ].join("\n")
        ]
      },
      { work: { env: { API_TOKEN: secret } } },
      { startupTimeoutMs: 1_000 }
    );

    try {
      const failure = await manager.get("work").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MiftahError);
      expect(failure).toMatchObject({
        code: "UPSTREAM_INIT_FAILED",
        details: {
          startupDiagnostic: {
            kind: "process-exit",
            exitCode: 23,
            cause: expect.stringContaining("ModuleNotFoundError"),
            truncated: true,
            remediation: expect.stringContaining("upstream")
          }
        }
      });
      const serialized = JSON.stringify(failure);
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain(secret);
      const diagnostic = startupDiagnosticFromError(failure);
      if (diagnostic === undefined) throw new Error("Expected a safe startup diagnostic");
      expect(Buffer.byteLength(diagnostic.cause, "utf8")).toBeLessThanOrEqual(8_192);
    } finally {
      await manager.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "classifies a child signal during initialization in the startup diagnostic",
    async () => {
      const manager = new UpstreamProcessManager(
        {
          transport: "stdio",
          command: process.execPath,
          args: [
            "--eval",
            [
              "process.stderr.write('signal startup diagnostic\\n');",
              "setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10);"
            ].join("\n")
          ]
        },
        { work: {} },
        { startupTimeoutMs: 1_000 }
      );

      try {
        const failure = await manager.get("work").catch((error: unknown) => error);
        expect(failure).toMatchObject({
          code: "UPSTREAM_INIT_FAILED",
          details: {
            startupDiagnostic: {
              errorCode: "UPSTREAM_INIT_FAILED",
              kind: "signal",
              signal: "SIGTERM",
              cause: expect.stringContaining("signal startup diagnostic"),
              truncated: false,
              remediation: expect.stringContaining("upstream")
            }
          }
        });
      } finally {
        await manager.close();
      }
    }
  );

  it("shuts down an idle profile and starts a fresh process on its next use", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-idle-"));
    const startCountPath = join(directory, "starts");
    await writeFile(startCountPath, "");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { TEST_START_COUNT_PATH: startCountPath }
      },
      { work: {} },
      { startupTimeoutMs: 1_000, idleTimeoutMs: 50 }
    );

    try {
      await (await manager.get("work")).listTools();
      const stopped = await waitFor(
        () => manager.listHealth().find((health) => health.profile === "work"),
        (health) => health?.processState === "stopped" && health.lastStopReason === "idle"
      );
      if (!stopped) throw new Error("Expected idle shutdown health");
      expect(stopped.restartCount).toBe(0);
      expect(stopped.pid).toBeNull();
      expect(await countStarts(startCountPath)).toBe(1);

      await (await manager.get("work")).listTools();
      await waitFor(() => countStarts(startCountPath), (count) => count === 2);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a replacement session healthy and reserved while an idle predecessor is still closing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-idle-race-"));
    const shutdownEndPath = join(directory, "stdin-ended");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {
          TEST_SHUTDOWN_DELAY_MS: "500",
          TEST_SHUTDOWN_END_PATH: shutdownEndPath,
          TEST_LIST_TOOLS_DELAY_MS: "800"
        }
      },
      { work: {}, personal: {} },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000, idleTimeoutMs: 30, maxConcurrentProfiles: 1 }
    );

    try {
      await manager.get("work");
      await waitFor(() => existsSync(shutdownEndPath), Boolean);

      const replacement = await manager.get("work");
      const inFlightList = replacement.listTools();
      await delay(600);

      expect(manager.listHealth()).toMatchObject([{ profile: "work", processState: "running" }]);
      await expect(manager.get("personal")).rejects.toMatchObject({ code: "UPSTREAM_CONCURRENCY_LIMIT" });
      await expect(inFlightList).resolves.toMatchObject({ tools: expect.any(Array) });
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not idle-shutdown a profile while an upstream request is in flight", async () => {
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { TEST_LIST_TOOLS_DELAY_MS: "125" }
      },
      { work: {} },
      { startupTimeoutMs: 1_000, idleTimeoutMs: 30 }
    );

    try {
      const session = await manager.get("work");
      await expect(session.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
      expect(manager.listHealth()).toMatchObject([{ profile: "work", processState: "running" }]);
      await waitFor(
        () => manager.listHealth().find((health) => health.profile === "work"),
        (health) => health?.processState === "stopped" && health.lastStopReason === "idle"
      );
    } finally {
      await manager.close();
    }
  });

  });
}

function registerRecovery(): void {
  describe("upstream process manager", () => {
  it("does not restart a crashed process unless automatic recovery is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-no-restart-"));
    const crashPath = join(directory, "crash");
    const startCountPath = join(directory, "starts");
    await writeFile(startCountPath, "");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {
          TEST_CRASH_ON_CALL_TOOL_PATH: crashPath,
          TEST_START_COUNT_PATH: startCountPath
        }
      },
      { work: {} },
      { startupTimeoutMs: 1_000, restartOnCrash: false }
    );

    try {
      const session = await manager.get("work");
      await writeFile(crashPath, "crash");
      await expect(session.callTool({ name: "whoami", arguments: {} })).rejects.toThrow();
      await waitFor(
        () => manager.listHealth().find((health) => health.profile === "work"),
        (health) => health?.processState === "failed"
      );
      await delay(300);
      expect(await countStarts(startCountPath)).toBe(1);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("single-flights concurrent starts and management restarts for the same profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-single-flight-"));
    const startCountPath = join(directory, "starts");
    const restartBlockPath = join(directory, "restart-block");
    const restartReadyPath = join(directory, "restart-ready");
    const restartReleasePath = join(directory, "restart-release");
    await writeFile(startCountPath, "");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {
          TEST_START_COUNT_PATH: startCountPath,
          TEST_BLOCK_ON_RESTART_PATH: restartBlockPath,
          TEST_BLOCK_ON_RESTART_READY_PATH: restartReadyPath,
          TEST_BLOCK_ON_RESTART_RELEASE_PATH: restartReleasePath
        }
      },
      { work: {} },
      { startupTimeoutMs: 1_000 }
    );

    try {
      const initial = await Promise.all([manager.get("work"), manager.get("work"), manager.get("work")]);
      expect(initial[0]).toBe(initial[1]);
      expect(initial[1]).toBe(initial[2]);
      expect(await countStarts(startCountPath)).toBe(1);

      const firstRestart = manager.restart("work");
      const secondRestart = manager.restart("work");
      await waitFor(() => existsSync(restartReadyPath), Boolean);
      const joinedRestart = manager.get("work");
      await writeFile(restartReleasePath, "release");
      const [first, second, joined] = await Promise.all([firstRestart, secondRestart, joinedRestart]);

      expect(first).toBe(second);
      expect(second).toBe(joined);
      expect(await countStarts(startCountPath)).toBe(2);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("automatically recovers a crashed profile after a bounded backoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-auto-restart-"));
    const crashPath = join(directory, "crash");
    const recoveryCrashObservedPath = join(directory, "recovery-crash-observed");
    const restartGatePath = join(directory, "restart-gate");
    const restartReadyPath = join(directory, "restart-ready");
    const startCountPath = join(directory, "starts");
    await writeFile(startCountPath, "");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {
          TEST_CRASH_ON_CALL_TOOL_PATH: crashPath,
          TEST_CRASH_ON_CALL_TOOL_OBSERVED_PATH: recoveryCrashObservedPath,
          TEST_HANG_ON_START_PATH: restartGatePath,
          TEST_HANG_ON_START_READY_PATH: restartReadyPath,
          TEST_START_COUNT_PATH: startCountPath
        }
      },
      { work: {} },
      { startupTimeoutMs: 5_000, restartOnCrash: true, maxRestarts: 2 }
    );

    try {
      const session = await manager.get("work");
      await Promise.all([writeFile(crashPath, "crash"), writeFile(restartGatePath, "restart")]);
      await expect(session.callTool({ name: "whoami", arguments: {} })).rejects.toThrow();
      expect(existsSync(recoveryCrashObservedPath)).toBe(false);
      await waitFor(() => countStarts(startCountPath), (count) => count === 2);
      await waitFor(() => existsSync(restartReadyPath), Boolean);
      await unlink(crashPath);
      await unlink(restartGatePath);

      const recovered = await waitFor(
        () => manager.listHealth().find((health) => health.profile === "work"),
        (health) => health?.processState === "running"
      );
      if (!recovered) throw new Error("Expected recovered health");
      expect(recovered.restartCount).toBe(1);
      expect(existsSync(recoveryCrashObservedPath)).toBe(false);
      await expect((await manager.get("work")).callTool({ name: "whoami", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "unknown" }]
      });
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reaps a retained stdio descendant before recovering from an unexpected parent exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-crashed-stdio-descendant-"));
    const crashPath = join(directory, "crash");
    const descendantPidPath = join(directory, "descendant-pid");
    const restartGatePath = join(directory, "restart-gate");
    const restartReadyPath = join(directory, "restart-ready");
    const startCountPath = join(directory, "starts");
    let descendantPid: number | undefined;
    await writeFile(startCountPath, "");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [retainedStdioDescendantFixture],
        env: {
          TEST_CRASH_ON_CALL_TOOL_PATH: crashPath,
          TEST_RETAINED_STDIO_DESCENDANT_PID_PATH: descendantPidPath,
          TEST_HANG_ON_START_PATH: restartGatePath,
          TEST_HANG_ON_START_READY_PATH: restartReadyPath,
          TEST_START_COUNT_PATH: startCountPath
        }
      },
      { work: {} },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000, restartOnCrash: true, maxRestarts: 1 }
    );

    try {
      const session = await manager.get("work");
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      const crashedDescendantPid = descendantPid;
      expect(Number.isSafeInteger(crashedDescendantPid)).toBe(true);

      await Promise.all([writeFile(crashPath, "crash"), writeFile(restartGatePath, "restart")]);
      await expect(session.callTool({ name: "whoami", arguments: {} })).rejects.toThrow();

      await waitFor(
        () => fixtureProcessIsAlive(crashedDescendantPid),
        (alive) => alive === false,
        1_000
      );
      await waitFor(() => countStarts(startCountPath), (starts) => starts === 2);
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      await waitFor(() => existsSync(restartReadyPath), Boolean);
      await Promise.all([unlink(crashPath), unlink(restartGatePath)]);
      await expect((await manager.get("work")).callTool({ name: "whoami", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "unknown" }]
      });
    } finally {
      if (descendantPid !== undefined && fixtureProcessIsAlive(descendantPid)) {
        terminateFixtureProcess(descendantPid);
      }
      await manager.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops automatic recovery when the configured restart budget is exhausted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-restart-limit-"));
    const crashPath = join(directory, "crash");
    const startCountPath = join(directory, "starts");
    await Promise.all([writeFile(crashPath, "crash"), writeFile(startCountPath, "")]);
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {
          TEST_CRASH_AFTER_INITIALIZED_PATH: crashPath,
          TEST_START_COUNT_PATH: startCountPath
        }
      },
      { work: {} },
      { startupTimeoutMs: 1_000, restartOnCrash: true, maxRestarts: 2 }
    );

    try {
      await manager.get("work");
      const exhausted = await waitFor(
        () => manager.listHealth().find((health) => health.profile === "work"),
        (health) => health?.restartLimitReached === true
      );
      expect(exhausted).toMatchObject({
        processState: "failed",
        restartCount: 2,
        error: expect.stringContaining("UPSTREAM_RESTART_LIMIT_EXCEEDED")
      });
      expect(await countStarts(startCountPath)).toBe(3);
      await expect(manager.get("work")).rejects.toMatchObject({ code: "UPSTREAM_RESTART_LIMIT_EXCEEDED" });
      await unlink(crashPath);
      const manuallyRestarted = await manager.restart("work");
      await expect(manuallyRestarted.callTool({ name: "whoami", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "unknown" }]
      });
      expect(manager.listHealth()).toMatchObject([{ profile: "work", restartCount: 2, processState: "running" }]);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds a hung startup and cleans up its child process", async () => {
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      { work: { env: { TEST_HANG_ON_START: "true" } } },
      { startupTimeoutMs: 200 }
    );
    const startedAt = Date.now();

    try {
      const startup = manager.get("work");
      void startup.catch(() => undefined);
      await expect(startup).rejects.toMatchObject({
        code: "UPSTREAM_START_FAILED",
        details: {
          startupDiagnostic: {
            errorCode: "UPSTREAM_START_FAILED",
            kind: "timeout",
            cause: expect.stringContaining("startup timed out after 200ms"),
            truncated: false,
            remediation: expect.stringContaining("upstream")
          }
        }
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(manager.listHealth()).toMatchObject([{ profile: "work", processState: "failed" }]);
    } finally {
      await manager.close();
    }
  });

  it("does not spawn a child after manager shutdown wins during pre-transport startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-close-before-transport-"));
    const startCountPath = join(directory, "starts");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { TEST_START_COUNT_PATH: startCountPath }
      },
      { work: {} },
      { startupTimeoutMs: 1_000 }
    );

    try {
      const startup = manager.get("work");
      const closing = manager.close();

      await expect(closing).resolves.toBeUndefined();
      await expect(startup).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      await expect(readFile(startCountPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases a profile capacity reservation after a failed startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-failed-start-capacity-"));
    const failurePath = join(directory, "fail");
    const crashObservedPath = join(directory, "crash-observed");
    await writeFile(failurePath, "fail");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      {
        work: {
          env: {
            TEST_CRASH_ON_CALL_TOOL_PATH: failurePath,
            TEST_CRASH_ON_CALL_TOOL_OBSERVED_PATH: crashObservedPath
          }
        },
        personal: {}
      },
      { startupTimeoutMs: 1_000, maxConcurrentProfiles: 1 }
    );

    try {
      await expect(manager.get("work")).rejects.toMatchObject({ code: "UPSTREAM_INIT_FAILED" });
      expect(existsSync(crashObservedPath)).toBe(true);
      await expect((await manager.get("personal")).listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels a hanging startup when the manager shuts down", async () => {
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { TEST_HANG_ON_START: "true" }
      },
      { work: {} },
      { startupTimeoutMs: 10_000 }
    );

    const startup = manager.get("work");
    // Shutdown can now contain the child before this test reaches its final
    // assertion; observe the rejection immediately to avoid a test-runner
    // unhandled-rejection race while still asserting the original promise.
    void startup.catch(() => undefined);
    await delay(50);
    const startedAt = Date.now();
    await manager.close();

    expect(Date.now() - startedAt).toBeLessThan(300);
    await expect(startup).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
  });

  it("restarts after cancelling an in-flight startup without reusing the cancelled attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-restart-startup-"));
    const hangPath = join(directory, "hang");
    const hangReadyPath = join(directory, "hang-ready");
    const startCountPath = join(directory, "starts");
    await Promise.all([writeFile(hangPath, "hang"), writeFile(startCountPath, "")]);
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {
          TEST_HANG_ON_START_PATH: hangPath,
          TEST_HANG_ON_START_READY_PATH: hangReadyPath,
          TEST_START_COUNT_PATH: startCountPath
        }
      },
      { work: {} },
      { startupTimeoutMs: 10_000 }
    );

    try {
      const initialStartup = manager.get("work");
      void initialStartup.catch(() => undefined);
      await waitFor(() => existsSync(hangReadyPath), Boolean);
      await unlink(hangPath);

      const restarted = await manager.restart("work");
      await expect(restarted.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
      await expect(initialStartup).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
      expect(await countStarts(startCountPath)).toBe(2);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  });
}

function registerTeardown(): void {
  describe("upstream process manager", () => {
  it("forces a delayed shutdown to respect the configured timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-shutdown-"));
    const shutdownEndPath = join(directory, "stdin-ended");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [shutdownDelayFixture],
        env: {
          TEST_SHUTDOWN_DELAY_MS: "500",
          TEST_SHUTDOWN_END_PATH: shutdownEndPath
        }
      },
      { work: {} },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 50 }
    );

    try {
      await manager.get("work");
      const startedAt = Date.now();
      await manager.close();
      expect(Date.now() - startedAt).toBeLessThan(300);
      await expect(readFile(shutdownEndPath, "utf8")).resolves.toBe("ended");
      expect(manager.listHealth()).toMatchObject([
        { profile: "work", processState: "stopped", lastStopReason: "shutdown-timeout" }
      ]);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for a forcibly terminated stdio child before starting its replacement", async () => {
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { TEST_SHUTDOWN_DELAY_MS: "1000" }
      },
      { work: {} },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 25 }
    );
    const originalStart = ContainedStdioClientTransport.prototype.start;
    let firstTransportStarted = false;
    let firstChildClosed = false;
    let replacementStartedBeforeFirstChildClosed = false;
    const start = vi.spyOn(ContainedStdioClientTransport.prototype, "start").mockImplementation(async function (
      this: ContainedStdioClientTransport
    ) {
      if (firstTransportStarted) {
        replacementStartedBeforeFirstChildClosed ||= !firstChildClosed;
      }
      await originalStart.call(this);
      if (firstTransportStarted) return;

      if (this.pid === null) throw new Error("Expected stdio transport to expose its child PID after start.");
      firstTransportStarted = true;
      observeTransportClose(this, () => {
        firstChildClosed = true;
      });
    });

    try {
      await manager.get("work");
      await manager.restart("work");

      expect(replacementStartedBeforeFirstChildClosed).toBe(false);
    } finally {
      start.mockRestore();
      await manager.close().catch(() => undefined);
    }
  });

  it("reaps forced stdio descendants before starting a replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-retained-stdio-descendant-"));
    const descendantPidPath = join(directory, "descendant-pid");
    const startCountPath = join(directory, "starts");
    let descendantPid: number | undefined;
    let firstDescendantPid: number | undefined;
    const originalStart = ContainedStdioClientTransport.prototype.start;
    let firstTransportStarted = false;
    let replacementTransportStarted = false;
    let replacementStartedBeforeFirstDescendantReaped = false;
    const start = vi.spyOn(ContainedStdioClientTransport.prototype, "start").mockImplementation(async function (
      this: ContainedStdioClientTransport
    ) {
      if (firstTransportStarted) {
        replacementTransportStarted = true;
        if (firstDescendantPid !== undefined && fixtureProcessIsAlive(firstDescendantPid)) {
          replacementStartedBeforeFirstDescendantReaped = true;
        }
      }
      await originalStart.call(this);
      firstTransportStarted = true;
    });
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [retainedStdioDescendantFixture],
        env: {
          TEST_RETAINED_STDIO_DESCENDANT_PID_PATH: descendantPidPath,
          TEST_START_COUNT_PATH: startCountPath,
          TEST_SHUTDOWN_DELAY_MS: "1000"
        }
      },
      { work: {} },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 25 }
    );

    try {
      await manager.get("work");
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      firstDescendantPid = descendantPid;
      expect(Number.isSafeInteger(firstDescendantPid)).toBe(true);
      if (firstDescendantPid === undefined) throw new Error("Expected first retained descendant PID");
      const recordedFirstDescendantPid = firstDescendantPid;

      // The test runs under full V8 coverage alongside the rest of the suite,
      // so the replacement's MCP initialization speed is intentionally not
      // part of the containment contract. Observe the spawned transport
      // boundary instead: a replacement must never begin while the old
      // descendant remains alive.
      const restarting = manager.restart("work");
      void restarting.catch(() => undefined);
      await waitFor(() => replacementTransportStarted, Boolean);
      await waitFor(
        () => fixtureProcessIsAlive(recordedFirstDescendantPid),
        (alive) => alive === false
      );
      expect(replacementStartedBeforeFirstDescendantReaped).toBe(false);
      await expect(restarting).resolves.toBeDefined();
    } finally {
      if (descendantPid !== undefined) {
        terminateFixtureProcess(descendantPid);
      }
      await manager.close().catch(() => undefined);
      start.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reaps retained stdio descendants before manager shutdown resolves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-close-stdio-descendant-"));
    const descendantPidPath = join(directory, "descendant-pid");
    let descendantPid: number | undefined;
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [retainedStdioDescendantFixture],
        env: {
          TEST_RETAINED_STDIO_DESCENDANT_PID_PATH: descendantPidPath,
          TEST_SHUTDOWN_DELAY_MS: "10000"
        }
      },
      { work: {} },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000 }
    );

    try {
      await manager.get("work");
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      const recordedDescendantPid = descendantPid;
      expect(Number.isSafeInteger(recordedDescendantPid)).toBe(true);

      await manager.close();

      await waitFor(
        () => fixtureProcessIsAlive(recordedDescendantPid),
        (alive) => alive === false,
        1_000
      );
    } finally {
      if (descendantPid !== undefined && fixtureProcessIsAlive(descendantPid)) {
        terminateFixtureProcess(descendantPid);
      }
      await manager.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a profile teardown gate until delayed contained cleanup confirms close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-delayed-contained-cleanup-"));
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const originalClose = ContainedStdioClientTransport.prototype.close;
    const close = vi.spyOn(ContainedStdioClientTransport.prototype, "close").mockImplementation(function (
      this: ContainedStdioClientTransport
    ) {
      return closeGate.then(() => originalClose.call(this));
    });
    const forceTerminate = vi.spyOn(ContainedStdioClientTransport.prototype, "forceTerminate").mockResolvedValue();
    const manager = new UpstreamProcessManager(
      { transport: "stdio", command: process.execPath, args: [fixture] },
      { work: {}, personal: {} },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 25, maxConcurrentProfiles: 1 }
    );

    try {
      await manager.get("work");

      await expect(manager.restart("work")).rejects.toMatchObject({ code: "UPSTREAM_SHUTDOWN_TIMEOUT" });
      await expect(manager.get("work")).rejects.toMatchObject({ code: "UPSTREAM_SHUTDOWN_TIMEOUT" });
      await expect(manager.get("personal")).rejects.toMatchObject({ code: "UPSTREAM_CONCURRENCY_LIMIT" });

      releaseClose();
      await waitFor(
        () => manager.listHealth().find((health) => health.profile === "work")?.processState,
        (state) => state === "stopped"
      );
      await expect(manager.get("personal")).resolves.toBeDefined();
    } finally {
      releaseClose();
      await manager.close().catch(() => undefined);
      forceTerminate.mockRestore();
      close.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases a deferred contained teardown at its verified public close boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-contained-close-boundary-"));
    const descendantPidPath = join(directory, "descendant-pid");
    const personalStartCountPath = join(directory, "personal-starts");
    const originalStart = ContainedStdioClientTransport.prototype.start;
    const originalForceTerminate = ContainedStdioClientTransport.prototype.forceTerminate;
    let descendantPid: number | undefined;
    let releaseForce!: () => void;
    let resolveForceRequested!: () => void;
    let resolveContainedClose!: () => void;
    const forceGate = new Promise<void>((resolve) => {
      releaseForce = resolve;
    });
    const forceRequested = new Promise<void>((resolve) => {
      resolveForceRequested = resolve;
    });
    const containedClose = new Promise<void>((resolve) => {
      resolveContainedClose = resolve;
    });
    let observedFirstTransport = false;
    const start = vi.spyOn(ContainedStdioClientTransport.prototype, "start").mockImplementation(async function (
      this: ContainedStdioClientTransport
    ) {
      await originalStart.call(this);
      if (observedFirstTransport) return;
      observedFirstTransport = true;
      observeTransportClose(this, resolveContainedClose);
    });
    const forceTerminate = vi.spyOn(ContainedStdioClientTransport.prototype, "forceTerminate").mockImplementation(function (
      this: ContainedStdioClientTransport
    ) {
      resolveForceRequested();
      return forceGate.then(() => originalForceTerminate.call(this));
    });
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [retainedStdioDescendantFixture],
        env: { TEST_SHUTDOWN_DELAY_MS: "1000" }
      },
      {
        work: { env: { TEST_RETAINED_STDIO_DESCENDANT_PID_PATH: descendantPidPath } },
        personal: { args: [fixture], env: { TEST_START_COUNT_PATH: personalStartCountPath } }
      },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 25, maxConcurrentProfiles: 1 }
    );

    try {
      await manager.get("work");
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      expect(Number.isSafeInteger(descendantPid)).toBe(true);

      const closing = manager.closeProfile("work");
      await forceRequested;
      await closing;
      releaseForce();
      await containedClose;
      descendantPid = undefined;

      await expect(manager.get("personal")).resolves.toBeDefined();
      expect(await countStarts(personalStartCountPath)).toBe(1);
    } finally {
      releaseForce();
      if (descendantPid !== undefined && fixtureProcessIsAlive(descendantPid)) {
        terminateFixtureProcess(descendantPid);
      }
      await manager.close().catch(() => undefined);
      forceTerminate.mockRestore();
      start.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases profile capacity when a second close follows contained stdio cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-pending-stdio-capacity-"));
    const descendantPidPath = join(directory, "descendant-pid");
    const workStartCountPath = join(directory, "work-starts");
    const personalStartCountPath = join(directory, "personal-starts");
    let descendantPid: number | undefined;
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [retainedStdioDescendantFixture],
        env: { TEST_SHUTDOWN_DELAY_MS: "1000" }
      },
      {
        work: {
          env: {
            TEST_RETAINED_STDIO_DESCENDANT_PID_PATH: descendantPidPath,
            TEST_START_COUNT_PATH: workStartCountPath
          }
        },
        personal: {
          args: [fixture],
          env: { TEST_START_COUNT_PATH: personalStartCountPath }
        }
      },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 25, maxConcurrentProfiles: 1 }
    );

    try {
      await manager.get("work");
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      const firstDescendantPid = descendantPid;
      expect(Number.isSafeInteger(firstDescendantPid)).toBe(true);

      await expect(manager.restart("work")).resolves.toBeDefined();
      await waitFor(
        () => fixtureProcessIsAlive(firstDescendantPid),
        (alive) => alive === false
      );
      expect(await countStarts(workStartCountPath)).toBe(2);
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      const replacementDescendantPid = descendantPid;
      expect(Number.isSafeInteger(replacementDescendantPid)).toBe(true);

      await manager.closeProfile("work");
      await waitFor(
        () => fixtureProcessIsAlive(replacementDescendantPid),
        (alive) => alive === false
      );
      descendantPid = undefined;

      await expect(manager.get("personal")).resolves.toBeDefined();
      expect(await countStarts(personalStartCountPath)).toBe(1);
    } finally {
      if (descendantPid !== undefined) {
        terminateFixtureProcess(descendantPid);
      }
      await manager.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps profile capacity and containment during a concurrent stdio close and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-racing-stdio-capacity-"));
    const descendantPidPath = join(directory, "descendant-pid");
    const workStartCountPath = join(directory, "work-starts");
    const personalStartCountPath = join(directory, "personal-starts");
    let descendantPid: number | undefined;
    let closeStarted = false;
    const originalClose = ContainedStdioClientTransport.prototype.close;
    const close = vi.spyOn(ContainedStdioClientTransport.prototype, "close").mockImplementation(async function (
      this: ContainedStdioClientTransport
    ) {
      closeStarted = true;
      await originalClose.call(this);
    });
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [retainedStdioDescendantFixture],
        env: { TEST_SHUTDOWN_DELAY_MS: "1000" }
      },
      {
        work: {
          env: {
            TEST_RETAINED_STDIO_DESCENDANT_PID_PATH: descendantPidPath,
            TEST_START_COUNT_PATH: workStartCountPath
          }
        },
        personal: {
          args: [fixture],
          env: { TEST_START_COUNT_PATH: personalStartCountPath }
        }
      },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 25, maxConcurrentProfiles: 1 }
    );

    try {
      await manager.get("work");
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      const firstDescendantPid = descendantPid;
      expect(Number.isSafeInteger(firstDescendantPid)).toBe(true);

      const restarting = manager.restart("work");
      await waitFor(() => closeStarted, Boolean);
      await manager.closeProfile("work");
      await expect(restarting).resolves.toBeDefined();
      await waitFor(
        () => fixtureProcessIsAlive(firstDescendantPid),
        (alive) => alive === false
      );
      expect(await countStarts(workStartCountPath)).toBe(2);
      await expect(manager.get("personal")).rejects.toMatchObject({ code: "UPSTREAM_CONCURRENCY_LIMIT" });

      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      const replacementDescendantPid = descendantPid;
      expect(Number.isSafeInteger(replacementDescendantPid)).toBe(true);
      await manager.closeProfile("work");
      await waitFor(
        () => fixtureProcessIsAlive(replacementDescendantPid),
        (alive) => alive === false
      );
      descendantPid = undefined;

      await expect(manager.get("personal")).resolves.toBeDefined();
      expect(await countStarts(personalStartCountPath)).toBe(1);
    } finally {
      close.mockRestore();
      if (descendantPid !== undefined) {
        terminateFixtureProcess(descendantPid);
      }
      await manager.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reaps descendants before releasing capacity when automatic recovery is exhausted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-auto-pending-stdio-capacity-"));
    const crashPath = join(directory, "crash");
    const failOnRestartPath = join(directory, "fail-on-restart");
    const retainDescendantPath = join(directory, "retain-descendant");
    const descendantPidPath = join(directory, "descendant-pid");
    const workStartCountPath = join(directory, "work-starts");
    const personalStartCountPath = join(directory, "personal-starts");
    let descendantPid: number | undefined;
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [retainedStdioDescendantFixture],
        env: {
          TEST_CRASH_ON_CALL_TOOL_PATH: crashPath,
          TEST_FAIL_ON_RESTART_PATH: failOnRestartPath,
          TEST_RETAIN_STDIO_DESCENDANT_PATH: retainDescendantPath,
          TEST_RETAINED_STDIO_DESCENDANT_PID_PATH: descendantPidPath,
          TEST_START_COUNT_PATH: workStartCountPath
        }
      },
      {
        work: {},
        personal: {
          args: [fixture],
          env: {
            TEST_CRASH_ON_CALL_TOOL_PATH: "",
            TEST_FAIL_ON_RESTART_PATH: "",
            TEST_START_COUNT_PATH: personalStartCountPath
          }
        }
      },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 25, restartOnCrash: true, maxRestarts: 1, maxConcurrentProfiles: 1 }
    );

    try {
      const work = await manager.get("work");
      await Promise.all([writeFile(crashPath, "crash"), writeFile(retainDescendantPath, "retain")]);
      await expect(work.callTool({ name: "whoami", arguments: {} })).rejects.toThrow();

      await waitFor(
        () => manager.listHealth().find((health) => health.profile === "work"),
        (health) => health?.restartLimitReached === true
      );
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      const retainedDescendantPid = descendantPid;
      expect(Number.isSafeInteger(retainedDescendantPid)).toBe(true);
      expect(await countStarts(workStartCountPath)).toBe(2);
      await waitFor(
        () => fixtureProcessIsAlive(retainedDescendantPid),
        (alive) => alive === false
      );
      descendantPid = undefined;

      await expect(manager.get("personal")).resolves.toBeDefined();
      expect(await countStarts(personalStartCountPath)).toBe(1);
    } finally {
      if (descendantPid !== undefined) {
        terminateFixtureProcess(descendantPid);
      }
      await manager.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records a failed restart teardown before starting a replacement session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-failed-restart-replacement-"));
    const startCountPath = join(directory, "upstream-start-count");
    const initializedPath = join(directory, "upstream-initialized");
    await writeFile(startCountPath, "");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: { TEST_SHUTDOWN_DELAY_MS: "500" }
      },
      { work: { env: { TEST_START_COUNT_PATH: startCountPath, TEST_INITIALIZED_PATH: initializedPath } } },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 50 }
    );
    const events: Array<{ type: string; status: string; errorCode?: string }> = [];
    manager.addLifecycleListener((event) => events.push(event));

    try {
      await manager.get("work");
      const startsBeforeRestart = await countStarts(startCountPath);
      await waitFor(() => existsSync(initializedPath), Boolean);
      await unlink(initializedPath);
      try {
        await manager.restart("work");
      } catch (error) {
        const starts = await countStarts(startCountPath);
        const health = manager.listHealth().map((entry) => ({
          profile: entry.profile,
          upstreamName: entry.upstreamName,
          state: entry.state,
          processState: entry.processState,
          restartCount: entry.restartCount,
          lastStopReason: entry.lastStopReason,
          restartLimitReached: entry.restartLimitReached,
          capabilities: Object.fromEntries(
            Object.entries(entry.capabilities).map(([capability, capabilityHealth]) => [capability, capabilityHealth.state])
          )
        }));
        throw new Error(
          `Failed-restart replacement startup diagnostic: ${JSON.stringify({
            errorCode: error instanceof MiftahError ? error.code : "unknown",
            startDelta: starts - startsBeforeRestart,
            initialized: existsSync(initializedPath),
            health
          })}`,
          { cause: error }
        );
      }
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "restart-failure",
            status: "failure",
            errorCode: "UPSTREAM_SHUTDOWN_TIMEOUT"
          }),
          expect.objectContaining({ type: "restart", status: "success" })
        ])
      );
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases capacity after a session close rejects", async () => {
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      { work: {}, personal: {} },
      { startupTimeoutMs: 1_000, maxConcurrentProfiles: 1 }
    );

    try {
      const work = await manager.get("work");
      vi.spyOn(work, "close").mockRejectedValueOnce(new Error("simulated close failure"));

      await expect(manager.closeProfile("work")).resolves.toBeUndefined();
      expect(manager.listHealth()).toMatchObject([
        { profile: "work", processState: "stopped", lastStopReason: "shutdown-error" }
      ]);
      await expect(manager.get("personal")).resolves.toBeDefined();
    } finally {
      await manager.close();
    }
  });

  it("finalizes a timed-out close without waiting for its original promise", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-timed-close-replacement-"));
    const startCountPath = join(directory, "upstream-start-count");
    const initializedPath = join(directory, "upstream-initialized");
    await writeFile(startCountPath, "");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      {
        work: { env: { TEST_START_COUNT_PATH: startCountPath, TEST_INITIALIZED_PATH: initializedPath } },
        personal: { env: { TEST_START_COUNT_PATH: startCountPath, TEST_INITIALIZED_PATH: initializedPath } }
      },
      { startupTimeoutMs: 1_000, shutdownTimeoutMs: 25, maxConcurrentProfiles: 1 }
    );

    try {
      const work = await manager.get("work");
      vi.spyOn(work, "close").mockImplementation(() => new Promise<void>(() => undefined));

      const completion = await Promise.race([
        manager.closeProfile("work").then(() => "closed"),
        delay(500).then(() => "timed-out")
      ]);
      expect(completion).toBe("closed");
      expect(manager.listHealth()).toMatchObject([
        { profile: "work", processState: "stopped", lastStopReason: "shutdown-timeout" }
      ]);
      const startsBeforeReplacement = await countStarts(startCountPath);
      await writeFile(initializedPath, "before-replacement");
      try {
        await manager.get("personal");
      } catch {
        const [starts, initialized] = await Promise.all([
          countStarts(startCountPath),
          readFile(initializedPath, "utf8")
        ]);
        const health = manager.listHealth().map((entry) => ({
          profile: entry.profile,
          upstreamName: entry.upstreamName,
          state: entry.state,
          processState: entry.processState,
          restartCount: entry.restartCount,
          lastStopReason: entry.lastStopReason,
          restartLimitReached: entry.restartLimitReached,
          capabilities: Object.fromEntries(
            Object.entries(entry.capabilities).map(([capability, capabilityHealth]) => [capability, capabilityHealth.state])
          )
        }));
        throw new Error(
          `Timed-out close replacement startup failed: ${JSON.stringify({
            startDelta: starts - startsBeforeReplacement,
            initialized,
            health
          })}`
        );
      }
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("limits a multi-upstream bundle by distinct active profiles without evicting a live session", async () => {
    const manager = new MultiUpstreamProcessManager(
      {
        version: "1",
        name: "multi",
        defaultProfile: "work",
        upstreams: {
          primary: { transport: "stdio", command: process.execPath, args: [fixture] },
          secondary: { transport: "stdio", command: process.execPath, args: [fixture] }
        },
        profiles: { work: {}, personal: {} }
      },
      { startupTimeoutMs: 1_000, maxConcurrentProfiles: 1 }
    );

    try {
      await manager.get("work", "primary");
      await manager.get("work", "secondary");
      await expect(manager.get("personal", "primary")).rejects.toMatchObject({ code: "UPSTREAM_CONCURRENCY_LIMIT" });
      expect(manager.listHealth()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ profile: "work", upstreamName: "primary", processState: "running" }),
          expect.objectContaining({ profile: "work", upstreamName: "secondary", processState: "running" })
        ])
      );
    } finally {
      await manager.close();
    }
  });

  it("cancels pending automatic recovery when the manager shuts down", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-restart-cleanup-"));
    const crashPath = join(directory, "crash");
    const startCountPath = join(directory, "starts");
    await Promise.all([writeFile(crashPath, "crash"), writeFile(startCountPath, "")]);
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
        env: {
          TEST_CRASH_AFTER_INITIALIZED_PATH: crashPath,
          TEST_START_COUNT_PATH: startCountPath
        }
      },
      { work: {} },
      { startupTimeoutMs: 1_000, restartOnCrash: true, maxRestarts: 3 }
    );

    try {
      await manager.get("work");
      await waitFor(
        () => manager.listHealth().find((health) => health.profile === "work"),
        (health) => health?.processState === "failed"
      );
      await manager.close();
      await delay(300);
      expect(await countStarts(startCountPath)).toBe(1);
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  });
}
