import { open, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isUtf8 } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { SecretRedactor } from "../secrets/redact.js";

export const MALFORMED_AUDIT_RECORD = '{"type":"miftah.audit.malformed-record"}';
export const AUDIT_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_INCOMPLETE_AUDIT_RECORD_BYTES = 64 * 1024;

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
  cursorDigest: Buffer;
  identity: string | undefined;
  pending: Buffer;
  pendingLength: number;
  discardingOversizedRecord: boolean;
}

const defaultPollIntervalMs = 250;
const minimumPollIntervalMs = 10;
const maximumPollIntervalMs = 1_000;
const auditSnapshotBlockBytes = AUDIT_READ_CHUNK_BYTES * 16;
const emptyCursorDigest = createHash("sha256").digest();

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
  state.cursorDigest = Buffer.from(emptyCursorDigest);
  state.identity = undefined;
  state.pendingLength = 0;
  state.discardingOversizedRecord = false;
}

async function readFromHandle(
  handle: FileHandle,
  position: number,
  length: number,
  buffer: Buffer,
  onChunk: (chunk: Buffer) => void | Promise<void>,
  signal?: AbortSignal
): Promise<number> {
  let offset = 0;
  while (offset < length) {
    if (signal?.aborted) break;
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, length - offset),
      position + offset
    );
    if (bytesRead === 0) break;
    await onChunk(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return offset;
}

async function hashFromHandle(
  handle: FileHandle,
  length: number,
  chunk: Buffer,
  signal?: AbortSignal
): Promise<Hash | undefined> {
  const hash = createHash("sha256");
  if (length === 0) return hash;

  let position = 0;
  while (position < length) {
    if (signal?.aborted) return undefined;
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, length - position), position);
    if (bytesRead === 0) return undefined;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash;
}

function digest(hash: Hash): Buffer {
  return hash.copy().digest();
}

function changedDuringRead(before: Stats, after: Stats): boolean {
  return (
    fileIdentity(before) !== fileIdentity(after) ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  );
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
  let recordStart = 0;
  while (recordStart < contents.length) {
    if (state.discardingOversizedRecord) {
      const lineEnd = contents.indexOf(0x0a, recordStart);
      if (lineEnd === -1) return;
      state.discardingOversizedRecord = false;
      recordStart = lineEnd + 1;
      continue;
    }

    const lineEnd = contents.indexOf(0x0a, recordStart);
    const recordEnd = lineEnd === -1 ? contents.length : lineEnd;
    const fragmentLength = recordEnd - recordStart;
    if (state.pendingLength + fragmentLength > MAX_INCOMPLETE_AUDIT_RECORD_BYTES) {
      state.pendingLength = 0;
      state.discardingOversizedRecord = true;
      await write(`${MALFORMED_AUDIT_RECORD}\n`);
      if (lineEnd === -1) return;
      state.discardingOversizedRecord = false;
      recordStart = lineEnd + 1;
      continue;
    }

    contents.copy(state.pending, state.pendingLength, recordStart, recordEnd);
    state.pendingLength += fragmentLength;
    if (lineEnd === -1) return;

    await write(
      `${normalizeRecord(state.pending.subarray(0, state.pendingLength), redactor)}\n`
    );
    state.pendingLength = 0;
    recordStart = lineEnd + 1;
  }
}

async function pollAuditFile(
  path: string,
  state: AuditReadState,
  redactor: SecretRedactor,
  write: AuditJsonlWriter,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return;
  const handle = await open(path, "r");
  try {
    let stats = await handle.stat();
    const identity = fileIdentity(stats);
    const hashChunk = Buffer.allocUnsafe(AUDIT_READ_CHUNK_BYTES);
    const readChunk = Buffer.allocUnsafe(AUDIT_READ_CHUNK_BYTES);
    const snapshotChunk = Buffer.allocUnsafe(auditSnapshotBlockBytes);
    if (shouldReset(state, stats, identity)) {
      resetState(state);
    }

    let prefixHash = await hashFromHandle(handle, state.cursor, hashChunk, signal);
    if (prefixHash === undefined || !digest(prefixHash).equals(state.cursorDigest)) {
      resetState(state);
      stats = await handle.stat();
      prefixHash = await hashFromHandle(handle, state.cursor, hashChunk, signal);
      if (prefixHash === undefined) return;
    }

    const snapshotEnd = stats.size;
    while (state.cursor < snapshotEnd) {
      const startCursor = state.cursor;
      const expectedLength = Math.min(auditSnapshotBlockBytes, snapshotEnd - startCursor);
      let snapshotLength = 0;
      const bytesRead = await readFromHandle(
        handle,
        startCursor,
        expectedLength,
        readChunk,
        (chunk) => {
          chunk.copy(snapshotChunk, snapshotLength);
          snapshotLength += chunk.length;
        },
        signal
      );
      const candidateCursor = startCursor + bytesRead;
      prefixHash.update(snapshotChunk.subarray(0, snapshotLength));
      const candidateDigest = digest(prefixHash);
      const finalStats = await handle.stat();
      const finalIdentity = fileIdentity(finalStats);
      const finalHash = await hashFromHandle(handle, candidateCursor, hashChunk, signal);
      const postHashStats = await handle.stat();
      if (
        bytesRead !== expectedLength ||
        shouldReset(state, finalStats, finalIdentity) ||
        finalHash === undefined ||
        !digest(finalHash).equals(candidateDigest)
      ) {
        resetState(state);
        return;
      }
      if (changedDuringRead(finalStats, postHashStats)) return;

      await emitCompleteRecords(
        state,
        snapshotChunk.subarray(0, snapshotLength),
        redactor,
        write
      );
      state.identity = finalIdentity;
      state.cursorDigest = candidateDigest;
      state.cursor = candidateCursor;
    }
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
    cursorDigest: Buffer.from(emptyCursorDigest),
    identity: undefined,
    pending: Buffer.allocUnsafe(MAX_INCOMPLETE_AUDIT_RECORD_BYTES),
    pendingLength: 0,
    discardingOversizedRecord: false
  };
  await pollAuditFile(options.path, state, options.redactor, options.write);
}

/** Follows audit JSONL through appends, truncation, and path replacement without retaining file handles. */
export async function followAuditJsonl(options: AuditJsonlFollowOptions): Promise<void> {
  const state: AuditReadState = {
    cursor: 0,
    cursorDigest: Buffer.from(emptyCursorDigest),
    identity: undefined,
    pending: Buffer.allocUnsafe(MAX_INCOMPLETE_AUDIT_RECORD_BYTES),
    pendingLength: 0,
    discardingOversizedRecord: false
  };
  const pollIntervalMs = boundedPollInterval(options.pollIntervalMs);
  while (!options.signal.aborted) {
    try {
      await pollAuditFile(options.path, state, options.redactor, options.write, options.signal);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      resetState(state);
    }
    await waitForNextPoll(options.signal, pollIntervalMs);
  }
}
