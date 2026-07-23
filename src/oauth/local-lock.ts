import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import type { ListenOptions, Server, Socket } from "node:net";

const localLockPortStart = 49_152;
const localLockPortCount = 16_384;
// POSIX retains one canonical candidate to preserve coordination with older Miftah versions.
// Windows recognizes an exact holder on that legacy candidate and holds a best-effort companion
// listener for rolling upgrades, but acquires a named pipe because this entire TCP range is also
// its default ephemeral range. Miftah never connects to the named pipe: exclusive creation is the
// lock boundary, so an untrusted squatter can only cause the same fail-closed denial of service
// that was already possible against the TCP listener.
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

function localLockPort(key: string): number {
  return localLockPortStart + (Number.parseInt(key.slice(0, 8), 16) % localLockPortCount);
}

function localLockGreeting(key: string): string {
  return `${localLockProtocol} ${key}\n`;
}

export type OAuthLocalLockEndpoint =
  | { readonly kind: "tcp"; readonly port: number }
  | { readonly kind: "pipe"; readonly path: string };
type OAuthLocalLockProbeEndpoint = Extract<OAuthLocalLockEndpoint, { kind: "tcp" }>;

export interface OAuthLocalLockStrategy {
  readonly key: string;
  readonly probeEndpoints: readonly [OAuthLocalLockProbeEndpoint];
  readonly acquisitionEndpoint: OAuthLocalLockEndpoint;
}

export function createOAuthLocalLockStrategy(
  scope: string,
  value: string,
  platform: NodeJS.Platform = process.platform
): OAuthLocalLockStrategy {
  const key = localLockKey(scope, value);
  const legacyEndpoint: OAuthLocalLockProbeEndpoint = { kind: "tcp", port: localLockPort(key) };
  if (platform === "win32") {
    const acquisitionEndpoint: OAuthLocalLockEndpoint = {
      kind: "pipe",
      path: `\\\\.\\pipe\\${localLockProtocol}-${key}`
    };
    return { key, probeEndpoints: [legacyEndpoint], acquisitionEndpoint };
  }
  return { key, probeEndpoints: [legacyEndpoint], acquisitionEndpoint: legacyEndpoint };
}

function sameLocalLockEndpoint(left: OAuthLocalLockEndpoint, right: OAuthLocalLockEndpoint): boolean {
  if (left.kind === "tcp") return right.kind === "tcp" && left.port === right.port;
  return right.kind === "pipe" && left.path === right.path;
}

export function createOAuthLocalLockListenOptions(endpoint: OAuthLocalLockEndpoint): ListenOptions {
  return endpoint.kind === "pipe"
    ? { path: endpoint.path, exclusive: true }
    : { host: "127.0.0.1", port: endpoint.port, exclusive: true };
}

type LocalLockEndpointState = "available" | "held" | "occupied" | "unknown";

interface LocalLock {
  readonly server: Server;
  readonly clients: Set<Socket>;
}

async function inspectLocalLockEndpoint(endpoint: OAuthLocalLockProbeEndpoint, key: string): Promise<LocalLockEndpointState> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: endpoint.port });
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
      settle(error.code === "ECONNREFUSED" ? "available" : "unknown");
    });
  });
}

async function tryAcquireLocalLock(endpoint: OAuthLocalLockEndpoint, key: string): Promise<LocalLock | undefined> {
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
    server.listen(createOAuthLocalLockListenOptions(endpoint), listening);
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
  const strategy = createOAuthLocalLockStrategy(scope, value, platform);
  const legacyEndpoint = strategy.probeEndpoints[0];
  const acquiresLegacyEndpoint = sameLocalLockEndpoint(legacyEndpoint, strategy.acquisitionEndpoint);
  while (true) {
    if (Date.now() - startedAt >= waitMilliseconds) throw new OAuthLocalLockUnavailableError();
    const legacyState = await inspectLocalLockEndpoint(legacyEndpoint, strategy.key);
    const mustWait = acquiresLegacyEndpoint ? legacyState !== "available" : legacyState === "held";
    if (!mustWait) {
      let primaryLock: LocalLock | undefined;
      try {
        primaryLock = await tryAcquireLocalLock(strategy.acquisitionEndpoint, strategy.key);
      } catch {
        throw new OAuthLocalLockUnavailableError();
      }
      if (primaryLock !== undefined) {
        if (acquiresLegacyEndpoint) return async () => releaseLocalLock(primaryLock);

        let legacyLock: LocalLock | undefined;
        try {
          legacyLock = await tryAcquireLocalLock(legacyEndpoint, strategy.key);
        } catch {
          process.emitWarning("Miftah OAuth legacy lock compatibility listener could not be started.");
        }
        if (legacyLock === undefined) {
          if (Date.now() - startedAt < waitMilliseconds) {
            const postAcquisitionLegacyState = await inspectLocalLockEndpoint(legacyEndpoint, strategy.key);
            if (postAcquisitionLegacyState === "held") {
              await releaseLocalLock(primaryLock);
              await new Promise((resolve) => setTimeout(resolve, 10));
              continue;
            }
          }
        }
        return async () => {
          try {
            if (legacyLock !== undefined) await releaseLocalLock(legacyLock);
          } catch {
            process.emitWarning("Miftah OAuth legacy lock compatibility listener could not be closed.");
          } finally {
            await releaseLocalLock(primaryLock);
          }
        };
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
