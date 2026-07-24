import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { MultiUpstreamProcessManager } from "../src/upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";
import { SecretRedactor } from "../src/secrets/redact.js";
import { MiftahError } from "../src/utils/errors.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");
const backToBackProgressFixture = join(
  dirname(fileURLToPath(import.meta.url)),
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

describe("upstream process manager", () => {
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
      await expect(startup).rejects.toMatchObject({ code: "UPSTREAM_START_FAILED" });
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

  it("forces a delayed shutdown to respect the configured timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-shutdown-"));
    const shutdownEndPath = join(directory, "stdin-ended");
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
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
