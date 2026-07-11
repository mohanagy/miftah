import { chmod, mkdtemp, open, rm, stat, type FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { isUtf8 } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretRedactor } from "../secrets/redact.js";

export const MALFORMED_AUDIT_RECORD = '{"type":"miftah.audit.malformed-record"}';
export const AUDIT_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_INCOMPLETE_AUDIT_RECORD_BYTES = 64 * 1024;

export type AuditJsonlWriter = (chunk: string) => unknown;

export interface AuditJsonlReadOptions {
  readonly path: string;
  readonly redactor: SecretRedactor;
  readonly write: AuditJsonlWriter;
  readonly temporaryDirectory?: string;
}

export interface AuditJsonlFollowOptions extends AuditJsonlReadOptions {
  readonly signal: AbortSignal;
  readonly pollIntervalMs?: number;
}

interface AuditReadState {
  cursor: number;
  cursorDigest: Buffer;
  version: AuditFileVersion | undefined;
  pending: Buffer;
  pendingLength: number;
  discardingOversizedRecord: boolean;
}

interface AuditFileVersion {
  readonly identity: string | undefined;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface OpenTemporarySpool {
  directory: string;
  path: string;
  handle: FileHandle;
}

interface ClosedTemporarySpool {
  directory: string;
  path: string;
}

type SnapshotAttempt =
  | { kind: "aborted" | "unstable" }
  | { kind: "staged"; state: AuditReadState; spool: ClosedTemporarySpool | undefined };

const defaultPollIntervalMs = 250;
const minimumPollIntervalMs = 10;
const maximumPollIntervalMs = 1_000;
const maximumSnapshotAttempts = 3;
const emptyCursorDigest = createHash("sha256").digest();

function fileIdentity(stats: BigIntStats): string | undefined {
  return stats.dev !== 0n && stats.ino !== 0n ? `${stats.dev}:${stats.ino}` : undefined;
}

function safelyConvertFileSize(size: bigint): number {
  const converted = Number(size);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error("Audit log size cannot be represented safely.");
  }
  return converted;
}

function fileVersion(stats: BigIntStats): AuditFileVersion {
  return {
    identity: fileIdentity(stats),
    size: safelyConvertFileSize(stats.size),
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  };
}

function sameVersion(left: AuditFileVersion, right: AuditFileVersion): boolean {
  return (
    left.identity === right.identity &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isVerifiedIdlePoll(state: AuditReadState, version: AuditFileVersion): boolean {
  return state.cursor === version.size && state.version !== undefined && sameVersion(state.version, version);
}

function shouldReset(state: AuditReadState, version: AuditFileVersion): boolean {
  return (
    version.size < state.cursor ||
    (state.version?.identity !== undefined &&
      version.identity !== undefined &&
      state.version.identity !== version.identity)
  );
}

function resetState(state: AuditReadState): void {
  state.cursor = 0;
  state.cursorDigest = Buffer.from(emptyCursorDigest);
  state.version = undefined;
  state.pendingLength = 0;
  state.discardingOversizedRecord = false;
}

function createReadState(): AuditReadState {
  return {
    cursor: 0,
    cursorDigest: Buffer.from(emptyCursorDigest),
    version: undefined,
    pending: Buffer.allocUnsafe(MAX_INCOMPLETE_AUDIT_RECORD_BYTES),
    pendingLength: 0,
    discardingOversizedRecord: false
  };
}

function cloneReadState(state: AuditReadState): AuditReadState {
  return {
    cursor: state.cursor,
    cursorDigest: Buffer.from(state.cursorDigest),
    version: state.version,
    pending: Buffer.from(state.pending),
    pendingLength: state.pendingLength,
    discardingOversizedRecord: state.discardingOversizedRecord
  };
}

function commitReadState(target: AuditReadState, source: AuditReadState): void {
  target.cursor = source.cursor;
  target.cursorDigest = Buffer.from(source.cursorDigest);
  target.version = source.version;
  target.pending = source.pending;
  target.pendingLength = source.pendingLength;
  target.discardingOversizedRecord = source.discardingOversizedRecord;
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
  startPosition: number,
  length: number,
  chunk: Buffer,
  signal?: AbortSignal
): Promise<Hash | undefined> {
  const hash = createHash("sha256");
  if (length === 0) return hash;

  let offset = 0;
  while (offset < length) {
    if (signal?.aborted) return undefined;
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, length - offset),
      startPosition + offset
    );
    if (bytesRead === 0) return undefined;
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash;
}

async function createTemporarySpool(temporaryDirectory?: string): Promise<OpenTemporarySpool> {
  const directory = await mkdtemp(join(temporaryDirectory ?? tmpdir(), "miftah-audit-jsonl-"));
  let handle: FileHandle | undefined;
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "snapshot.jsonl");
    handle = await open(path, "wx", 0o600);
    await chmod(path, 0o600);
    return { directory, path, handle };
  } catch (error) {
    try {
      await handle?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

async function discardOpenSpool(spool: OpenTemporarySpool): Promise<void> {
  try {
    await spool.handle.close();
  } finally {
    await rm(spool.directory, { recursive: true, force: true });
  }
}

async function discardClosedSpool(spool: ClosedTemporarySpool | undefined): Promise<void> {
  if (spool !== undefined) {
    await rm(spool.directory, { recursive: true, force: true });
  }
}

function digest(hash: Hash): Buffer {
  return hash.copy().digest();
}

function changedDuringRead(before: AuditFileVersion, after: AuditFileVersion): boolean {
  return !sameVersion(before, after);
}

function normalizeRecord(record: Buffer, redactor: SecretRedactor): string {
  if (!isUtf8(record)) return MALFORMED_AUDIT_RECORD;
  try {
    return JSON.stringify(redactor.redactForAudit(JSON.parse(record.toString("utf8"))));
  } catch {
    return MALFORMED_AUDIT_RECORD;
  }
}

async function stageCompleteRecords(
  state: AuditReadState,
  contents: Buffer,
  redactor: SecretRedactor,
  write: AuditJsonlWriter
): Promise<void> {
  let recordStart = 0;
  const stagedRecords: string[] = [];
  while (recordStart < contents.length) {
    if (state.discardingOversizedRecord) {
      const lineEnd = contents.indexOf(0x0a, recordStart);
      if (lineEnd === -1) break;
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
      stagedRecords.push(`${MALFORMED_AUDIT_RECORD}\n`);
      if (lineEnd === -1) break;
      state.discardingOversizedRecord = false;
      recordStart = lineEnd + 1;
      continue;
    }
    contents.copy(state.pending, state.pendingLength, recordStart, recordEnd);
    state.pendingLength += fragmentLength;
    if (lineEnd === -1) break;

    stagedRecords.push(`${normalizeRecord(state.pending.subarray(0, state.pendingLength), redactor)}\n`);
    state.pendingLength = 0;
    recordStart = lineEnd + 1;
  }
  if (stagedRecords.length > 0) await write(stagedRecords.join(""));
}

async function stageAuditSnapshot(
  path: string,
  state: AuditReadState,
  redactor: SecretRedactor,
  signal?: AbortSignal,
  follow = false,
  temporaryDirectory?: string
): Promise<SnapshotAttempt> {
  if (signal?.aborted) return { kind: "aborted" };
  const handle = await open(path, "r");
  let sourceClosed = false;
  let spool: OpenTemporarySpool | undefined;
  try {
    let version = fileVersion(await handle.stat({ bigint: true }));
    const candidate = cloneReadState(state);
    // Finite reads always snapshot; only a fully verified follower endpoint can skip hashing.
    if (follow && isVerifiedIdlePoll(candidate, version)) {
      return { kind: "staged", state: candidate, spool: undefined };
    }

    const hashChunk = Buffer.allocUnsafe(AUDIT_READ_CHUNK_BYTES);
    const readChunk = Buffer.allocUnsafe(AUDIT_READ_CHUNK_BYTES);
    if (shouldReset(candidate, version)) {
      resetState(candidate);
    }

    // Rehash [0,cursor): portable metadata cannot distinguish normal append from same-inode copytruncate/rewrite to equal-or-larger size, protecting rotation integrity before emitting delta.
    let prefixHash = await hashFromHandle(handle, 0, candidate.cursor, hashChunk, signal);
    if (prefixHash === undefined) {
      return signal?.aborted ? { kind: "aborted" } : { kind: "unstable" };
    }
    if (!digest(prefixHash).equals(candidate.cursorDigest)) {
      resetState(candidate);
      version = fileVersion(await handle.stat({ bigint: true }));
      prefixHash = await hashFromHandle(handle, 0, candidate.cursor, hashChunk, signal);
      if (prefixHash === undefined) {
        return signal?.aborted ? { kind: "aborted" } : { kind: "unstable" };
      }
    }

    const snapshotEnd = version.size;
    const expectedLength = snapshotEnd - candidate.cursor;
    const deltaHash = createHash("sha256");
    const bytesRead = await readFromHandle(
      handle,
      candidate.cursor,
      expectedLength,
      readChunk,
      async (chunk) => {
        prefixHash.update(chunk);
        deltaHash.update(chunk);
        await stageCompleteRecords(candidate, chunk, redactor, async (record) => {
          if (spool === undefined) spool = await createTemporarySpool(temporaryDirectory);
          await spool.handle.writeFile(record, "utf8");
        });
      },
      signal
    );
    if (signal?.aborted) return { kind: "aborted" };

    const candidateCursor = candidate.cursor + bytesRead;
    const candidateDigest = digest(prefixHash);
    const deltaDigest = digest(deltaHash);
    const finalVersion = fileVersion(await handle.stat({ bigint: true }));
    const finalDeltaHash = await hashFromHandle(
      handle,
      candidate.cursor,
      bytesRead,
      hashChunk,
      signal
    );
    if (finalDeltaHash === undefined) {
      return signal?.aborted ? { kind: "aborted" } : { kind: "unstable" };
    }
    const postHashVersion = fileVersion(await handle.stat({ bigint: true }));
    let endpointVersion: AuditFileVersion;
    try {
      endpointVersion = fileVersion(await stat(path, { bigint: true }));
    } catch (error) {
      if (isNotFoundError(error)) return { kind: "unstable" };
      throw error;
    }

    if (
      bytesRead !== expectedLength ||
      changedDuringRead(version, finalVersion) ||
      changedDuringRead(finalVersion, postHashVersion) ||
      changedDuringRead(postHashVersion, endpointVersion) ||
      shouldReset(candidate, finalVersion) ||
      !digest(finalDeltaHash).equals(deltaDigest)
    ) {
      return { kind: "unstable" };
    }

    candidate.version = finalVersion;
    candidate.cursorDigest = candidateDigest;
    candidate.cursor = candidateCursor;
    await handle.close();
    sourceClosed = true;

    let closedSpool: ClosedTemporarySpool | undefined;
    if (spool !== undefined) {
      await spool.handle.close();
      closedSpool = { directory: spool.directory, path: spool.path };
      spool = undefined;
    }
    return { kind: "staged", state: candidate, spool: closedSpool };
  } finally {
    try {
      if (!sourceClosed) await handle.close();
    } finally {
      if (spool !== undefined) await discardOpenSpool(spool);
    }
  }
}

async function writeWithAbort(
  write: AuditJsonlWriter,
  chunk: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false;

  const writePromise = Promise.resolve(write(chunk));
  if (signal === undefined) {
    await writePromise;
    return true;
  }

  let removeAbortListener = () => {};
  const aborted = new Promise<false>((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([writePromise.then(() => true), aborted]);
  } finally {
    removeAbortListener();
  }
}

async function forwardStagedOutput(
  spool: ClosedTemporarySpool | undefined,
  write: AuditJsonlWriter,
  signal?: AbortSignal
): Promise<boolean> {
  if (spool === undefined) return !signal?.aborted;

  const handle = await open(spool.path, "r");
  const chunk = Buffer.allocUnsafe(AUDIT_READ_CHUNK_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let position = 0;
  let pending = "";
  try {
    while (!signal?.aborted) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
      let lineEnd = pending.indexOf("\n");
      while (lineEnd !== -1) {
        if (signal?.aborted) return false;
        if (!(await writeWithAbort(write, pending.slice(0, lineEnd + 1), signal))) return false;
        pending = pending.slice(lineEnd + 1);
        lineEnd = pending.indexOf("\n");
      }
    }
    if (signal?.aborted) return false;
    pending += decoder.decode();
    if (pending.length > 0 && !(await writeWithAbort(write, pending, signal))) return false;
    return true;
  } finally {
    await handle.close();
  }
}

async function pollAuditFile(
  path: string,
  state: AuditReadState,
  redactor: SecretRedactor,
  write: AuditJsonlWriter,
  signal?: AbortSignal,
  follow = false,
  temporaryDirectory?: string
): Promise<"aborted" | "stable" | "unstable"> {
  const attempt = await stageAuditSnapshot(path, state, redactor, signal, follow, temporaryDirectory);
  if (attempt.kind !== "staged") return attempt.kind;
  try {
    if (!(await forwardStagedOutput(attempt.spool, write, signal))) return "aborted";
    commitReadState(state, attempt.state);
    return "stable";
  } finally {
    await discardClosedSpool(attempt.spool);
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
  const state = createReadState();
  for (let attempt = 0; attempt < maximumSnapshotAttempts; attempt += 1) {
    if (
      (await pollAuditFile(
        options.path,
        state,
        options.redactor,
        options.write,
        undefined,
        false,
        options.temporaryDirectory
      )) === "stable"
    ) {
      return;
    }
  }
  throw new Error("Audit log did not stabilize while creating a snapshot");
}

/** Follows audit JSONL through appends, truncation, and path replacement without retaining file handles. */
export async function followAuditJsonl(options: AuditJsonlFollowOptions): Promise<void> {
  const state = createReadState();
  const pollIntervalMs = boundedPollInterval(options.pollIntervalMs);
  while (!options.signal.aborted) {
    try {
      await pollAuditFile(
        options.path,
        state,
        options.redactor,
        options.write,
        options.signal,
        true,
        options.temporaryDirectory
      );
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    await waitForNextPoll(options.signal, pollIntervalMs);
  }
}
