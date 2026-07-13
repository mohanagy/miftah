import { followAuditJsonl, readAuditJsonl, type AuditJsonlWriter } from "./audit-jsonl.js";
import {
  asAuditJournalUnavailableError,
  isAuditJournalReaderFailure,
  snapshotAuditJournal,
  type AuditJournalSnapshot
} from "../audit/audit-journal.js";
import type { Writable } from "node:stream";
import { basename } from "node:path";
import { resolveRuntimeConfig } from "../runtime/resolve-runtime-config.js";
import { SecretRedactor } from "../secrets/redact.js";

export interface LogsCommandOptions {
  readonly configPath: string;
  readonly follow: boolean;
  readonly write?: AuditJsonlWriter;
  readonly pollIntervalMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createStdoutWriter(target: Writable = process.stdout): (chunk: string) => Promise<void> {
  return (chunk) =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      let writeReturned: boolean | undefined;
      let writeCompleted = false;
      let drained = false;
      let callbackErrorFallback: ReturnType<typeof setImmediate> | undefined;
      const cleanup = () => {
        if (callbackErrorFallback !== undefined) clearImmediate(callbackErrorFallback);
        target.removeListener("drain", onDrain);
        target.removeListener("error", onError);
      };
      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve();
        else reject(error);
      };
      const settleIfComplete = () => {
        if (writeReturned !== undefined && writeCompleted && (writeReturned || drained)) settle();
      };
      const onDrain = () => {
        drained = true;
        settleIfComplete();
      };
      const onError = (error: Error) => settle(error);
      const onWriteComplete = (error: Error | null | undefined) => {
        if (settled) return;
        if (error !== null && error !== undefined) {
          callbackErrorFallback = setImmediate(() => settle(error));
          return;
        }
        writeCompleted = true;
        settleIfComplete();
      };

      target.once("drain", onDrain);
      target.once("error", onError);
      try {
        writeReturned = target.write(chunk, onWriteComplete);
        settleIfComplete();
      } catch (error) {
        settle(error);
      }
    });
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

const defaultManagedPollIntervalMs = 250;
const minimumManagedPollIntervalMs = 10;
const maximumManagedPollIntervalMs = 1_000;

class ManagedAuditFollowAborted extends Error {}

function boundedManagedPollInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return defaultManagedPollIntervalMs;
  return Math.min(maximumManagedPollIntervalMs, Math.max(minimumManagedPollIntervalMs, Math.round(value)));
}

async function waitForManagedPoll(signal: AbortSignal, pollIntervalMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, pollIntervalMs);
    const abort = () => {
      clearTimeout(timeout);
      finish();
    };
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function writeManagedWithAbort(
  write: AuditJsonlWriter,
  chunk: string,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false;
  const writePromise = Promise.resolve(write(chunk));
  let removeAbortListener = () => {};
  const aborted = new Promise<false>((resolve) => {
    const abort = () => resolve(false);
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([writePromise.then(() => true), aborted]);
  } finally {
    removeAbortListener();
  }
}

function managedSegmentKey(
  segment: AuditJournalSnapshot["segments"][number],
  activeBasename: string
): string {
  if (segment.identity !== undefined) return `identity:${segment.identity}`;
  if (segment.name === activeBasename) return "active-without-identity";
  return `archive:${segment.name}`;
}

async function replayManagedSnapshotSegment(
  segment: AuditJournalSnapshot["segments"][number],
  previouslyEmittedRecords: number,
  redactor: SecretRedactor,
  write: AuditJsonlWriter,
  signal: AbortSignal
): Promise<number | undefined> {
  let pending = "";
  let recordCount = 0;
  try {
    await readAuditJsonl({
      path: segment.path,
      redactor,
      write: async (chunk) => {
        if (signal.aborted) throw new ManagedAuditFollowAborted();
        pending += chunk;
        let lineEnd = pending.indexOf("\n");
        while (lineEnd !== -1) {
          recordCount += 1;
          const line = pending.slice(0, lineEnd + 1);
          pending = pending.slice(lineEnd + 1);
          if (
            recordCount > previouslyEmittedRecords &&
            !(await writeManagedWithAbort(write, line, signal))
          ) {
            throw new ManagedAuditFollowAborted();
          }
          lineEnd = pending.indexOf("\n");
        }
      }
    });
  } catch (error) {
    if (error instanceof ManagedAuditFollowAborted && signal.aborted) return undefined;
    throw error;
  }
  if (pending.length > 0) throw new Error("Audit journal reader emitted an incomplete normalized record.");
  if (recordCount < previouslyEmittedRecords) {
    throw new Error("Audit journal segment changed while following.");
  }
  return recordCount;
}

async function followManagedAuditJournal(
  path: string,
  redactor: SecretRedactor,
  write: AuditJsonlWriter,
  signal: AbortSignal,
  configuredPollIntervalMs: number | undefined
): Promise<void> {
  const activeBasename = basename(path);
  const pollIntervalMs = boundedManagedPollInterval(configuredPollIntervalMs);
  const emittedRecordsBySegment = new Map<string, number>();
  while (!signal.aborted) {
    const snapshot = await snapshotAuditJournal(path, { allowEmpty: true });
    try {
      const nextEmittedRecords = new Map(emittedRecordsBySegment);
      const identitylessActiveKey = "active-without-identity";
      const priorIdentitylessActiveRecords = emittedRecordsBySegment.get(identitylessActiveKey);
      const hasNewIdentitylessArchive = snapshot.segments.some(
        (segment) =>
          segment.name !== activeBasename &&
          segment.identity === undefined &&
          !emittedRecordsBySegment.has(managedSegmentKey(segment, activeBasename))
      );
      if (priorIdentitylessActiveRecords !== undefined && priorIdentitylessActiveRecords > 0 && hasNewIdentitylessArchive) {
        // An archive can only be proved to be the prior active segment by a stable source identity. Without
        // one, retention may already have removed that segment and left a later archive at this path; copying
        // the old cursor would silently skip completed records from the surviving archive.
        throw new Error("Audit journal rotation cannot be followed safely without stable file identity.");
      }
      const currentSegmentKeys = new Set<string>();
      for (const segment of snapshot.segments) {
        if (signal.aborted) break;
        const key = managedSegmentKey(segment, activeBasename);
        if (currentSegmentKeys.has(key)) {
          throw new Error("Audit journal snapshot contains duplicate source identities.");
        }
        currentSegmentKeys.add(key);
        const recordCount = await replayManagedSnapshotSegment(
          segment,
          nextEmittedRecords.get(key) ?? 0,
          redactor,
          write,
          signal
        );
        if (recordCount === undefined) break;
        nextEmittedRecords.set(key, recordCount);
      }
      if (signal.aborted) continue;
      for (const key of nextEmittedRecords.keys()) {
        if (!currentSegmentKeys.has(key)) nextEmittedRecords.delete(key);
      }
      emittedRecordsBySegment.clear();
      for (const [key, recordCount] of nextEmittedRecords) emittedRecordsBySegment.set(key, recordCount);
    } finally {
      await snapshot.cleanup();
    }
    await waitForManagedPoll(signal, pollIntervalMs);
  }
}

async function followWithSignals(
  path: string,
  redactor: SecretRedactor,
  write: AuditJsonlWriter,
  pollIntervalMs: number | undefined,
  managed: boolean
): Promise<void> {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    if (managed) {
      await followManagedAuditJournal(path, redactor, write, controller.signal, pollIntervalMs);
    } else {
      await followAuditJsonl({ path, redactor, write, signal: controller.signal, pollIntervalMs });
    }
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

async function readManagedAuditJournal(
  path: string,
  redactor: SecretRedactor,
  write: AuditJsonlWriter
): Promise<void> {
  const snapshot = await snapshotAuditJournal(path);
  try {
    for (const segment of snapshot.segments) {
      await readAuditJsonl({ path: segment.path, redactor, write });
    }
  } finally {
    await snapshot.cleanup();
  }
}

async function runAuditJournalReader(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (isAuditJournalReaderFailure(error)) throw asAuditJournalUnavailableError(error);
    throw error;
  }
}

/** Runs a logs command without constructing an upstream or profile manager. */
export async function runLogsCommand(options: LogsCommandOptions): Promise<void> {
  let redactor: SecretRedactor | undefined;
  try {
    const resolved = await resolveRuntimeConfig(options.configPath);
    const resolvedRedactor = resolved.redactor;
    redactor = resolvedRedactor;
    const path = resolved.config.audit?.path;
    if (!path) throw new Error("Audit logging is not configured.");
    const write = options.write ?? createStdoutWriter();
    const managedJournal =
      resolved.config.audit?.rotation !== undefined || resolved.config.audit?.integrity !== undefined;
    await runAuditJournalReader(async () => {
      if (options.follow) {
        await followWithSignals(path, resolvedRedactor, write, options.pollIntervalMs, managedJournal);
      } else if (managedJournal) {
        await readManagedAuditJournal(path, resolvedRedactor, write);
      } else {
        await readAuditJsonl({ path, redactor: resolvedRedactor, write });
      }
    });
  } catch (error) {
    if (!redactor) throw error;
    const message = redactor.redactText(errorMessage(error));
    const cause = error instanceof Error ? redactErrorCause(error, redactor) : redactor.redactForAudit(error);
    // eslint-disable-next-line preserve-caught-error -- The original error can carry configured secrets.
    throw new Error(message, { cause });
  }
}
