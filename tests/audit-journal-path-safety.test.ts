import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/audit/audit-logger.js";

const identitylessFilesystem = vi.hoisted(() => ({ enabled: false }));

function withoutStableIdentity<Stats extends { readonly dev: number | bigint; readonly ino: number | bigint }>(stats: Stats): Stats {
  const zero = typeof stats.dev === "bigint" ? 0n : 0;
  return Object.create(stats, {
    dev: { value: zero, enumerable: true },
    ino: { value: zero, enumerable: true }
  }) as Stats;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args);
      return identitylessFilesystem.enabled ? withoutStableIdentity(stats) : stats;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!identitylessFilesystem.enabled) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "stat") {
            return async (...statArgs: Parameters<FileHandle["stat"]>) =>
              withoutStableIdentity(await target.stat(...statArgs));
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as FileHandle;
    }
  };
});

describe("managed audit journal path safety", () => {
  it("fails closed when stable file identities are unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-identityless-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { rotation: { maxBytes: 1, retainFiles: 1 } });
    identitylessFilesystem.enabled = true;

    try {
      await expect(
        logger.log({
          wrapper: "github",
          profile: "work",
          operation: "tools/call",
          name: "must-not-write-without-stable-identity",
          status: "success",
          durationMs: 1
        })
      ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });

      await expect(readFile(path, "utf8")).resolves.toBe("");
    } finally {
      identitylessFilesystem.enabled = false;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
