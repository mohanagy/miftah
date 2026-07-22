import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";

const localLockPortStart = 49_152;
const localLockPortCount = 16_384;
const localLockPortAttempts = 256;
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

type LocalLockPortState = "available" | "held" | "occupied" | "unknown";

interface LocalLock {
  readonly server: Server;
  readonly clients: Set<Socket>;
}

async function inspectLocalLockPort(port: number, key: string): Promise<LocalLockPortState> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    let response = "";
    const settle = (state: LocalLockPortState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(state);
    };
    // An incomplete probe may be a holder acquiring or releasing this exact lock. Retrying the
    // same candidate avoids bypassing a still-live holder through a different port.
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
      settle(error.code === "ECONNREFUSED" ? "available" : "unknown");
    });
  });
}

async function tryAcquireLocalLock(port: number, key: string): Promise<LocalLock | undefined> {
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
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", fail);
      server.on("error", () => {
        process.emitWarning("Miftah OAuth local lock listener encountered an error.");
      });
      resolve({ server, clients });
    });
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

async function acquireLocalLock(scope: string, value: string, waitMilliseconds: number): Promise<() => Promise<void>> {
  if (!Number.isSafeInteger(waitMilliseconds) || waitMilliseconds <= 0) throw new OAuthLocalLockUnavailableError();
  const startedAt = Date.now();
  const key = localLockKey(scope, value);
  const ports = localLockPorts(key);
  while (true) {
    for (const port of ports) {
      if (Date.now() - startedAt >= waitMilliseconds) throw new OAuthLocalLockUnavailableError();
      const state = await inspectLocalLockPort(port, key);
      if (state === "held" || state === "unknown") break;
      if (state === "available") {
        try {
          const lock = await tryAcquireLocalLock(port, key);
          if (lock !== undefined) return async () => releaseLocalLock(lock);
        } catch {
          throw new OAuthLocalLockUnavailableError();
        }
        break;
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
  operation: () => Promise<Value>
): Promise<Value> {
  const release = await acquireLocalLock(scope, value, waitMilliseconds);
  try {
    return await operation();
  } finally {
    await release();
  }
}
