import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { OAuthLocalLockUnavailableError, withOAuthLocalLock } from "../src/oauth/local-lock.js";

const connectPorts = vi.hoisted(() => [] as number[]);

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    connect: (...args: Parameters<typeof actual.connect>) => {
      const options = args[0] as unknown;
      if (typeof options === "object" && options !== null && "port" in options) {
        connectPorts.push(Number((options as { port: unknown }).port));
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

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("OAuth local lock", () => {
  it("uses one canonical coordination probe", async () => {
    connectPorts.length = 0;
    const scope = "bounded-probe-regression";
    const value = "connection";

    await withOAuthLocalLock(scope, value, 2_000, async () => undefined);

    expect(connectPorts).toEqual([firstCandidatePort(scope, value)]);
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
      await expect(withOAuthLocalLock(scope, value, 100, async () => undefined)).rejects.toBeInstanceOf(
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
