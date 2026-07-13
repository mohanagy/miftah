import { chmod, link, lstat, mkdir, mkdtemp, open, rm, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { snapshotAuditJournal } from "../audit/audit-journal.js";
import { resolveRuntimeConfig } from "../runtime/resolve-runtime-config.js";
import { SecretRedactor } from "../secrets/redact.js";
import { readAuditJsonl } from "./audit-jsonl.js";

export interface AuditExportCommandOptions {
  readonly configPath: string;
  readonly outputPath: string;
  readonly includeArguments: boolean;
}

interface AuditExportStaging {
  readonly directory: string;
  readonly path: string;
  readonly handle: FileHandle;
  closed: boolean;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function assertExclusiveOutputPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  throw new Error("Audit export destination already exists.");
}

async function createStagingFile(outputPath: string): Promise<AuditExportStaging> {
  const outputDirectory = dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await assertExclusiveOutputPath(outputPath);
  const directory = await mkdtemp(join(outputDirectory, ".miftah-audit-export-"));
  let handle: FileHandle | undefined;
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "export.jsonl");
    handle = await open(path, "wx", 0o600);
    await chmod(path, 0o600);
    return { directory, path, handle, closed: false };
  } catch (error) {
    try {
      await handle?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

async function writeAll(handle: FileHandle, chunk: string): Promise<void> {
  const bytes = Buffer.from(chunk, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten <= 0) throw new Error("Audit export write made no progress.");
    offset += bytesWritten;
  }
}

async function publishStagingFile(staging: AuditExportStaging, outputPath: string): Promise<void> {
  await staging.handle.sync();
  await closeStagingHandle(staging);
  await link(staging.path, outputPath);
  await unlink(staging.path);
  await rm(staging.directory, { recursive: true, force: true });
}

async function closeStagingHandle(staging: AuditExportStaging): Promise<void> {
  if (staging.closed) return;
  await staging.handle.close();
  staging.closed = true;
}

async function discardStagingFile(staging: AuditExportStaging | undefined): Promise<void> {
  if (staging === undefined) return;
  try {
    await closeStagingHandle(staging);
  } finally {
    await rm(staging.directory, { recursive: true, force: true });
  }
}

function redactErrorCause(error: Error, redactor: SecretRedactor, seen = new Set<Error>()): Error {
  if (seen.has(error)) return error;
  seen.add(error);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(error))) {
    if (!("value" in descriptor)) continue;
    const value = descriptor.value;
    const redacted =
      value instanceof Error
        ? redactErrorCause(value, redactor, seen)
        : typeof value === "string"
          ? redactor.redactText(value)
          : redactor.redactForAudit(value);
    if (redacted === value) continue;
    try {
      Object.defineProperty(error, key, { ...descriptor, value: redacted });
    } catch {
      // A non-configurable third-party error property cannot be safely retained as a cause.
      return new Error(redactor.redactText(error.message));
    }
  }
  return error;
}

function redactFailure(error: unknown, redactor: SecretRedactor | undefined): Error | unknown {
  if (redactor === undefined) return error;
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? redactErrorCause(error, redactor) : redactor.redactForAudit(error);
  return new Error(redactor.redactText(message), { cause });
}

/** Writes a private, redacted support export without copying raw audit bytes or overwriting a destination. */
export async function runAuditExportCommand(options: AuditExportCommandOptions): Promise<void> {
  let redactor: SecretRedactor | undefined;
  let snapshot: Awaited<ReturnType<typeof snapshotAuditJournal>> | undefined;
  let staging: AuditExportStaging | undefined;
  try {
    const resolved = await resolveRuntimeConfig(options.configPath);
    redactor = resolved.redactor;
    const auditPath = resolved.config.audit?.path;
    if (!auditPath) throw new Error("Audit logging is not configured.");
    snapshot = await snapshotAuditJournal(auditPath);
    staging = await createStagingFile(options.outputPath);
    const activeStaging = staging;
    for (const segment of snapshot.segments) {
      await readAuditJsonl({
        path: segment.path,
        redactor,
        includeArguments: options.includeArguments,
        write: (chunk) => writeAll(activeStaging.handle, chunk)
      });
    }
    await publishStagingFile(activeStaging, options.outputPath);
    staging = undefined;
  } catch (error) {
    throw redactFailure(error, redactor);
  } finally {
    try {
      await discardStagingFile(staging);
    } finally {
      await snapshot?.cleanup();
    }
  }
}
