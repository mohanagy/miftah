import { followAuditJsonl, readAuditJsonl, type AuditJsonlWriter } from "./audit-jsonl.js";
import type { Writable } from "node:stream";
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
      const cleanup = () => {
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
        if (error !== null && error !== undefined) {
          // Writable invokes its callback before emitting the corresponding error event.
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

async function followWithSignals(
  path: string,
  redactor: SecretRedactor,
  write: AuditJsonlWriter,
  pollIntervalMs: number | undefined
): Promise<void> {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    await followAuditJsonl({ path, redactor, write, signal: controller.signal, pollIntervalMs });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

/** Runs a logs command without constructing an upstream or profile manager. */
export async function runLogsCommand(options: LogsCommandOptions): Promise<void> {
  let redactor: SecretRedactor | undefined;
  try {
    const resolved = await resolveRuntimeConfig(options.configPath);
    redactor = resolved.redactor;
    const path = resolved.config.audit?.path;
    if (!path) throw new Error("Audit logging is not configured.");
    const write = options.write ?? createStdoutWriter();
    if (options.follow) {
      await followWithSignals(path, redactor, write, options.pollIntervalMs);
    } else {
      await readAuditJsonl({ path, redactor, write });
    }
  } catch (error) {
    if (!redactor) throw error;
    const message = redactor.redactText(errorMessage(error));
    const cause = error instanceof Error ? redactErrorCause(error, redactor) : redactor.redactForAudit(error);
    // eslint-disable-next-line preserve-caught-error -- The original error can carry configured secrets.
    throw new Error(message, { cause });
  }
}
