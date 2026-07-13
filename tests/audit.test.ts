import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, stat, symlink, utimes, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/audit/audit-logger.js";

type BufferWrite = (
  this: FileHandle,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | null
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

const localLockPortStart = 49_152;
const localLockPortCount = 16_384;
const localLockPortAttempts = 256;
const localLockProtocol = "miftah-audit-lock-v1";

function localLockPorts(path: string): readonly number[] {
  const directory = dirname(path);
  const activeBasename = basename(path);
  const key = createHash("sha256")
    .update(`${localLockProtocol}\u0000${directory}\u0000${activeBasename}`, "utf8")
    .digest("hex");
  const start = Number.parseInt(key.slice(0, 8), 16) % localLockPortCount;
  return Array.from(
    { length: localLockPortAttempts },
    (_, offset) => localLockPortStart + ((start + offset) % localLockPortCount)
  );
}

function localLockKey(path: string): string {
  const directory = dirname(path);
  const activeBasename = basename(path);
  return createHash("sha256")
    .update(`${localLockProtocol}\u0000${directory}\u0000${activeBasename}`, "utf8")
    .digest("hex");
}

describe("audit logger", () => {
  it("writes structured events without secret arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { secretValues: ["hidden-token"] });

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "whoami",
      status: "success",
      durationMs: 4,
      arguments: { token: "hidden-token" }
    });

    const line = await readFile(path, "utf8");
    expect(line).not.toContain("hidden-token");
    expect(JSON.parse(line)).toMatchObject({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      status: "success"
    });
  });

  it("timestamps an event when logging begins rather than when its queued write runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-timestamp-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path);
    const loggedAt = new Date("2026-07-11T06:00:00.000Z");

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(loggedAt);
      const write = logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "whoami",
        status: "success",
        durationMs: 4
      });
      vi.setSystemTime(new Date("2026-07-11T07:00:00.000Z"));

      await write;

      expect(JSON.parse(await readFile(path, "utf8")).timestamp).toBe(loggedAt.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("timestamps an event before synchronous redaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-redaction-timestamp-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { includeArguments: true });
    const loggedAt = new Date("2026-07-11T06:00:00.000Z");
    const redactedAt = new Date("2026-07-11T07:00:00.000Z");
    const argumentsWithTimeShift: Record<string, unknown> = {};
    Object.defineProperty(argumentsWithTimeShift, "value", {
      enumerable: true,
      get: () => {
        vi.setSystemTime(redactedAt);
        return "safe";
      }
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(loggedAt);
      await logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "whoami",
        status: "success",
        durationMs: 4,
        arguments: argumentsWithTimeShift
      });

      expect(JSON.parse(await readFile(path, "utf8")).timestamp).toBe(loggedAt.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("redacts credential-bearing URI arguments when argument logging is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-uri-arguments-"));
    const path = join(directory, "audit.jsonl");
    const secret = "audit-uri-secret";
    const logger = new AuditLogger(path, { includeArguments: true });

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "open_callback",
      status: "success",
      durationMs: 4,
      arguments: { callbackUrl: `https://example.test/callback?access_token=${secret}` }
    });

    const line = await readFile(path, "utf8");
    expect(line).not.toContain(secret);
    expect(JSON.parse(line)).toMatchObject({
      arguments: { callbackUrl: "https://example.test/callback?access_token=%5BREDACTED%5D" }
    });
  });

  it.skipIf(process.platform === "win32")("creates audit directories and files with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-audit-permissions-"));
    const directory = join(root, "private");
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path);

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "whoami",
      status: "success",
      durationMs: 4
    });

    expect((await stat(directory)).mode & 0o077).toBe(0);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it.skipIf(process.platform === "win32")("does not tighten an existing audit parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-audit-existing-parent-"));
    const directory = join(root, "shared");
    const path = join(directory, "audit.jsonl");
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    const logger = new AuditLogger(path);

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "whoami",
      status: "success",
      durationMs: 4
    });

    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it("keeps the operation result available when fail-open audit writing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-audit-fail-open-"));
    const blockingPath = join(root, "not-a-directory");
    await writeFile(blockingPath, "file");
    const logger = new AuditLogger(join(blockingPath, "audit.jsonl"), { failureMode: "fail-open" });

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "whoami",
        status: "success",
        durationMs: 4
      })
    ).resolves.toBeUndefined();

    expect(logger.health()).toMatchObject({
      state: "failed",
      lastFailure: { errorCode: "AUDIT_WRITE_FAILED" }
    });
  });

  it("fails closed with a stable error code when audit writing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-audit-fail-closed-"));
    const blockingPath = join(root, "not-a-directory");
    await writeFile(blockingPath, "file");
    const logger = new AuditLogger(join(blockingPath, "audit.jsonl"));

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "whoami",
        status: "success",
        durationMs: 4
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
  });

  it("serializes concurrent writes into complete JSONL records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-concurrent-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path);

    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        logger.log({
          wrapper: "github",
          profile: "work",
          operation: "tools/call",
          name: `operation-${index}`,
          status: "success",
          durationMs: index
        })
      )
    );

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(64);
    expect(lines.map((line) => JSON.parse(line).name).sort()).toEqual(
      Array.from({ length: 64 }, (_, index) => `operation-${index}`).sort()
    );
  });

  it("rotates complete batches before a size boundary without losing or duplicating events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-rotation-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { rotation: { maxBytes: 1, retainFiles: 8 } });

    await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        logger.log({
          wrapper: "github",
          profile: "work",
          operation: "tools/call",
          name: `rotation-${index}`,
          status: "success",
          durationMs: index
        })
      )
    );

    const segmentNames = (await readdir(directory))
      .filter((name) => name === "audit.jsonl" || name.startsWith("audit.jsonl.miftah-"))
      .sort();
    const records = (
      await Promise.all(segmentNames.map(async (name) => (await readFile(join(directory, name), "utf8")).trim()))
    )
      .flatMap((contents) => contents.split("\n"))
      .map((line) => JSON.parse(line) as { name: string });

    expect(segmentNames).toHaveLength(3);
    expect(records.map((record) => record.name).sort()).toEqual(["rotation-0", "rotation-1", "rotation-2"]);
  });

  it("rejects direct API retention beyond the bounded integrity metadata limit before creating a journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-retention-limit-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { rotation: { maxBytes: 1, retainFiles: 2_001 } });

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-create-an-unbounded-retention-journal",
        status: "success",
        durationMs: 1
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a basename that cannot safely hold a staged integrity retirement filename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-retirement-filename-limit-"));
    const path = join(directory, "a".repeat(175));
    const logger = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 0 }
    });

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-create-a-later-unusable-retirement-journal",
        status: "success",
        durationMs: 1
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("rotates on the next write after the configured segment age", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-age-rotation-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { rotation: { maxAgeMs: 1, retainFiles: 2 } });

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "before-age-rotation",
      status: "success",
      durationMs: 1
    });
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "after-age-rotation",
      status: "success",
      durationMs: 2
    });

    const segmentNames = (await readdir(directory))
      .filter((name) => name === "audit.jsonl" || name.startsWith("audit.jsonl.miftah-"))
      .sort();
    expect(segmentNames).toHaveLength(2);
    expect(
      (await Promise.all(segmentNames.map(async (name) => readFile(join(directory, name), "utf8"))))
        .join("")
        .match(/before-age-rotation|after-age-rotation/gu)
        ?.sort()
    ).toEqual(["after-age-rotation", "before-age-rotation"]);
  });

  it("serializes concurrent logger instances through the journal lock at a rotation boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-multi-logger-"));
    const path = join(directory, "audit.jsonl");
    const first = new AuditLogger(path, { rotation: { maxBytes: 1, retainFiles: 128 } });
    const secondPath = `${directory}${sep}.${sep}audit.jsonl`;
    expect(secondPath).not.toBe(path);
    const second = new AuditLogger(secondPath, {
      rotation: { maxBytes: 1, retainFiles: 128 }
    });

    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        (index % 2 === 0 ? first : second).log({
          wrapper: "github",
          profile: "work",
          operation: "tools/call",
          name: `concurrent-rotation-${index}`,
          status: "success",
          durationMs: index
        })
      )
    );

    const segmentNames = (await readdir(directory))
      .filter((name) => name === "audit.jsonl" || name.startsWith("audit.jsonl.miftah-"))
      .sort();
    const names = (
      await Promise.all(segmentNames.map(async (name) => readFile(join(directory, name), "utf8")))
    )
      .flatMap((contents) => contents.trim().split("\n"))
      .map((line) => JSON.parse(line) as { name: string })
      .map((record) => record.name)
      .sort();

    expect(names).toEqual(Array.from({ length: 32 }, (_, index) => `concurrent-rotation-${index}`).sort());
  });

  it("does not let an abandoned legacy filesystem lock permanently block a local audit journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-abandoned-lock-"));
    const path = join(directory, "audit.jsonl");
    const abandonedLock = join(directory, ".audit.jsonl.miftah-lock");
    await mkdir(abandonedLock, { mode: 0o700 });
    const logger = new AuditLogger(path, { rotation: { maxBytes: 1_000_000, retainFiles: 2 } });
    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "writes-after-abandoned-filesystem-lock",
        status: "success",
        durationMs: 1
      })
    ).resolves.toBeUndefined();
    expect((await lstat(abandonedLock)).isDirectory()).toBe(true);
  });

  it("releases a local audit lock when its owning process is terminated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-crashed-lock-owner-"));
    const path = join(directory, "audit.jsonl");
    const canonicalPath = join(await realpath(directory), "audit.jsonl");
    const key = localLockKey(canonicalPath);
    const holderSource = [
      'const { createServer } = require("node:net");',
      `const ports = ${JSON.stringify(localLockPorts(canonicalPath))};`,
      `const greeting = ${JSON.stringify(`${localLockProtocol} ${key}\n`)};`,
      "let index = 0;",
      "const tryListen = () => {",
      "  if (index >= ports.length) process.exit(2);",
      "  const server = createServer((socket) => socket.end(greeting));",
      "  server.once('error', (error) => {",
      "    if (error && error.code === 'EADDRINUSE') { index += 1; tryListen(); return; }",
      "    process.exit(3);",
      "  });",
      "  server.listen({ host: '127.0.0.1', port: ports[index], exclusive: true }, () => process.stdout.write('ready\\n'));",
      "};",
      "tryListen();",
      "setTimeout(() => process.exit(4), 30_000);"
    ].join("\n");
    const holder = spawn(process.execPath, ["-e", holderSource], { stdio: ["ignore", "pipe", "pipe"] });
    let holderExited = false;
    try {
      const [output] = (await once(holder.stdout, "data")) as [Buffer];
      expect(output.toString("utf8")).toBe("ready\n");

      const logger = new AuditLogger(path, { rotation: { maxBytes: 1_000_000, retainFiles: 2 } });
      const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(5_000);
      try {
        await expect(
          logger.log({
            wrapper: "github",
            profile: "work",
            operation: "tools/call",
            name: "must-wait-for-live-local-lock-owner",
            status: "success",
            durationMs: 1
          })
        ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
      } finally {
        now.mockRestore();
      }

      holder.kill("SIGKILL");
      await once(holder, "exit");
      holderExited = true;

      await expect(
        logger.log({
          wrapper: "github",
          profile: "work",
          operation: "tools/call",
          name: "writes-after-lock-owner-process-termination",
          status: "success",
          durationMs: 2
        })
      ).resolves.toBeUndefined();
    } finally {
      if (!holderExited && holder.exitCode === null) {
        holder.kill("SIGKILL");
        await once(holder, "exit");
      }
    }
  });

  it("never follows a symlink while retaining managed archive segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-audit-retention-symlink-"));
    const directory = join(root, "audit");
    const path = join(directory, "audit.jsonl");
    const sentinel = join(root, "outside-sentinel.jsonl");
    await mkdir(directory);
    await writeFile(sentinel, "outside data");
    const symlinkArchive = join(
      directory,
      `audit.jsonl.miftah-00000000000000000001-${randomUUID()}`
    );
    await symlink(sentinel, symlinkArchive);
    const logger = new AuditLogger(path, { rotation: { maxBytes: 1, retainFiles: 0 } });

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "first-retention-event",
      status: "success",
      durationMs: 1
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "second-retention-event",
      status: "success",
      durationMs: 2
    });

    expect(await readFile(sentinel, "utf8")).toBe("outside data");
    expect((await lstat(symlinkArchive)).isSymbolicLink()).toBe(true);
  });

  it("rejects an incomplete managed journal during fail-closed preflight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-incomplete-preflight-"));
    const path = join(directory, "audit.jsonl");
    await writeFile(path, '{"name":"incomplete-managed-event"');
    const logger = new AuditLogger(path, { rotation: { maxBytes: 1, retainFiles: 2 } });

    await expect(logger.ensureWritable()).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    expect(await readFile(path, "utf8")).toBe('{"name":"incomplete-managed-event"');
  });

  it("refuses a managed active-path symlink without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-audit-active-symlink-"));
    const directory = join(root, "audit");
    const path = join(directory, "audit.jsonl");
    const sentinel = join(root, "outside-sentinel.jsonl");
    await mkdir(directory);
    await writeFile(sentinel, "outside data");
    await symlink(sentinel, path);
    const logger = new AuditLogger(path, { rotation: { maxBytes: 1, retainFiles: 2 } });

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-follow-active-symlink",
        status: "success",
        durationMs: 1
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });

    expect(await readFile(sentinel, "utf8")).toBe("outside data");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it("refuses a managed active-path hard link without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-audit-active-hard-link-"));
    const directory = join(root, "audit");
    const path = join(directory, "audit.jsonl");
    const sentinel = join(root, "outside-sentinel.jsonl");
    await mkdir(directory);
    await writeFile(sentinel, "outside data\n");
    await link(sentinel, path);
    const logger = new AuditLogger(path, { rotation: { maxBytes: 1, retainFiles: 2 } });

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-follow-active-hard-link",
        status: "success",
        durationMs: 1
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });

    expect(await readFile(sentinel, "utf8")).toBe("outside data\n");
  });

  it("rolls back a partially written rotation batch before reporting a disk failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-partial-write-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { rotation: { maxBytes: 1_000_000, retainFiles: 2 } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-partial-write",
      status: "success",
      durationMs: 1
    });
    const before = await readFile(path, "utf8");
    const probe = await open(path, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { write: BufferWrite };
    const originalWrite = probe.write as BufferWrite;
    await probe.close();
    let intercepted = false;
    const writeSpy = vi.spyOn(fileHandlePrototype, "write").mockImplementation(async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null
    ) {
      if (!intercepted) {
        intercepted = true;
        await originalWrite.call(this, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
        throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
      }
      return originalWrite.call(this, buffer, offset, length, position);
    });
    try {
      await expect(
        logger.log({
          wrapper: "github",
          profile: "work",
          operation: "tools/call",
          name: "must-not-remain-after-partial-write",
          status: "success",
          durationMs: 2
        })
      ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    } finally {
      writeSpy.mockRestore();
    }

    expect(intercepted).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("keeps the rotated prior segment when the incoming retained write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-rotation-retention-failure-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { rotation: { maxBytes: 1, retainFiles: 0 } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-retained-rotation-failure",
      status: "success",
      durationMs: 1
    });

    const probe = await open(path, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { write: BufferWrite };
    const originalWrite = probe.write as BufferWrite;
    await probe.close();
    let intercepted = false;
    const writeSpy = vi.spyOn(fileHandlePrototype, "write").mockImplementation(async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null
    ) {
      if (!intercepted) {
        intercepted = true;
        await originalWrite.call(this, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
        throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
      }
      return originalWrite.call(this, buffer, offset, length, position);
    });
    try {
      await expect(
        logger.log({
          wrapper: "github",
          profile: "work",
          operation: "tools/call",
          name: "must-not-erase-the-prior-rotated-segment",
          status: "success",
          durationMs: 2
        })
      ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    } finally {
      writeSpy.mockRestore();
    }

    const segmentNames = (await readdir(directory))
      .filter((name) => name === "audit.jsonl" || name.startsWith("audit.jsonl.miftah-"))
      .sort();
    const records = (
      await Promise.all(segmentNames.map(async (name) => readFile(join(directory, name), "utf8")))
    )
      .flatMap((contents) => contents.trim().split("\n"))
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { name: string });

    expect(intercepted).toBe(true);
    expect(records).toEqual([expect.objectContaining({ name: "durable-before-retained-rotation-failure" })]);
  });
});
