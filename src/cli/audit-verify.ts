import { basename } from "node:path";
import { verifyAuditJournal, type AuditIntegrityReport } from "../audit/audit-journal.js";
import { loadConfig } from "../config/load-config.js";

export interface AuditVerifyCommandOptions {
  readonly configPath: string;
}

/** Verifies configured retained audit segments without starting or resolving an upstream. */
export async function runAuditVerifyCommand(options: AuditVerifyCommandOptions): Promise<AuditIntegrityReport> {
  const config = await loadConfig(options.configPath);
  const path = config.audit?.path;
  if (!path) throw new Error("Audit logging is not configured.");
  if (config.audit?.integrity === undefined) {
    return {
      ok: false,
      firstBroken: { segment: basename(path), record: 1, reason: "INTEGRITY_NOT_CONFIGURED" }
    };
  }
  return verifyAuditJournal(path);
}

/** Renders a safe human report containing no audit bytes, hashes, or absolute paths. */
export function formatAuditVerifyReport(report: AuditIntegrityReport): string {
  if (report.ok) return "Audit integrity verified.";
  const firstBroken = report.firstBroken;
  if (firstBroken === undefined) return "Audit integrity could not be verified.";
  return `Audit integrity failed: ${firstBroken.reason} at ${firstBroken.segment} record ${firstBroken.record}.`;
}
