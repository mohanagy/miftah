import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  createOAuthLocalLockListenOptions,
  createOAuthLocalLockStrategy,
  macOSFallbackCandidateCount,
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

function fallbackCandidatePorts(scope: string, value: string): readonly number[] {
  const key = createHash("sha256").update(`${protocol}\u0000${scope}\u0000${value}`, "utf8").digest("hex");
  const ports = new Set<number>([firstCandidatePort(scope, value)]);
  const candidates: number[] = [];
  for (let index = 1; index <= macOSFallbackCandidateCount; index += 1) {
    const port = portStart + (Number.parseInt(key.slice(index * 8, (index + 1) * 8), 16) % portCount);
    if (ports.has(port)) continue;
    ports.add(port);
    candidates.push(port);
  }
  return candidates;
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

async function tryHoldAmbiguousListener(port: number): Promise<Server | undefined> {
  const server = createServer((socket) => socket.resume());
  return new Promise((resolve) => {
    const onError = (): void => resolve(undefined);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

async function tryHoldFallbackProbeBarriers(ports: readonly number[]): Promise<readonly Server[] | undefined> {
  const sockets = new Set<Socket>();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const socket of sockets) socket.end("unrelated-listener\n");
  };
  const servers: Server[] = [];
  for (const port of ports) {
    const server = createServer((socket) => {
      if (released) {
        socket.end("unrelated-listener\n");
        return;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      if (sockets.size === ports.length) release();
    });
    const listening = await new Promise<boolean>((resolve) => {
      const onError = (): void => resolve(false);
      server.once("error", onError);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.off("error", onError);
        resolve(true);
      });
    });
    if (!listening) {
      await Promise.all(servers.map((existing) => close(existing)));
      return undefined;
    }
    servers.push(server);
  }
  return servers;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function collidingValues(scope: string): readonly [string, string] {
  const valuesByPort = new Map<number, string>();
  for (let index = 0; index <= portCount; index += 1) {
    const value = `connection-${index}`;
    const port = firstCandidatePort(scope, value);
    const existing = valuesByPort.get(port);
    if (existing !== undefined) return [existing, value];
    valuesByPort.set(port, value);
  }
  throw new Error("Could not find deterministic OAuth lock candidates with the same legacy port");
}

describe("OAuth local lock", () => {
  it("uses one canonical coordination probe", async () => {
    connectTargets.ports.length = 0;
    connectTargets.paths.length = 0;
    const scope = "bounded-probe-regression";
    const value = "connection";

    await withOAuthLocalLock(scope, value, 2_000, async () => undefined);

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

  it("uses a kernel-released abstract socket while retaining the legacy Linux probe", () => {
    const scope = "linux-abstract-socket-regression";
    const value = "connection";
    const key = createHash("sha256").update(`${protocol}\u0000${scope}\u0000${value}`, "utf8").digest("hex");
    const strategy = createOAuthLocalLockStrategy(scope, value, "linux");

    expect(strategy.probeEndpoints).toEqual([{ kind: "tcp", port: firstCandidatePort(scope, value) }]);
    expect(strategy.acquisitionEndpoint.kind).toBe("pipe");
    if (strategy.acquisitionEndpoint.kind !== "pipe") throw new Error("Expected a Linux abstract socket endpoint");
    expect(strategy.acquisitionEndpoint.path.charCodeAt(0)).toBe(0);
    expect(strategy.acquisitionEndpoint.path.slice(1)).toBe(`${protocol}-${key}`);
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

  it.runIf(process.platform === "linux")("keeps distinct Linux locks independent when their legacy TCP candidates collide", async () => {
    const scope = "linux-collision-regression";
    const [firstValue, secondValue] = collidingValues(scope);
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const first = withOAuthLocalLock(scope, firstValue, 2_000, async () => {
      markFirstEntered();
      await holdFirst;
    }, "linux");
    await firstEntered;

    const secondOperation = vi.fn(async () => undefined);
    try {
      await withOAuthLocalLock(scope, secondValue, 200, secondOperation, "linux");
      expect(secondOperation).toHaveBeenCalledOnce();
      expect(createOAuthLocalLockStrategy(scope, secondValue, "linux").acquisitionEndpoint).toMatchObject({ kind: "pipe" });
    } finally {
      releaseFirst();
      await first;
    }
  });

  it("keeps distinct macOS locks independent when their legacy TCP candidates collide", async () => {
    const scope = "macos-collision-regression";
    const [firstValue, secondValue] = collidingValues(scope);
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const first = withOAuthLocalLock(scope, firstValue, 2_000, async () => {
      markFirstEntered();
      await holdFirst;
    }, "darwin");
    await firstEntered;

    const secondOperation = vi.fn(async () => undefined);
    try {
      await withOAuthLocalLock(scope, secondValue, 200, secondOperation, "darwin");
      expect(secondOperation).toHaveBeenCalledOnce();
    } finally {
      releaseFirst();
      await first;
    }
  });

  it("uses a macOS fallback while an unrelated listener occupies the canonical TCP candidate", async () => {
    const scope = "occupied-candidate-regression";
    let value = "";
    let blocker: Server | undefined;
    for (let index = 0; index < 256 && blocker === undefined; index += 1) {
      value = `connection-${index}`;
      blocker = await tryOccupy(firstCandidatePort(scope, value));
    }
    if (blocker === undefined) throw new Error("Could not reserve a deterministic OAuth lock candidate for the regression test");

    const operation = vi.fn(async () => undefined);
    try {
      await withOAuthLocalLock(scope, value, 100, operation, "darwin");
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      await close(blocker);
    }
  });

  it("probes macOS fallback candidates concurrently before selecting the first available endpoint", async () => {
    const scope = "macos-fallback-concurrent-probe-regression";
    let value = "";
    let legacyBlocker: Server | undefined;
    let fallbackBlockers: readonly Server[] = [];
    for (let index = 0; index < 256 && legacyBlocker === undefined; index += 1) {
      const candidateValue = `connection-${index}`;
      const fallbackPorts = fallbackCandidatePorts(scope, candidateValue);
      if (fallbackPorts.length < 2) continue;
      const candidateFallbackBlockers = await tryHoldFallbackProbeBarriers(fallbackPorts.slice(0, -1));
      if (candidateFallbackBlockers === undefined) continue;
      const candidateLegacyBlocker = await tryOccupy(firstCandidatePort(scope, candidateValue));
      if (candidateLegacyBlocker === undefined) {
        await Promise.all(candidateFallbackBlockers.map((server) => close(server)));
        continue;
      }
      value = candidateValue;
      fallbackBlockers = candidateFallbackBlockers;
      legacyBlocker = candidateLegacyBlocker;
    }
    if (legacyBlocker === undefined) throw new Error("Could not reserve deterministic macOS fallback probe barriers");

    const operation = vi.fn(async () => undefined);
    try {
      await withOAuthLocalLock(scope, value, 400, operation, "darwin");
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      await close(legacyBlocker);
      await Promise.all(fallbackBlockers.map((server) => close(server)));
    }
  });

  it("does not split one macOS key across fallback candidates", async () => {
    const scope = "macos-fallback-serialization-regression";
    const [primaryValue, value] = collidingValues(scope);
    const [firstFallback] = fallbackCandidatePorts(scope, value);
    if (firstFallback === undefined) throw new Error("Expected a macOS fallback candidate");
    const blocker = await tryOccupy(firstFallback);
    if (blocker === undefined) throw new Error("Could not reserve a macOS fallback candidate");
    let blockerClosed = false;

    let releasePrimary!: () => void;
    const holdPrimary = new Promise<void>((resolve) => {
      releasePrimary = resolve;
    });
    let markPrimaryEntered!: () => void;
    const primaryEntered = new Promise<void>((resolve) => {
      markPrimaryEntered = resolve;
    });
    const primary = withOAuthLocalLock(scope, primaryValue, 2_000, async () => {
      markPrimaryEntered();
      await holdPrimary;
    }, "darwin");

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let first: Promise<void> | undefined;
    let duplicate: Promise<void> | undefined;
    try {
      await primaryEntered;
      first = withOAuthLocalLock(scope, value, 2_000, async () => {
        markFirstEntered();
        await holdFirst;
      }, "darwin");
      await firstEntered;
      await close(blocker);
      blockerClosed = true;

      let markDuplicateEntered!: () => void;
      const duplicateEntered = new Promise<void>((resolve) => {
        markDuplicateEntered = resolve;
      });
      duplicate = withOAuthLocalLock(scope, value, 2_000, async () => {
        markDuplicateEntered();
      }, "darwin");
      const state = await Promise.race([
        duplicateEntered.then(() => "entered" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 200))
      ]);
      expect(state).toBe("blocked");

      releaseFirst();
      await first;
      await duplicate;
    } finally {
      releaseFirst();
      releasePrimary();
      if (!blockerClosed) await close(blocker);
      await Promise.allSettled([
        primary,
        ...(first === undefined ? [] : [first]),
        ...(duplicate === undefined ? [] : [duplicate])
      ]);
    }
  });

  it("fails closed when an ambiguous macOS legacy listener does not identify its holder", async () => {
    const scope = "macos-ambiguous-legacy-listener-regression";
    let value = "";
    let blocker: Server | undefined;
    for (let index = 0; index < 256 && blocker === undefined; index += 1) {
      value = `connection-${index}`;
      blocker = await tryHoldAmbiguousListener(firstCandidatePort(scope, value));
    }
    if (blocker === undefined) throw new Error("Could not reserve an ambiguous macOS OAuth lock candidate");

    const operation = vi.fn(async () => undefined);
    try {
      await expect(withOAuthLocalLock(scope, value, 150, operation, "darwin")).rejects.toBeInstanceOf(
        OAuthLocalLockUnavailableError
      );
      expect(operation).not.toHaveBeenCalled();
    } finally {
      await close(blocker);
    }
  });

  it("does not bypass an exact older macOS holder through a fallback candidate", async () => {
    const scope = "macos-legacy-holder-regression";
    let value = "";
    let holder: Server | undefined;
    for (let index = 0; index < 256 && holder === undefined; index += 1) {
      value = `connection-${index}`;
      holder = await tryHoldLegacyLock(firstCandidatePort(scope, value), lockGreeting(scope, value));
    }
    if (holder === undefined) throw new Error("Could not reserve a legacy macOS OAuth lock candidate");

    const operation = vi.fn(async () => undefined);
    try {
      await expect(withOAuthLocalLock(scope, value, 100, operation, "darwin")).rejects.toBeInstanceOf(
        OAuthLocalLockUnavailableError
      );
      expect(operation).not.toHaveBeenCalled();
    } finally {
      await close(holder);
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
