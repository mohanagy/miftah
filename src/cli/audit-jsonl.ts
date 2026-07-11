import { open, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isUtf8 } from "node:buffer";
import { SecretRedactor } from "../secrets/redact.js";

export const MALFORMED_AUDIT_RECORD = '{"type":"miftah.audit.malformed-record"}';

export type AuditJsonlWriter = (chunk: string) => unknown;

export interface AuditJsonlReadOptions {
  readonly path: string;
  readonly redactor: SecretRedactor;
  readonly write: AuditJsonlWriter;
}

export interface AuditJsonlFollowOptions extends AuditJsonlReadOptions {
  readonly signal: AbortSignal;
  readonly pollIntervalMs?: number;
}

interface AuditReadState {
  cursor: number;
  cursorFingerprint: Buffer;
  identity: string | undefined;
  pending: Buffer;
}

const defaultPollIntervalMs = 250;
const minimumPollIntervalMs = 10;
const maximumPollIntervalMs = 1_000;
const maximumCursorFingerprintBytes = 4 * 1024;

function fileIdentity(stats: Stats): string | undefined {
  return stats.dev !== 0 && stats.ino !== 0 ? `${stats.dev}:${stats.ino}` : undefined;
}

function shouldReset(state: AuditReadState, stats: Stats, identity: string | undefined): boolean {
  return (
    stats.size < state.cursor ||
    (state.identity !== undefined && identity !== undefined && state.identity !== identity)
  );
}

function resetState(state: AuditReadState): void {
  state.cursor = 0;
  state.cursorFingerprint = Buffer.alloc(0);
  state.identity = undefined;
  state.pending = Buffer.alloc(0);
}

async function readFromHandle(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const contents = Buffer.alloc(length);
  let offset = 0;
  while (offset < contents.length) {
    const { bytesRead } = await handle.read(contents, offset, contents.length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return contents.subarray(0, offset);
}

function normalizeRecord(record: Buffer, redactor: SecretRedactor): string {
  if (!isUtf8(record)) return MALFORMED_AUDIT_RECORD;
  try {
    return JSON.stringify(redactor.redactForAudit(JSON.parse(record.toString("utf8"))));
  } catch {
    return MALFORMED_AUDIT_RECORD;
  }
}

async function emitCompleteRecords(
  state: AuditReadState,
  contents: Buffer,
  redactor: SecretRedactor,
  write: AuditJsonlWriter
): Promise<void> {
  const buffered = state.pending.length === 0 ? contents : Buffer.concat([state.pending, contents]);
  let recordStart = 0;
  for (let lineEnd = buffered.indexOf(0x0a, recordStart); lineEnd !== -1; lineEnd = buffered.indexOf(0x0a, recordStart)) {
    await write(`${normalizeRecord(buffered.subarray(recordStart, lineEnd), redactor)}\n`);
    recordStart = lineEnd + 1;
  }
  state.pending = Buffer.from(buffered.subarray(recordStart));
}

function nextCursorFingerprint(state: AuditReadState, contents: Buffer): Buffer {
  if (contents.length >= maximumCursorFingerprintBytes) {
    return Buffer.from(contents.subarray(contents.length - maximumCursorFingerprintBytes));
  }
  const previousLength = Math.min(
    state.cursorFingerprint.length,
    maximumCursorFingerprintBytes - contents.length
  );
  return Buffer.concat([
    state.cursorFingerprint.subarray(state.cursorFingerprint.length - previousLength),
    contents
  ]);
}

async function cursorFingerprintMatches(state: AuditReadState, handle: FileHandle): Promise<boolean> {
  if (state.cursorFingerprint.length === 0) return true;
  const currentFingerprint = await readFromHandle(
    handle,
    state.cursor - state.cursorFingerprint.length,
    state.cursorFingerprint.length
  );
  return currentFingerprint.equals(state.cursorFingerprint);
}

async function pollAuditFile(
  path: string,
  state: AuditReadState,
  redactor: SecretRedactor,
  write: AuditJsonlWriter
): Promise<void> {
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    const identity = fileIdentity(stats);
    if (shouldReset(state, stats, identity) || !(await cursorFingerprintMatches(state, handle))) {
      resetState(state);
    }
    const contents = await readFromHandle(handle, state.cursor, stats.size - state.cursor);
    const finalStats = await handle.stat();
    const finalIdentity = fileIdentity(finalStats);
    if (shouldReset(state, finalStats, finalIdentity) || !(await cursorFingerprintMatches(state, handle))) {
      resetState(state);
      return;
    }
    state.identity = finalIdentity;
    state.cursorFingerprint = nextCursorFingerprint(state, contents);
    state.cursor += contents.length;
    await emitCompleteRecords(state, contents, redactor, write);
  } finally {
    await handle.close();
  }
}

function boundedPollInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return defaultPollIntervalMs;
  return Math.min(maximumPollIntervalMs, Math.max(minimumPollIntervalMs, Math.round(value)));
}

async function waitForNextPoll(signal: AbortSignal, pollIntervalMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, pollIntervalMs);
    const onAbort = () => {
      clearTimeout(timeout);
      finish();
    };
    function finish(): void {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Reads complete audit JSONL records from a single opened file and emits normalized redacted JSONL. */
export async function readAuditJsonl(options: AuditJsonlReadOptions): Promise<void> {
  const state: AuditReadState = {
    cursor: 0,
    cursorFingerprint: Buffer.alloc(0),
    identity: undefined,
    pending: Buffer.alloc(0)
  };
  await pollAuditFile(options.path, state, options.redactor, options.write);
}

/** Follows audit JSONL through appends, truncation, and path replacement without retaining file handles. */
export async function followAuditJsonl(options: AuditJsonlFollowOptions): Promise<void> {
  const state: AuditReadState = {
    cursor: 0,
    cursorFingerprint: Buffer.alloc(0),
    identity: undefined,
    pending: Buffer.alloc(0)
  };
  const pollIntervalMs = boundedPollInterval(options.pollIntervalMs);
  while (!options.signal.aborted) {
    try {
      await pollAuditFile(options.path, state, options.redactor, options.write);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      resetState(state);
    }
    await waitForNextPoll(options.signal, pollIntervalMs);
  }
}
