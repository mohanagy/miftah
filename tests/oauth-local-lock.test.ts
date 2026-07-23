import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  createOAuthLocalLockListenOptions,
  createOAuthLocalLockStrategy,
  OAuthLocalLockUnavailableError,
  withOAuthLocalLock
} from "../src/oauth/local-lock.js";

const connectTargets = vi.hoisted(() => ({ ports: [] as number[], paths: [] as string[] }));

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    connect: (...args: Parameters<typeof actual.connect>) => {
      const options = args[0] as unknown;
      if (typeof options === "string") connectTargets.paths.push(options);
      if (typeof options === "object" && options !== null && "port" in options) {
        connectTargets.ports.push(Number((options as { port: unknown }).port));
      }
      return Reflect.apply(actual.connect, undefined, args);
    }
  };
});

const protocol = "miftah-oauth-local-lock-v1";
const portStart = 49_152;
const portCount = 16_384;

function firstCandidatePort(scope: string, value: string): number {
  const key = createHash("sha256").update(`${protocol}\u0000${scope}\u0000${value}`, "utf8").digest("hex");
  return portStart + (Number.parseInt(key.slice(0, 8), 16) % portCount);
}

function lockGreeting(scope: string, value: string): string {
  const key = createHash("sha256").update(`${protocol}\u0000${scope}\u0000${value}`, "utf8").digest("hex");
  return `${protocol} ${key}\n`;
}

async function tryOccupy(port: number): Promise<Server | undefined> {
  const server = createServer((socket) => socket.end("unrelated-listener\n"));
  return new Promise((resolve) => {
    const onError = (): void => resolve(undefined);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

async function tryHoldLegacyLock(port: number, greeting: string): Promise<Server | undefined> {
  const server = createServer((socket) => socket.end(greeting));
  return new Promise((resolve) => {
    const onError = (): void => resolve(undefined);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("OAuth local lock", () => {
  it("uses one canonical coordination probe", async () => {
    connectTargets.ports.length = 0;
    connectTargets.paths.length = 0;
    const scope = "bounded-probe-regression";
    const value = "connection";

    await withOAuthLocalLock(scope, value, 2_000, async () => undefined, "linux");

    expect(connectTargets.ports).toEqual([firstCandidatePort(scope, value)]);
    expect(connectTargets.paths).toEqual([]);
  });

  it("uses an exclusive kernel-released named pipe while retaining the legacy Windows probe", () => {
    const scope = "windows-pipe-regression";
    const value = "connection";
    const key = createHash("sha256").update(`${protocol}\u0000${scope}\u0000${value}`, "utf8").digest("hex");
    const path = `\\\\.\\pipe\\${protocol}-${key}`;

    const strategy = createOAuthLocalLockStrategy(scope, value, "win32");

    expect(strategy.probeEndpoints).toEqual([{ kind: "tcp", port: firstCandidatePort(scope, value) }]);
    expect(strategy.acquisitionEndpoint).toEqual({ kind: "pipe", path });
    expect(createOAuthLocalLockListenOptions(strategy.acquisitionEndpoint)).toEqual({ path, exclusive: true });
  });

  it("waits for an older Windows process holding the canonical TCP lock", async () => {
    connectTargets.paths.length = 0;
    const scope = "windows-legacy-holder-regression";
    let value = "";
    let holder: Server | undefined;
    for (let index = 0; index < 256 && holder === undefined; index += 1) {
      value = `connection-${index}`;
      holder = await tryHoldLegacyLock(firstCandidatePort(scope, value), lockGreeting(scope, value));
    }
    if (holder === undefined) throw new Error("Could not reserve a legacy Windows OAuth lock candidate");

    const operation = vi.fn(async () => undefined);
    try {
      await expect(withOAuthLocalLock(scope, value, 100, operation, "win32")).rejects.toBeInstanceOf(
        OAuthLocalLockUnavailableError
      );
      expect(operation).not.toHaveBeenCalled();
      expect(connectTargets.paths).toEqual([]);
    } finally {
      await close(holder);
    }
  });

  it("keeps an older Windows process out while the named-pipe holder is active", async () => {
    const scope = "windows-new-holder-regression";
    const value = "connection";
    let releaseNewHolder!: () => void;
    const holdNewHolder = new Promise<void>((resolve) => {
      releaseNewHolder = resolve;
    });
    let markNewHolderEntered!: () => void;
    const newHolderEntered = new Promise<void>((resolve) => {
      markNewHolderEntered = resolve;
    });
    const newHolder = withOAuthLocalLock(scope, value, 2_000, async () => {
      markNewHolderEntered();
      await holdNewHolder;
    }, "win32");
    await newHolderEntered;

    const oldOperation = vi.fn(async () => undefined);
    try {
      await expect(withOAuthLocalLock(scope, value, 100, oldOperation, "linux")).rejects.toBeInstanceOf(
        OAuthLocalLockUnavailableError
      );
      expect(oldOperation).not.toHaveBeenCalled();
    } finally {
      releaseNewHolder();
      await newHolder;
    }
  });

  it("continues with the Windows pipe when an unrelated listener occupies the legacy port", async () => {
    const scope = "windows-unrelated-legacy-listener-regression";
    let value = "";
    let blocker: Server | undefined;
    for (let index = 0; index < 256 && blocker === undefined; index += 1) {
      value = `connection-${index}`;
      blocker = await tryOccupy(firstCandidatePort(scope, value));
    }
    if (blocker === undefined) throw new Error("Could not reserve an unrelated legacy Windows lock candidate");

    const operation = vi.fn(async () => undefined);
    try {
      await withOAuthLocalLock(scope, value, 2_000, operation, "win32");
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      await close(blocker);
    }
  });

  it("fails closed while the canonical candidate is occupied", async () => {
    const scope = "occupied-candidate-regression";
    let value = "";
    let blocker: Server | undefined;
    for (let index = 0; index < 256 && blocker === undefined; index += 1) {
      value = `connection-${index}`;
      blocker = await tryOccupy(firstCandidatePort(scope, value));
    }
    if (blocker === undefined) throw new Error("Could not reserve a deterministic OAuth lock candidate for the regression test");

    try {
      await expect(withOAuthLocalLock(scope, value, 100, async () => undefined, "linux")).rejects.toBeInstanceOf(
        OAuthLocalLockUnavailableError
      );
    } finally {
      await close(blocker);
    }
  });

  it("keeps one key serialized", async () => {
    const scope = "same-key-regression";
    const value = "connection";

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const first = withOAuthLocalLock(scope, value, 2_000, async () => {
      markFirstEntered();
      await holdFirst;
    });

    await firstEntered;

    let markSecondEntered!: () => void;
    const secondEntered = new Promise<void>((resolve) => {
      markSecondEntered = resolve;
    });
    const second = withOAuthLocalLock(scope, value, 2_000, async () => {
      markSecondEntered();
    });

    try {
      const state = await Promise.race([
        secondEntered.then(() => "entered" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 200))
      ]);
      expect(state).toBe("blocked");
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second]);
    }
  });
});
