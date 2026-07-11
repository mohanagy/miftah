import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/audit/audit-logger.js";

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
});
