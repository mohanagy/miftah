import { createHash } from "node:crypto";
import { copyFile, link, mkdtemp, open, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/audit/audit-logger.js";
import { verifyAuditJournal } from "../src/audit/audit-journal.js";

type BufferWrite = (
  this: FileHandle,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | null
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

interface IntegrityCheckpointFixture {
  readonly stateHash: string;
  readonly ledgerSize: number;
  readonly ledgerHash: string;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Transaction fixture is not JSON-safe.");
}

function checkpointFixture(contents: string): IntegrityCheckpointFixture {
  const parsed = JSON.parse(contents) as Partial<IntegrityCheckpointFixture>;
  if (
    typeof parsed.stateHash !== "string" ||
    typeof parsed.ledgerHash !== "string" ||
    typeof parsed.ledgerSize !== "number"
  ) {
    throw new Error("Integrity checkpoint fixture is invalid.");
  }
  return { stateHash: parsed.stateHash, ledgerHash: parsed.ledgerHash, ledgerSize: parsed.ledgerSize };
}

function transactionWithHash(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    transactionHash: createHash("sha256")
      .update("miftah-audit-integrity-transaction-v1\u0000", "utf8")
      .update(canonicalJson(payload), "utf8")
      .digest("hex")
  };
}

describe("audit journal integrity", () => {
  it("skips a Windows-reserved local lock port before writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-reserved-lock-port-"));
    const path = join(directory, "audit.jsonl");
    const serverPrototype = Object.getPrototypeOf(createServer()) as {
      listen: (
        this: Server,
        options: { host: string; port: number; exclusive: boolean },
        callback?: () => void
      ) => Server;
    };
    const originalListen = serverPrototype.listen;
    let listenAttempts = 0;
    const listenSpy = vi.spyOn(serverPrototype, "listen").mockImplementation(function (
      this: Server,
      options: { host: string; port: number; exclusive: boolean },
      callback?: () => void
    ) {
      listenAttempts += 1;
      if (listenAttempts === 1) {
        queueMicrotask(() => this.emit("error", Object.assign(new Error("reserved port"), { code: "EACCES" })));
        return this;
      }
      return originalListen.call(this, options, callback);
    });

    try {
      const logger = new AuditLogger(path, { integrity: { algorithm: "sha256-chain" } });
      await expect(logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "writes-after-reserved-lock-port",
        status: "success",
        durationMs: 1
      })).resolves.toBeUndefined();
      expect(listenAttempts).toBeGreaterThanOrEqual(2);
    } finally {
      listenSpy.mockRestore();
    }
  });

  it("identifies the first tampered chained record without returning record content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { integrity: { algorithm: "sha256-chain" } });

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "first-integrity-event",
      status: "success",
      durationMs: 1
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "second-integrity-event",
      status: "success",
      durationMs: 2
    });

    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ schemaVersion: 1 })]));
    records[1] = { ...records[1], schemaVersion: 2 };
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    expect(await verifyAuditJournal(path)).toEqual({
      ok: false,
      firstBroken: { segment: "audit.jsonl", record: 2, reason: "HASH_MISMATCH" }
    });
  });

  it("fails closed instead of appending after a corrupt prior integrity record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-corrupt-"));
    const path = join(directory, "audit.jsonl");
    await writeFile(path, '{"name":"legacy-without-integrity"}\n');
    const logger = new AuditLogger(path, { integrity: { algorithm: "sha256-chain" } });

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-append",
        status: "success",
        durationMs: 1
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });

    expect(await readFile(path, "utf8")).toBe('{"name":"legacy-without-integrity"}\n');
  });

  it("fails closed when an interior integrity record is changed without changing its byte length", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-interior-corrupt-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { integrity: { algorithm: "sha256-chain" } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "first-interior-event",
      status: "success",
      durationMs: 1
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "second-interior-event",
      status: "success",
      durationMs: 2
    });
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    records[0] = { ...records[0], durationMs: 9 };
    const corrupted = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    expect(Buffer.byteLength(corrupted, "utf8")).toBe(Buffer.byteLength(await readFile(path, "utf8"), "utf8"));
    await writeFile(path, corrupted);

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-append-after-interior-corruption",
        status: "success",
        durationMs: 3
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    expect(await readFile(path, "utf8")).toBe(corrupted);
  });

  it("fails closed when a retained archived integrity segment is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-archive-corrupt-"));
    const path = join(directory, "audit.jsonl");
    const first = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 4 }
    });
    await first.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "archived-integrity-event",
      status: "success",
      durationMs: 1
    });
    await first.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "active-integrity-event",
      status: "success",
      durationMs: 2
    });
    const archive = (await readdir(directory)).find((name) => name.startsWith("audit.jsonl.miftah-"));
    if (archive === undefined) throw new Error("Expected a managed archived audit segment.");
    const archivedRecords = (await readFile(join(directory, archive), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    archivedRecords[0] = { ...archivedRecords[0], name: "tampered-archived-integrity-event" };
    await writeFile(join(directory, archive), `${archivedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const second = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 4 }
    });

    await expect(
      second.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-append-after-archive-tamper",
        status: "success",
        durationMs: 3
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
  });

  it("identifies the first retained boundary when a middle rotated segment is removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-missing-segment-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 4 }
    });

    for (const [index, name] of ["first-segment-event", "second-segment-event", "active-segment-event"].entries()) {
      await logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name,
        status: "success",
        durationMs: index + 1
      });
    }

    const archives = (await readdir(directory))
      .filter((name) => name.startsWith("audit.jsonl.miftah-"))
      .sort();
    expect(archives).toHaveLength(2);
    await unlink(join(directory, archives[0]!));

    await expect(verifyAuditJournal(path)).resolves.toMatchObject({ ok: false });
  });

  it("fails safely when a retained archive is replaced by a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-archive-symlink-"));
    const directory = join(root, "audit");
    const path = join(directory, "audit.jsonl");
    const sentinel = join(root, "outside-sentinel.jsonl");
    const logger = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 4 }
    });

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "symlink-archived-event",
      status: "success",
      durationMs: 1
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "symlink-active-event",
      status: "success",
      durationMs: 2
    });
    const archive = (await readdir(directory)).find((name) => name.startsWith("audit.jsonl.miftah-"));
    if (archive === undefined) throw new Error("Expected an archived integrity segment.");
    await writeFile(sentinel, "outside data");
    await unlink(join(directory, archive));
    await symlink(sentinel, join(directory, archive));

    await expect(verifyAuditJournal(path)).resolves.toMatchObject({ ok: false });
    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-append-after-archive-symlink",
        status: "success",
        durationMs: 3
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    expect(await readFile(sentinel, "utf8")).toBe("outside data");
  });

  it("fails safely when a retained archive is replaced by a hard link", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-archive-hard-link-"));
    const directory = join(root, "audit");
    const path = join(directory, "audit.jsonl");
    const sentinel = join(root, "outside-sentinel.jsonl");
    const logger = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 4 }
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "hard-link-archived-event",
      status: "success",
      durationMs: 1
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "hard-link-active-event",
      status: "success",
      durationMs: 2
    });
    const archive = (await readdir(directory)).find((name) => name.startsWith("audit.jsonl.miftah-"));
    if (archive === undefined) throw new Error("Expected an archived integrity segment.");
    await writeFile(sentinel, "outside data");
    await unlink(join(directory, archive));
    await link(sentinel, join(directory, archive));

    await expect(verifyAuditJournal(path)).resolves.toMatchObject({ ok: false });
    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-append-after-archive-hard-link",
        status: "success",
        durationMs: 3
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    expect(await readFile(sentinel, "utf8")).toBe("outside data");
  });

  it("detects a retained archive that is renamed outside the integrity ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-archive-rename-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 4 }
    });

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "rename-archived-event",
      status: "success",
      durationMs: 1
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "rename-active-event",
      status: "success",
      durationMs: 2
    });
    const archive = (await readdir(directory)).find((name) => name.startsWith("audit.jsonl.miftah-"));
    if (archive === undefined) throw new Error("Expected an archived integrity segment.");
    await rename(join(directory, archive), join(directory, `${archive}.moved`));

    await expect(verifyAuditJournal(path)).resolves.toMatchObject({
      ok: false,
      firstBroken: { segment: archive, reason: "SEGMENT_UNAVAILABLE" }
    });
  });

  it("identifies the first broken retained archive after archive contents are reordered", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-archive-reorder-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 4 }
    });

    for (const [index, name] of ["first-reordered-event", "second-reordered-event", "active-reordered-event"].entries()) {
      await logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name,
        status: "success",
        durationMs: index + 1
      });
    }
    const archives = (await readdir(directory))
      .filter((name) => name.startsWith("audit.jsonl.miftah-"))
      .sort();
    if (archives.length !== 2) throw new Error("Expected two archived integrity segments.");
    const temporaryPath = join(directory, "archive-swap-temporary");
    await rename(join(directory, archives[0]!), temporaryPath);
    await rename(join(directory, archives[1]!), join(directory, archives[0]!));
    await rename(temporaryPath, join(directory, archives[1]!));

    await expect(verifyAuditJournal(path)).resolves.toEqual({
      ok: false,
      firstBroken: { segment: archives[0], record: 1, reason: "PREVIOUS_HASH_MISMATCH" }
    });
  });

  it("compacts integrity metadata when retention removes every rotated archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-retention-bound-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 0 }
    });

    // Three records force two complete rotate, retire, and compact cycles. That is the minimum
    // repeated fixture needed to prove compaction remains bounded across successive rotations.
    for (let index = 0; index < 3; index += 1) {
      await logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: `retained-metadata-bound-${index}`,
        status: "success",
        durationMs: index
      });
    }

    const ledger = (await readdir(directory)).find((name) => name === ".audit.jsonl.miftah-integrity.jsonl");
    if (ledger === undefined) throw new Error("Expected an integrity ledger.");
    expect((await readFile(join(directory, ledger), "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await readdir(directory)).filter((name) => name.startsWith("audit.jsonl.miftah-")).length).toBe(0);
    expect(await verifyAuditJournal(path)).toEqual({ ok: true });
  });

  it("recovers after a rotated integrity write fails before the new active record commits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-rotation-rollback-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 0 }
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-integrity-rotation-failure",
      status: "success",
      durationMs: 1
    });

    const probe = await open(path, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { write: BufferWrite };
    const originalWrite = probe.write as BufferWrite;
    await probe.close();
    let writes = 0;
    const writeSpy = vi.spyOn(fileHandlePrototype, "write").mockImplementation(async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null
    ) {
      writes += 1;
      if (writes === 5) {
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
          name: "must-not-commit-after-integrity-rotation-failure",
          status: "success",
          durationMs: 2
        })
      ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    } finally {
      writeSpy.mockRestore();
    }

    const retainedSegments = (await readdir(directory)).filter(
      (name) => name === "audit.jsonl" || name.startsWith("audit.jsonl.miftah-")
    );
    const retainedRecords = (
      await Promise.all(retainedSegments.map(async (name) => readFile(join(directory, name), "utf8")))
    )
      .flatMap((contents) => contents.trim().split("\n"))
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { name: string });
    expect(retainedRecords).toEqual([expect.objectContaining({ name: "durable-before-integrity-rotation-failure" })]);

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "succeeds-after-integrity-rotation-rollback",
        status: "success",
        durationMs: 3
      })
    ).resolves.toBeUndefined();
    expect(await verifyAuditJournal(path)).toEqual({ ok: true });
  });

  it("restores the prior integrity ledger when checkpoint replacement fails during compaction", async () => {
    let stage = "creating fixture";
    let writes = 0;
    const timeoutDiagnostic = setTimeout(() => {
      process.stderr.write(
        `MIFTAH_AUDIT_INTEGRITY_TIMEOUT_DIAGNOSTIC: stage=${stage}; interceptedWrites=${writes}\n`
      );
    }, 4_500);
    timeoutDiagnostic.unref();

    try {
      const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-compaction-rollback-"));
      const path = join(directory, "audit.jsonl");
      const logger = new AuditLogger(path, {
        integrity: { algorithm: "sha256-chain" },
        rotation: { maxBytes: 1, retainFiles: 2 }
      });
      stage = "writing initial record";
      await logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "durable-before-compaction-checkpoint-failure",
        status: "success",
        durationMs: 1
      });

      stage = "opening write probe";
      const probe = await open(path, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probe) as { write: BufferWrite };
      const originalWrite = probe.write as BufferWrite;
      stage = "closing write probe";
      await probe.close();
      stage = "installing write spy";
      const writeSpy = vi.spyOn(fileHandlePrototype, "write").mockImplementation(async function (
        this: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | null
      ) {
        writes += 1;
        if (writes === 2) throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
        return originalWrite.call(this, buffer, offset, length, position);
      });
      try {
        stage = "writing replacement checkpoint";
        await expect(
          logger.log({
            wrapper: "github",
            profile: "work",
            operation: "tools/call",
            name: "must-not-leave-a-new-ledger-with-an-old-checkpoint",
            status: "success",
            durationMs: 2
          })
        ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
      } finally {
        stage = "restoring write spy";
        writeSpy.mockRestore();
      }

      stage = "verifying rollback";
      expect(await verifyAuditJournal(path)).toEqual({ ok: true });
      stage = "writing recovery record";
      await expect(
        logger.log({
          wrapper: "github",
          profile: "work",
          operation: "tools/call",
          name: "succeeds-after-compaction-checkpoint-rollback",
          status: "success",
          durationMs: 3
        })
      ).resolves.toBeUndefined();
      stage = "verifying recovery";
      expect(await verifyAuditJournal(path)).toEqual({ ok: true });
    } finally {
      clearTimeout(timeoutDiagnostic);
    }
  });

  it("rejects an oversized integrity record before changing the retained journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-record-limit-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, {
      includeArguments: true,
      integrity: { algorithm: "sha256-chain" }
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-integrity-record-limit",
      status: "success",
      durationMs: 1
    });
    const journalBefore = await readFile(path, "utf8");
    const ledgerPath = join(directory, ".audit.jsonl.miftah-integrity.jsonl");
    const checkpointPath = join(directory, ".audit.jsonl.miftah-integrity-state.json");
    const ledgerBefore = await readFile(ledgerPath, "utf8");
    const checkpointBefore = await readFile(checkpointPath, "utf8");

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-write-an-unverifiable-integrity-record",
        status: "success",
        durationMs: 2,
        arguments: { payload: "x".repeat(1_100_000) }
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });

    expect(await readFile(path, "utf8")).toBe(journalBefore);
    expect(await readFile(ledgerPath, "utf8")).toBe(ledgerBefore);
    expect(await readFile(checkpointPath, "utf8")).toBe(checkpointBefore);
  });

  it("keeps committed integrity events verifiable when post-commit retention metadata cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-retention-metadata-failure-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, {
      integrity: { algorithm: "sha256-chain" },
      rotation: { maxBytes: 1, retainFiles: 0 }
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-retention-metadata-failure",
      status: "success",
      durationMs: 1
    });

    const probe = await open(path, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { write: BufferWrite };
    const originalWrite = probe.write as BufferWrite;
    await probe.close();
    let retentionCheckpointWrites = 0;
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fileHandlePrototype, "write").mockImplementation(async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null
    ) {
      if (Buffer.from(buffer).toString("utf8").includes('"kind":"checkpoint"')) {
        retentionCheckpointWrites += 1;
        if (retentionCheckpointWrites === 2) throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
      }
      return originalWrite.call(this, buffer, offset, length, position);
    });
    try {
      await expect(
        logger.log({
          wrapper: "github",
          profile: "work",
          operation: "tools/call",
          name: "committed-before-retention-metadata-failure",
          status: "success",
          durationMs: 2
        })
      ).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        "Miftah audit retention cleanup could not be completed after a committed audit event."
      );
    } finally {
      writeSpy.mockRestore();
      warning.mockRestore();
    }

    expect(retentionCheckpointWrites).toBe(2);
    const segments = (await readdir(directory)).filter(
      (name) => name === "audit.jsonl" || name.startsWith("audit.jsonl.miftah-")
    );
    const names = (
      await Promise.all(segments.map(async (name) => readFile(join(directory, name), "utf8")))
    )
      .flatMap((contents) => contents.trim().split("\n"))
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { name: string }).name)
      .sort();
    expect(names).toEqual([
      "committed-before-retention-metadata-failure",
      "durable-before-retention-metadata-failure"
    ]);
    expect(await verifyAuditJournal(path)).toEqual({ ok: true });
  });

  it("recovers a verified pre-marker checkpoint backup left by an interrupted transaction start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-orphan-backup-"));
    const path = join(directory, "audit.jsonl");
    const statePath = join(directory, ".audit.jsonl.miftah-integrity-state.json");
    const backupPath = join(directory, ".audit.jsonl.miftah-integrity-prior-state.json");
    const logger = new AuditLogger(path, { integrity: { algorithm: "sha256-chain" } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-orphan-backup-recovery",
      status: "success",
      durationMs: 1
    });

    await link(statePath, backupPath);

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "succeeds-after-orphan-backup-recovery",
        status: "success",
        durationMs: 2
      })
    ).resolves.toBeUndefined();
    expect(await readdir(directory)).not.toContain(".audit.jsonl.miftah-integrity-prior-state.json");
    expect(await verifyAuditJournal(path)).toEqual({ ok: true });
  });

  it("recovers a rotation interrupted after renaming the active segment but before creating its successor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-rotation-crash-"));
    const path = join(directory, "audit.jsonl");
    const statePath = join(directory, ".audit.jsonl.miftah-integrity-state.json");
    const backupPath = join(directory, ".audit.jsonl.miftah-integrity-prior-state.json");
    const transactionPath = join(directory, ".audit.jsonl.miftah-integrity-transaction.json");
    const logger = new AuditLogger(path, { integrity: { algorithm: "sha256-chain" } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-rotation-crash-recovery",
      status: "success",
      durationMs: 1
    });
    const prior = checkpointFixture(await readFile(statePath, "utf8"));
    const sequence = "00000000000000000001";
    const archive = `audit.jsonl.miftah-${sequence}-00000000-0000-4000-8000-000000000000`;
    await link(statePath, backupPath);
    await writeFile(
      transactionPath,
      JSON.stringify(
        transactionWithHash({
          version: 1,
          kind: "rotate",
          phase: "pending",
          priorStateHash: prior.stateHash,
          priorLedgerSize: prior.ledgerSize,
          priorLedgerHash: prior.ledgerHash,
          nextStateHash: "a".repeat(64),
          nextLedgerSize: 1,
          nextLedgerHash: "b".repeat(64),
          archive: { name: archive, sequence }
        })
      ),
      { mode: 0o600 }
    );
    await rename(path, join(directory, archive));

    await expect(verifyAuditJournal(path)).resolves.toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toContain("durable-before-rotation-crash-recovery");
    expect(await readdir(directory)).not.toEqual(
      expect.arrayContaining([
        archive,
        ".audit.jsonl.miftah-integrity-prior-state.json",
        ".audit.jsonl.miftah-integrity-transaction.json"
      ])
    );
  });

  it("rolls metadata back after an append crashes before its active integrity record commits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-append-crash-"));
    const futureDirectory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-append-future-"));
    const path = join(directory, "audit.jsonl");
    const futurePath = join(futureDirectory, "audit.jsonl");
    const ledgerName = ".audit.jsonl.miftah-integrity.jsonl";
    const stateName = ".audit.jsonl.miftah-integrity-state.json";
    const transactionName = ".audit.jsonl.miftah-integrity-transaction.json";
    const backupName = ".audit.jsonl.miftah-integrity-prior-state.json";
    const ledgerPath = join(directory, ledgerName);
    const statePath = join(directory, stateName);
    const logger = new AuditLogger(path, { integrity: { algorithm: "sha256-chain" } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-append-crash-recovery",
      status: "success",
      durationMs: 1
    });
    const activeBefore = await readFile(path, "utf8");
    const ledgerBefore = await readFile(ledgerPath, "utf8");
    const stateBefore = await readFile(statePath, "utf8");
    const prior = checkpointFixture(stateBefore);

    await copyFile(path, futurePath);
    await copyFile(ledgerPath, join(futureDirectory, ledgerName));
    await copyFile(statePath, join(futureDirectory, stateName));
    const futureLogger = new AuditLogger(futurePath, { integrity: { algorithm: "sha256-chain" } });
    await futureLogger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "must-not-survive-append-crash-recovery",
      status: "success",
      durationMs: 2
    });
    const ledgerAfter = await readFile(join(futureDirectory, ledgerName), "utf8");
    const stateAfter = await readFile(join(futureDirectory, stateName), "utf8");
    const next = checkpointFixture(stateAfter);

    await link(statePath, join(directory, backupName));
    await writeFile(ledgerPath, ledgerAfter);
    const replacementState = join(directory, ".replacement-integrity-state.json");
    await writeFile(replacementState, stateAfter, { mode: 0o600 });
    await rename(replacementState, statePath);
    await writeFile(
      join(directory, transactionName),
      JSON.stringify(
        transactionWithHash({
          version: 1,
          kind: "append",
          phase: "pending",
          priorStateHash: prior.stateHash,
          priorLedgerSize: prior.ledgerSize,
          priorLedgerHash: prior.ledgerHash,
          nextStateHash: next.stateHash,
          nextLedgerSize: next.ledgerSize,
          nextLedgerHash: next.ledgerHash
        })
      ),
      { mode: 0o600 }
    );
    await writeFile(path, '{"partial-in-flight-record":', { flag: "a" });

    await expect(verifyAuditJournal(path)).resolves.toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe(activeBefore);
    expect(await readFile(ledgerPath, "utf8")).toBe(ledgerBefore);
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "succeeds-after-append-crash-recovery",
        status: "success",
        durationMs: 3
      })
    ).resolves.toBeUndefined();
    expect(await verifyAuditJournal(path)).toEqual({ ok: true });
  });

  it("never rolls back an acknowledged append when committed transaction cleanup was interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-committed-marker-"));
    const futureDirectory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-committed-marker-future-"));
    const path = join(directory, "audit.jsonl");
    const futurePath = join(futureDirectory, "audit.jsonl");
    const ledgerName = ".audit.jsonl.miftah-integrity.jsonl";
    const stateName = ".audit.jsonl.miftah-integrity-state.json";
    const transactionName = ".audit.jsonl.miftah-integrity-transaction.json";
    const backupName = ".audit.jsonl.miftah-integrity-prior-state.json";
    const ledgerPath = join(directory, ledgerName);
    const statePath = join(directory, stateName);
    const logger = new AuditLogger(path, { integrity: { algorithm: "sha256-chain" } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-committed-marker-corruption",
      status: "success",
      durationMs: 1
    });
    const activeBefore = await readFile(path, "utf8");
    const ledgerBefore = await readFile(ledgerPath, "utf8");
    const stateBefore = await readFile(statePath, "utf8");
    const prior = checkpointFixture(stateBefore);

    await copyFile(path, futurePath);
    await copyFile(ledgerPath, join(futureDirectory, ledgerName));
    await copyFile(statePath, join(futureDirectory, stateName));
    const futureLogger = new AuditLogger(futurePath, { integrity: { algorithm: "sha256-chain" } });
    await futureLogger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "acknowledged-before-marker-cleanup-interruption",
      status: "success",
      durationMs: 2
    });
    const ledgerAfter = await readFile(join(futureDirectory, ledgerName), "utf8");
    const stateAfter = await readFile(join(futureDirectory, stateName), "utf8");
    const next = checkpointFixture(stateAfter);
    await writeFile(ledgerPath, ledgerAfter);
    const replacementState = join(directory, ".replacement-committed-integrity-state.json");
    await writeFile(replacementState, stateAfter, { mode: 0o600 });
    await rename(replacementState, statePath);
    await writeFile(path, activeBefore);
    await writeFile(join(directory, backupName), stateBefore, { mode: 0o600 });
    await writeFile(
      join(directory, transactionName),
      JSON.stringify(
        transactionWithHash({
          version: 1,
          kind: "append",
          phase: "committed",
          priorStateHash: prior.stateHash,
          priorLedgerSize: prior.ledgerSize,
          priorLedgerHash: prior.ledgerHash,
          nextStateHash: next.stateHash,
          nextLedgerSize: next.ledgerSize,
          nextLedgerHash: next.ledgerHash
        })
      ),
      { mode: 0o600 }
    );

    await expect(verifyAuditJournal(path)).resolves.toMatchObject({ ok: false });
    expect(await readFile(ledgerPath, "utf8")).toBe(ledgerAfter);
    expect(await readFile(statePath, "utf8")).toBe(stateAfter);
    expect(await readdir(directory)).toContain(transactionName);
    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-rewrite-an-acknowledged-integrity-transaction",
        status: "success",
        durationMs: 3
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    expect(await readFile(ledgerPath, "utf8")).toBe(ledgerAfter);
    expect(await readFile(statePath, "utf8")).toBe(stateAfter);
    expect(ledgerBefore).not.toBe(ledgerAfter);
  });

  it("truncates a pending partial ledger append before it can strand a recoverable journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-partial-ledger-"));
    const path = join(directory, "audit.jsonl");
    const ledgerPath = join(directory, ".audit.jsonl.miftah-integrity.jsonl");
    const statePath = join(directory, ".audit.jsonl.miftah-integrity-state.json");
    const backupPath = join(directory, ".audit.jsonl.miftah-integrity-prior-state.json");
    const transactionPath = join(directory, ".audit.jsonl.miftah-integrity-transaction.json");
    const logger = new AuditLogger(path, { integrity: { algorithm: "sha256-chain" } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-partial-ledger-recovery",
      status: "success",
      durationMs: 1
    });
    const prior = checkpointFixture(await readFile(statePath, "utf8"));
    const ledgerBefore = await readFile(ledgerPath, "utf8");
    await link(statePath, backupPath);
    await writeFile(
      transactionPath,
      JSON.stringify(
        transactionWithHash({
          version: 1,
          kind: "append",
          phase: "pending",
          priorStateHash: prior.stateHash,
          priorLedgerSize: prior.ledgerSize,
          priorLedgerHash: prior.ledgerHash,
          nextStateHash: "a".repeat(64),
          nextLedgerSize: prior.ledgerSize + 1,
          nextLedgerHash: "b".repeat(64)
        })
      ),
      { mode: 0o600 }
    );
    await writeFile(ledgerPath, '{"partial-ledger-entry":', { flag: "a" });

    await expect(verifyAuditJournal(path)).resolves.toEqual({ ok: true });
    expect(await readFile(ledgerPath, "utf8")).toBe(ledgerBefore);
    expect(await readdir(directory)).not.toEqual(
      expect.arrayContaining([
        ".audit.jsonl.miftah-integrity-prior-state.json",
        ".audit.jsonl.miftah-integrity-transaction.json"
      ])
    );
  });

  it("fails closed before appending when an earlier integrity ledger entry is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-interior-ledger-"));
    const path = join(directory, "audit.jsonl");
    const ledgerPath = join(directory, ".audit.jsonl.miftah-integrity.jsonl");
    const checkpointPath = join(directory, ".audit.jsonl.miftah-integrity-state.json");
    const logger = new AuditLogger(path, { integrity: { algorithm: "sha256-chain" } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "durable-before-interior-ledger-corruption",
      status: "success",
      durationMs: 1
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "second-durable-before-interior-ledger-corruption",
      status: "success",
      durationMs: 2
    });

    const activeBefore = await readFile(path, "utf8");
    const checkpointBefore = await readFile(checkpointPath, "utf8");
    const ledgerBefore = await readFile(ledgerPath, "utf8");
    const corruptLedger = ledgerBefore.replace('"kind":"initialize"', '"kind":"initialise"');
    expect(corruptLedger).not.toBe(ledgerBefore);
    expect(Buffer.byteLength(corruptLedger, "utf8")).toBe(Buffer.byteLength(ledgerBefore, "utf8"));
    await writeFile(ledgerPath, corruptLedger);

    await expect(
      logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "must-not-append-after-interior-ledger-corruption",
        status: "success",
        durationMs: 3
      })
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });

    expect(await readFile(path, "utf8")).toBe(activeBefore);
    expect(await readFile(ledgerPath, "utf8")).toBe(corruptLedger);
    expect(await readFile(checkpointPath, "utf8")).toBe(checkpointBefore);
  });
});
