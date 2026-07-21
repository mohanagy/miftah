import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedWindowsSecretCommand } from "../src/secrets/windows-secret-command.js";

const windowsSecretCommandMocks = vi.hoisted(() => ({
  resolveWindowsSecretCommand: vi.fn<() => Promise<ResolvedWindowsSecretCommand | undefined>>(),
  spawnWindowsSecretCommand: vi.fn()
}));

vi.mock("../src/secrets/windows-secret-command.js", () => ({
  resolveWindowsSecretCommand: windowsSecretCommandMocks.resolveWindowsSecretCommand,
  spawnWindowsSecretCommand: windowsSecretCommandMocks.spawnWindowsSecretCommand
}));

import { runSecretCommand } from "../src/secrets/secret-process-runner.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function settleWithin(pending: Promise<unknown>, timeoutMs = 50): Promise<unknown> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve("pending"), timeoutMs);
    void pending.then(
      () => {
        clearTimeout(timeout);
        resolve("resolved");
      },
      (error: unknown) => {
        clearTimeout(timeout);
        resolve(error);
      }
    );
  });
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  windowsSecretCommandMocks.resolveWindowsSecretCommand.mockImplementation(
    () => new Promise<ResolvedWindowsSecretCommand | undefined>(() => undefined)
  );
});

afterEach(() => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
  windowsSecretCommandMocks.resolveWindowsSecretCommand.mockReset();
  windowsSecretCommandMocks.spawnWindowsSecretCommand.mockReset();
});

describe("Windows secret command resolution", () => {
  it("cancels while executable resolution is still pending", async () => {
    const controller = new AbortController();
    const pending = runSecretCommand(
      { executable: "provider.exe", args: [], environment: {} },
      { signal: controller.signal }
    );
    controller.abort();

    const outcome = await settleWithin(pending);

    expect(windowsSecretCommandMocks.resolveWindowsSecretCommand).toHaveBeenCalledOnce();
    expect(windowsSecretCommandMocks.spawnWindowsSecretCommand).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "cancelled" });
  });

  it("times out while executable resolution is still pending", async () => {
    const outcome = await settleWithin(
      runSecretCommand({ executable: "provider.exe", args: [], environment: {} }, { timeoutMs: 5 })
    );

    expect(windowsSecretCommandMocks.resolveWindowsSecretCommand).toHaveBeenCalledOnce();
    expect(windowsSecretCommandMocks.spawnWindowsSecretCommand).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "timeout" });
  });

  it("keeps an immediate resolution failure unavailable", async () => {
    windowsSecretCommandMocks.resolveWindowsSecretCommand.mockRejectedValue(new Error("resolver failure"));

    const outcome = await settleWithin(runSecretCommand({ executable: "provider.exe", args: [], environment: {} }));

    expect(windowsSecretCommandMocks.resolveWindowsSecretCommand).toHaveBeenCalledOnce();
    expect(windowsSecretCommandMocks.spawnWindowsSecretCommand).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "unavailable" });
  });

  it("does not let a late unavailable resolution outrun its deadline", async () => {
    windowsSecretCommandMocks.resolveWindowsSecretCommand.mockImplementation(async () => {
      const elapsedDeadline = Date.now() + 20;
      while (Date.now() < elapsedDeadline) {
        void Date.now();
      }
      return undefined;
    });

    const outcome = await settleWithin(
      runSecretCommand({ executable: "provider.exe", args: [], environment: {} }, { timeoutMs: 1 })
    );

    expect(windowsSecretCommandMocks.resolveWindowsSecretCommand).toHaveBeenCalledOnce();
    expect(windowsSecretCommandMocks.spawnWindowsSecretCommand).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "timeout" });
  });

  it("keeps the resolution timeout independent of a wall-clock rollback", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(-1_000_000);

    const outcome = await settleWithin(
      runSecretCommand({ executable: "provider.exe", args: [], environment: {} }, { timeoutMs: 5 })
    );

    expect(windowsSecretCommandMocks.resolveWindowsSecretCommand).toHaveBeenCalledOnce();
    expect(windowsSecretCommandMocks.spawnWindowsSecretCommand).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "timeout" });
  });
});
