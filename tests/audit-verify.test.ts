import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit/audit-logger.js";
import { runAuditVerifyCommand } from "../src/cli/audit-verify.js";

describe("audit verification command", () => {
  it("returns the first safe integrity break without reading an upstream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-verify-"));
    const configPath = join(directory, "miftah.json");
    const auditPath = join(directory, "audit.jsonl");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "audit-verify-test",
        defaultProfile: "default",
        upstream: { transport: "stdio", command: process.execPath },
        profiles: { default: {} },
        audit: { path: "audit.jsonl", integrity: { algorithm: "sha256-chain" } }
      })
    );
    const logger = new AuditLogger(auditPath, { integrity: { algorithm: "sha256-chain" } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "first-verified-event",
      status: "success",
      durationMs: 1
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "second-verified-event",
      status: "success",
      durationMs: 2
    });

    expect(await runAuditVerifyCommand({ configPath })).toEqual({ ok: true });

    const records = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    records[1] = { ...records[1], name: "tampered-verify-event" };
    await writeFile(auditPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    expect(await runAuditVerifyCommand({ configPath })).toEqual({
      ok: false,
      firstBroken: { segment: "audit.jsonl", record: 2, reason: "HASH_MISMATCH" }
    });
  });

  it("does not create a missing audit parent and reports only a safe unavailable segment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-verify-missing-"));
    const missingDirectory = join(directory, "private-audit-parent");
    const configPath = join(directory, "miftah.json");
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          version: "1",
          name: "audit-verify-missing-test",
          defaultProfile: "default",
          upstream: { transport: "stdio", command: process.execPath },
          profiles: { default: {} },
          audit: {
            path: "private-audit-parent/events.jsonl",
            integrity: { algorithm: "sha256-chain" }
          }
        })
      );

      const report = await runAuditVerifyCommand({ configPath });

      expect(report).toEqual({
        ok: false,
        firstBroken: { segment: "events.jsonl", record: 1, reason: "SEGMENT_UNAVAILABLE" }
      });
      expect(JSON.stringify(report)).not.toContain(missingDirectory);
      await expect(lstat(missingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
