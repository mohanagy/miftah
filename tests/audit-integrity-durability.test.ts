import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit/audit-logger.js";
import { verifyAuditJournal } from "../src/audit/audit-journal.js";

describe("audit integrity durability integration", () => {
  it("persists one verifiable integrity record through the real file sync boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-integrity-durability-"));
    const path = join(directory, "audit.jsonl");
    try {
      const logger = new AuditLogger(path, {
        integrity: { algorithm: "sha256-chain" }
      });
      await logger.log({
        wrapper: "github",
        profile: "work",
        operation: "tools/call",
        name: "real-durability-integrity-event",
        status: "success",
        durationMs: 1
      });

      expect(await verifyAuditJournal(path)).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toContain("real-durability-integrity-event");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
