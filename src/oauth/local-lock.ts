import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";

const localLockPortStart = 49_152;
const localLockPortCount = 16_384;
// POSIX retains one canonical candidate to preserve coordination with older Miftah versions.
// Windows uses a named pipe instead because this entire TCP range is also its default ephemeral
// range, so an unrelated connection can otherwise make an OAuth store unavailable.
const localLockPortAttempts = 1;
const localLockProbeMilliseconds = 100;
const localLockProtocol = "miftah-oauth-local-lock-v1";

/** Stable internal failure used to map unavailable local coordination to a public Miftah error. */
export class OAuthLocalLockUnavailableError extends Error {
  constructor() {
    super("OAuth local lock is unavailable.");
    this.name = "OAuthLocalLockUnavailableError";
  }
}

function localLockKey(scope: string, value: string): string {
  return createHash("sha256").update(`${localLockProtocol}\u0000${scope}\u0000${value}`, "utf8").digest("hex");
}

function localLockPorts(key: string): readonly number[] {
  const start = Number.parseInt(key.slice(0, 8), 16) % localLockPortCount;
  return Array.from(
    { length: localLockPortAttempts },
    (_, offset) => localLockPortStart + ((start + offset) % localLockPortCount)
  );
}

function localLockGreeting(key: string): string {
  return `${localLockProtocol} ${key}\n`;
}

type LocalLockEndpoint =
  | { readonly kind: "tcp"; readonly port: number }
  | { readonly kind: "pipe"; readonly path: string };

function localLockEndpoints(key: string, platform: NodeJS.Platform): readonly LocalLockEndpoint[] {
  if (platform === "win32") {
    return [{ kind: "pipe", path: `\\\\.\\pipe\\${localLockProtocol}-${key}` }];
  }
  return localLockPorts(key).map((port) => ({ kind: "tcp", port }));
}

type LocalLockEndpointState = "available" | "held" | "occupied" | "unknown";

interface LocalLock {
  readonly server: Server;
  readonly clients: Set<Socket>;
}

async function inspectLocalLockEndpoint(endpoint: LocalLockEndpoint, key: string): Promise<LocalLockEndpointState> {
  return new Promise((resolve) => {
    const socket = endpoint.kind === "pipe"
      ? connect(endpoint.path)
      : connect({ host: "127.0.0.1", port: endpoint.port });
    let settled = false;
    let response = "";
    const settle = (state: LocalLockEndpointState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(state);
    };
    // An incomplete probe may be a holder acquiring or releasing this exact lock. Retrying the
    // same endpoint avoids bypassing a still-live holder through a different endpoint.
    const timeout = setTimeout(() => settle("unknown"), localLockProbeMilliseconds);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > localLockGreeting(key).length) {
        settle("occupied");
        return;
      }
      if (response.includes("\n")) settle(response === localLockGreeting(key) ? "held" : "occupied");
    });
    socket.once("end", () => {
      if (response === localLockGreeting(key)) {
        settle("held");
        return;
      }
      settle(response.includes("\n") ? "occupied" : "unknown");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const unavailable = error.code === "ECONNREFUSED" || (endpoint.kind === "pipe" && error.code === "ENOENT");
      settle(unavailable ? "available" : "unknown");
    });
  });
}

async function tryAcquireLocalLock(endpoint: LocalLockEndpoint, key: string): Promise<LocalLock | undefined> {
  return new Promise((resolve, reject) => {
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.once("close", () => clients.delete(socket));
      socket.end(localLockGreeting(key));
    });
    const fail = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE") {
        resolve(undefined);
        return;
      }
      reject(error);
    };
    server.once("error", fail);
    const listening = () => {
      server.off("error", fail);
      server.on("error", () => {
        process.emitWarning("Miftah OAuth local lock listener encountered an error.");
      });
      resolve({ server, clients });
    };
    if (endpoint.kind === "pipe") {
      server.listen(endpoint.path, listening);
    } else {
      server.listen({ host: "127.0.0.1", port: endpoint.port, exclusive: true }, listening);
    }
  });
}

async function releaseLocalLock(lock: LocalLock): Promise<void> {
  for (const client of lock.clients) client.destroy();
  await new Promise<void>((resolve) => {
    lock.server.close((error) => {
      if (error !== undefined) process.emitWarning("Miftah OAuth local lock listener could not be closed after its operation completed.");
      resolve();
    });
  });
}

async function acquireLocalLock(
  scope: string,
  value: string,
  waitMilliseconds: number,
  platform: NodeJS.Platform
): Promise<() => Promise<void>> {
  if (!Number.isSafeInteger(waitMilliseconds) || waitMilliseconds <= 0) throw new OAuthLocalLockUnavailableError();
  const startedAt = Date.now();
  const key = localLockKey(scope, value);
  const endpoints = localLockEndpoints(key, platform);
  while (true) {
    let availableEndpoint: LocalLockEndpoint | undefined;
    let mustWait = false;
    for (const endpoint of endpoints) {
      if (Date.now() - startedAt >= waitMilliseconds) throw new OAuthLocalLockUnavailableError();
      const state = await inspectLocalLockEndpoint(endpoint, key);
      if (state === "held" || state === "unknown") {
        mustWait = true;
        break;
      }
      if (state === "available" && availableEndpoint === undefined) availableEndpoint = endpoint;
    }
    if (!mustWait && availableEndpoint !== undefined) {
      let lock: LocalLock | undefined;
      try {
        lock = await tryAcquireLocalLock(availableEndpoint, key);
      } catch {
        throw new OAuthLocalLockUnavailableError();
      }
      if (lock !== undefined) {
        let competingHolder = false;
        for (const endpoint of endpoints) {
          if (endpoint === availableEndpoint) continue;
          if (Date.now() - startedAt >= waitMilliseconds) {
            await releaseLocalLock(lock);
            throw new OAuthLocalLockUnavailableError();
          }
          const state = await inspectLocalLockEndpoint(endpoint, key);
          if (state === "held" || state === "unknown") {
            competingHolder = true;
            break;
          }
        }
        if (!competingHolder) return async () => releaseLocalLock(lock);
        await releaseLocalLock(lock);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Runs a local critical section keyed by an opaque value. The kernel releases its listener when
 * the owner exits, so a dead process cannot strand OAuth state behind a stale lock artifact.
 */
export async function withOAuthLocalLock<Value>(
  scope: string,
  value: string,
  waitMilliseconds: number,
  operation: () => Promise<Value>,
  platform: NodeJS.Platform = process.platform
): Promise<Value> {
  const release = await acquireLocalLock(scope, value, waitMilliseconds, platform);
  try {
    return await operation();
  } finally {
    await release();
  }
}
