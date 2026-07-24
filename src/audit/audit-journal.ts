import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AuditIntegrityOptions, AuditRotationOptions } from "./audit-types.js";

const archiveSequenceWidth = 20;
const maximumArchiveSequence = 10n ** BigInt(archiveSequenceWidth) - 1n;
const lockWaitMilliseconds = 5_000;
const lockRetryMilliseconds = 10;
const localLockPortStart = 49_152;
const localLockPortCount = 16_384;
const localLockPortAttempts = 256;
const localLockProbeMilliseconds = 100;
const localLockProtocol = "miftah-audit-lock-v1";
const auditJournalUnavailableMessage = "Audit journal is unavailable.";
const integrityAlgorithm = "sha256-chain-v1";
const integrityReadChunkBytes = 64 * 1024;
const maximumIntegrityRecordBytes = 1024 * 1024;
const maximumCheckpointBytes = 4 * 1024 * 1024;
const maximumLedgerRecordBytes = maximumCheckpointBytes;
const maximumRetainedArchiveFiles = 2_000;
const maximumManagedFilenameBytes = 255;
const maximumArchiveSuffixBytes = Buffer.byteLength(`.miftah-${"0".repeat(archiveSequenceWidth)}-${"0".repeat(36)}`, "utf8");
const maximumIntegrityMetadataSuffixBytes = Math.max(
  Buffer.byteLength(".miftah-integrity-ledger-backup", "utf8"),
  Buffer.byteLength(".miftah-integrity-transaction.json", "utf8"),
  Buffer.byteLength(".miftah-integrity-prior-state.json", "utf8")
);
const maximumIntegrityTemporarySuffixBytes = Math.max(
  ...["miftah-integrity-ledger", "miftah-integrity-state", "miftah-integrity-transaction"].map((label) =>
    Buffer.byteLength(`..${label}-${"0".repeat(36)}`, "utf8")
  )
);
const maximumRetiredArchiveSuffixBytes =
  1 + maximumArchiveSuffixBytes + Buffer.byteLength(".miftah-retiring", "utf8");
const hashPattern = /^[0-9a-f]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const readOnlyFlags = constants.O_RDONLY | noFollowFlag;
const appendWriteFlags = constants.O_WRONLY | constants.O_APPEND | noFollowFlag;
const writeOnlyFlags = constants.O_WRONLY | noFollowFlag;
const createExclusiveFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag;

interface AuditJournalLocation {
  readonly directory: string;
  readonly activePath: string;
  readonly basename: string;
  readonly integrityLedgerPath: string;
  readonly integrityCheckpointPath: string;
  readonly integrityLedgerName: string;
  readonly integrityLedgerBackupPath: string;
  readonly integrityLedgerBackupName: string;
  readonly integrityTransactionPath: string;
  readonly integrityTransactionName: string;
  readonly integrityPriorCheckpointPath: string;
  readonly integrityPriorCheckpointName: string;
}

interface ManagedArchive {
  readonly name: string;
  readonly path: string;
  readonly sequence: bigint;
  readonly sequenceText: string;
}

interface StagedArchiveRetirement {
  readonly archive: ArchivedSegmentState;
  readonly path: string;
  readonly name: string;
}

interface IntegrityChainState {
  readonly chainId: string;
  readonly lastHash: string | null;
}

interface ActiveSegmentState {
  readonly name: string;
  readonly byteLength: number;
  readonly recordCount: number;
  readonly firstPreviousHash: string | null;
  readonly tailHash: string | null;
}

interface ArchivedSegmentState extends ActiveSegmentState {
  readonly sequence: string;
}

interface IntegrityCheckpointCore {
  readonly version: 1;
  readonly chainId: string;
  readonly anchorHash: string | null;
  readonly archives: readonly ArchivedSegmentState[];
  readonly active: ActiveSegmentState;
}

interface IntegrityCheckpoint extends IntegrityCheckpointCore {
  readonly ledgerEntry: number;
  readonly ledgerHash: string;
  readonly ledgerSize: number;
  readonly stateHash: string;
}

type IntegrityLedgerKind = "initialize" | "checkpoint" | "append" | "rotate" | "retire";
type IntegrityTransactionKind = "initialize" | "append" | "rotate" | "retire";
type IntegrityTransactionPhase = "pending" | "committed";

interface IntegrityRetirement {
  readonly throughSequence: string;
  readonly anchorHash: string;
}

interface IntegrityLedgerCheckpoint {
  readonly anchorHash: string | null;
  readonly archives: readonly ArchivedSegmentState[];
}

interface IntegrityLedgerEntry {
  readonly version: 1;
  readonly kind: IntegrityLedgerKind;
  readonly entry: number;
  readonly chainId: string;
  readonly previousEntryHash: string | null;
  readonly active: ActiveSegmentState;
  readonly checkpoint?: IntegrityLedgerCheckpoint;
  readonly sealed?: ArchivedSegmentState;
  readonly retired?: IntegrityRetirement;
  readonly entryHash: string;
}

interface IntegrityTransaction {
  readonly version: 1;
  readonly kind: IntegrityTransactionKind;
  readonly phase: IntegrityTransactionPhase;
  readonly priorStateHash: string | null;
  readonly priorLedgerSize: number;
  readonly priorLedgerHash: string | null;
  readonly nextStateHash: string;
  readonly nextLedgerSize: number;
  readonly nextLedgerHash: string;
  readonly archive?: { readonly name: string; readonly sequence: string };
  readonly retiredArchives?: readonly string[];
  readonly transactionHash: string;
}

interface IntegrityTransactionDetails {
  readonly archive?: ManagedArchive;
  readonly retiredArchives?: readonly ArchivedSegmentState[];
}

interface PreparedCheckpointTransition {
  readonly ledgerLine: string;
  readonly checkpoint: IntegrityCheckpoint;
}

interface IntegritySegmentScan {
  readonly byteLength: number;
  readonly recordCount: number;
  readonly firstPreviousHash?: string | null;
  readonly state: IntegrityChainState | undefined;
  readonly firstBroken?: AuditIntegrityReport["firstBroken"];
}

interface LedgerTransition {
  readonly kind: IntegrityLedgerKind;
  readonly sealed?: ArchivedSegmentState;
  readonly retired?: IntegrityRetirement;
}

export type AuditIntegrityFailureReason =
  | "MALFORMED_RECORD"
  | "INCOMPLETE_RECORD"
  | "RECORD_TOO_LARGE"
  | "MISSING_INTEGRITY"
  | "INVALID_INTEGRITY"
  | "CHAIN_ID_MISMATCH"
  | "PREVIOUS_HASH_MISMATCH"
  | "HASH_MISMATCH"
  | "NO_RECORDS"
  | "INTEGRITY_NOT_CONFIGURED"
  | "SEGMENT_UNAVAILABLE"
  | "SEGMENT_METADATA_MISMATCH";

export interface AuditIntegrityReport {
  readonly ok: boolean;
  readonly firstBroken?: {
    readonly segment: string;
    readonly record: number;
    readonly reason: AuditIntegrityFailureReason;
  };
}

export interface AuditJournalWriteOptions {
  readonly rotation?: AuditRotationOptions;
  readonly integrity?: AuditIntegrityOptions;
}

export interface AuditJournalSnapshot {
  readonly segments: readonly {
    readonly name: string;
    readonly path: string;
    /** A best-effort source-file identity used only to transfer managed follow state. */
    readonly identity?: string;
  }[];
  cleanup(): Promise<void>;
}

export interface AuditJournalSnapshotOptions {
  /** Lets managed followers start before the first journal segment exists. */
  readonly allowEmpty?: boolean;
  readonly temporaryDirectory?: string;
}

class AuditJournalUnsafePathError extends Error {
  constructor(readonly segment: string) {
    super("Audit journal path is unsafe.");
  }
}

/** A fixed reader-facing failure that cannot disclose configured journal paths. */
export class AuditJournalUnavailableError extends Error {
  constructor() {
    super(auditJournalUnavailableMessage);
  }
}

class AuditIntegrityMismatchError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function auditJournalErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isMissingAuditJournalPathError(error: unknown): boolean {
  return auditJournalErrorCode(error) === "ENOENT";
}

/** Identifies source-path failures that must not be emitted by audit readers. */
export function isAuditJournalReaderFailure(error: unknown): boolean {
  if (error instanceof AuditJournalUnavailableError) return true;
  return ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EISDIR"].includes(auditJournalErrorCode(error) ?? "");
}

/** Converts a reader failure into a fixed diagnostic without retaining the original cause. */
export function asAuditJournalUnavailableError(error: unknown): AuditJournalUnavailableError {
  return error instanceof AuditJournalUnavailableError ? error : new AuditJournalUnavailableError();
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isUnsupportedModeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOSYS" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP")
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function archiveNamePattern(activeBasename: string): RegExp {
  return new RegExp(
    `^${escapeRegularExpression(activeBasename)}\\.miftah-([0-9]{${archiveSequenceWidth}})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
    "u"
  );
}

function archiveName(activeBasename: string, sequence: bigint): string {
  return `${activeBasename}.miftah-${sequence.toString().padStart(archiveSequenceWidth, "0")}-${randomUUID()}`;
}

function archiveSequenceFromName(activeBasename: string, name: string): string | undefined {
  return archiveNamePattern(activeBasename).exec(name)?.[1];
}

function retiredArchiveName(archive: ArchivedSegmentState): string {
  return `.${archive.name}.miftah-retiring`;
}

function archiveNameFromRetiredName(activeBasename: string, name: string): string | undefined {
  const prefix = ".";
  const suffix = ".miftah-retiring";
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return undefined;
  const archive = name.slice(prefix.length, -suffix.length);
  return archiveNamePattern(activeBasename).test(archive) ? archive : undefined;
}

function fileIdentity(stats: { readonly dev: number; readonly ino: number }): string | undefined {
  return stats.dev !== 0 && stats.ino !== 0 ? `${stats.dev}:${stats.ino}` : undefined;
}

function sameFileNode(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number }
): boolean {
  return (
    left.dev !== 0 &&
    left.ino !== 0 &&
    right.dev !== 0 &&
    right.ino !== 0 &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

interface JournalFileSafetyOptions {
  /** A same-directory, transaction-owned backup that is the only permitted second hard link. */
  readonly internalHardLinkPeer?: { readonly path: string; readonly segment: string };
}

interface JournalFileStats {
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function assertRegularJournalFile(stats: JournalFileStats, segment: string): void {
  if (stats.isSymbolicLink() || !stats.isFile()) throw new AuditJournalUnsafePathError(segment);
}

async function assertJournalFileLinkSafety(
  stats: JournalFileStats,
  segment: string,
  options: JournalFileSafetyOptions = {}
): Promise<void> {
  assertRegularJournalFile(stats, segment);
  if (stats.dev === 0 || stats.ino === 0) throw new AuditJournalUnsafePathError(segment);
  if (stats.nlink === 1) return;
  const peer = options.internalHardLinkPeer;
  if (stats.nlink !== 2 || peer === undefined) throw new AuditJournalUnsafePathError(segment);

  let peerStats: JournalFileStats;
  try {
    peerStats = await lstat(peer.path);
  } catch {
    throw new AuditJournalUnsafePathError(segment);
  }
  if (
    peerStats.isSymbolicLink() ||
    !peerStats.isFile() ||
    peerStats.nlink !== 2 ||
    !sameFileNode(stats, peerStats)
  ) {
    throw new AuditJournalUnsafePathError(segment);
  }
}

function sameSnapshot(
  left: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number },
  right: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number }
): boolean {
  return sameFileNode(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHashOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && hashPattern.test(value));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Audit integrity payload is not JSON-safe.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Audit integrity payload is not JSON-safe.");
}

function payloadWithoutIntegrity(record: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...record };
  delete payload.integrity;
  return payload;
}

function calculateIntegrityHash(payload: Record<string, unknown>, chainId: string, previousHash: string | null): string {
  return createHash("sha256")
    .update(`${integrityAlgorithm}\u0000${chainId}\u0000${previousHash ?? ""}\u0000`, "utf8")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

function calculateLedgerHash(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update("miftah-audit-integrity-ledger-v1\u0000", "utf8")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

function calculateCheckpointHash(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update("miftah-audit-integrity-checkpoint-v1\u0000", "utf8")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

function calculateTransactionHash(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update("miftah-audit-integrity-transaction-v1\u0000", "utf8")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Audit integrity requires JSON object records.");
  return parsed;
}

function parseCompleteJsonlBatch(line: string): Record<string, unknown>[] {
  if (!line.endsWith("\n")) throw new Error("Audit journal batch must end on a JSONL boundary.");
  const records = line.slice(0, -1).split("\n");
  if (records.length === 0 || records.some((record) => record.length === 0)) {
    throw new Error("Audit journal batch contains an empty record.");
  }
  if (records.some((record) => Buffer.byteLength(record, "utf8") > maximumIntegrityRecordBytes)) {
    throw new Error("Audit integrity record exceeds its safe size limit.");
  }
  return records.map(parseJsonRecord);
}

function applyIntegrityChain(
  line: string,
  previousState: IntegrityChainState
): { line: string; state: IntegrityChainState; recordCount: number } {
  let state = previousState;
  const records = parseCompleteJsonlBatch(line).map((record) => {
    const payload = payloadWithoutIntegrity(record);
    const previousHash = state.lastHash;
    const hash = calculateIntegrityHash(payload, state.chainId, previousHash);
    state = { chainId: state.chainId, lastHash: hash };
    const chained = {
      ...payload,
      integrity: { algorithm: integrityAlgorithm, chainId: state.chainId, previousHash, hash }
    };
    const serialized = JSON.stringify(chained);
    if (Buffer.byteLength(serialized, "utf8") > maximumIntegrityRecordBytes) {
      throw new Error("Audit integrity record exceeds its safe size limit.");
    }
    return serialized;
  });
  return { line: `${records.join("\n")}\n`, state, recordCount: records.length };
}

function integrityFailure(
  segment: string,
  record: number,
  reason: AuditIntegrityFailureReason
): AuditIntegrityReport["firstBroken"] {
  return { segment, record, reason };
}

function parseIntegrityEnvelope(record: Record<string, unknown>):
  | { readonly chainId: string; readonly previousHash: string | null; readonly hash: string }
  | undefined {
  const envelope = record.integrity;
  if (!isRecord(envelope)) return undefined;
  const { algorithm, chainId, previousHash, hash } = envelope;
  if (
    algorithm !== integrityAlgorithm ||
    typeof chainId !== "string" ||
    !uuidPattern.test(chainId) ||
    !isHashOrNull(previousHash) ||
    typeof hash !== "string" ||
    !hashPattern.test(hash)
  ) {
    return undefined;
  }
  return { chainId, previousHash, hash };
}

function inspectIntegrityRecord(
  record: Record<string, unknown>,
  previousState: IntegrityChainState | undefined
): { state?: IntegrityChainState; reason?: AuditIntegrityFailureReason; previousHash?: string | null } {
  const envelope = parseIntegrityEnvelope(record);
  if (envelope === undefined) {
    return { reason: isRecord(record.integrity) ? "INVALID_INTEGRITY" : "MISSING_INTEGRITY" };
  }
  if (previousState !== undefined && envelope.chainId !== previousState.chainId) return { reason: "CHAIN_ID_MISMATCH" };
  const expectedPreviousHash = previousState?.lastHash ?? null;
  if (envelope.previousHash !== expectedPreviousHash) return { reason: "PREVIOUS_HASH_MISMATCH" };
  const expectedHash = calculateIntegrityHash(payloadWithoutIntegrity(record), envelope.chainId, envelope.previousHash);
  if (envelope.hash !== expectedHash) return { reason: "HASH_MISMATCH" };
  return {
    state: { chainId: envelope.chainId, lastHash: envelope.hash },
    previousHash: envelope.previousHash
  };
}

function assertRotationOptions(options: AuditRotationOptions): void {
  const validNumber = (value: number | undefined): boolean =>
    value === undefined || (Number.isSafeInteger(value) && value > 0);
  if (!validNumber(options.maxBytes) || !validNumber(options.maxAgeMs)) {
    throw new Error("Audit rotation limits must be positive safe integers.");
  }
  if (
    !Number.isSafeInteger(options.retainFiles) ||
    options.retainFiles < 0 ||
    options.retainFiles > maximumRetainedArchiveFiles
  ) {
    throw new Error(`Audit rotation retainFiles must be a non-negative safe integer no greater than ${maximumRetainedArchiveFiles}.`);
  }
  if (options.maxBytes === undefined && options.maxAgeMs === undefined) {
    throw new Error("Audit rotation requires a size or age limit.");
  }
}

function assertIntegrityOptions(options: AuditIntegrityOptions): void {
  if (options.algorithm !== "sha256-chain") {
    throw new Error("Audit integrity algorithm is unsupported.");
  }
}

function assertManagedJournalBasename(
  location: AuditJournalLocation,
  options: AuditJournalWriteOptions
): void {
  const suffixBytes = Math.max(
    options.rotation === undefined ? 0 : maximumArchiveSuffixBytes,
    options.integrity === undefined
      ? 0
      : Math.max(maximumIntegrityMetadataSuffixBytes, maximumIntegrityTemporarySuffixBytes),
    options.rotation === undefined || options.integrity === undefined ? 0 : maximumRetiredArchiveSuffixBytes
  );
  if (Buffer.byteLength(location.basename, "utf8") + suffixBytes > maximumManagedFilenameBytes) {
    throw new Error("Audit journal filename is too long for managed rotation or integrity metadata.");
  }
}

async function resolveJournalLocation(
  path: string,
  options: { readonly createDirectory?: boolean } = {}
): Promise<AuditJournalLocation> {
  const configuredDirectory = dirname(path);
  const activeBasename = basename(path);
  if (activeBasename.length === 0 || activeBasename === "." || activeBasename === "..") {
    throw new Error("Audit journal path must name a file.");
  }
  if (options.createDirectory !== false) {
    await mkdir(configuredDirectory, { recursive: true, mode: 0o700 });
  }
  const directory = await realpath(configuredDirectory);
  return {
    directory,
    activePath: join(directory, activeBasename),
    basename: activeBasename,
    integrityLedgerPath: join(directory, `.${activeBasename}.miftah-integrity.jsonl`),
    integrityCheckpointPath: join(directory, `.${activeBasename}.miftah-integrity-state.json`),
    integrityLedgerName: `.${activeBasename}.miftah-integrity.jsonl`,
    integrityLedgerBackupPath: join(directory, `.${activeBasename}.miftah-integrity-ledger-backup`),
    integrityLedgerBackupName: `.${activeBasename}.miftah-integrity-ledger-backup`,
    integrityTransactionPath: join(directory, `.${activeBasename}.miftah-integrity-transaction.json`),
    integrityTransactionName: `.${activeBasename}.miftah-integrity-transaction.json`,
    integrityPriorCheckpointPath: join(directory, `.${activeBasename}.miftah-integrity-prior-state.json`),
    integrityPriorCheckpointName: `.${activeBasename}.miftah-integrity-prior-state.json`
  };
}

function checkpointWithPriorBackupSafety(location: AuditJournalLocation): JournalFileSafetyOptions {
  return {
    internalHardLinkPeer: {
      path: location.integrityPriorCheckpointPath,
      segment: location.integrityPriorCheckpointName
    }
  };
}

function priorCheckpointBackupSafety(location: AuditJournalLocation): JournalFileSafetyOptions {
  return {
    internalHardLinkPeer: {
      path: location.integrityCheckpointPath,
      segment: basename(location.integrityCheckpointPath)
    }
  };
}

function ledgerWithBackupSafety(location: AuditJournalLocation): JournalFileSafetyOptions {
  return {
    internalHardLinkPeer: {
      path: location.integrityLedgerBackupPath,
      segment: location.integrityLedgerBackupName
    }
  };
}

function ledgerBackupSafety(location: AuditJournalLocation): JournalFileSafetyOptions {
  return {
    internalHardLinkPeer: {
      path: location.integrityLedgerPath,
      segment: location.integrityLedgerName
    }
  };
}

function safeAuditSegmentName(path: string): string {
  const segment = basename(path);
  return segment.length > 0 && segment !== "." && segment !== ".." ? segment : "audit-journal";
}

function localJournalLockKey(location: AuditJournalLocation): string {
  return createHash("sha256")
    .update(`${localLockProtocol}\u0000${location.directory}\u0000${location.basename}`, "utf8")
    .digest("hex");
}

function localJournalLockPorts(key: string): readonly number[] {
  const start = Number.parseInt(key.slice(0, 8), 16) % localLockPortCount;
  return Array.from(
    { length: localLockPortAttempts },
    (_, offset) => localLockPortStart + ((start + offset) % localLockPortCount)
  );
}

function localLockGreeting(key: string): string {
  return `${localLockProtocol} ${key}\n`;
}

type LocalLockPortState = "available" | "held" | "occupied" | "unknown";

interface LocalJournalLock {
  readonly server: Server;
  readonly clients: Set<Socket>;
}

type LocalLockAttempt =
  | { readonly status: "acquired"; readonly lock: LocalJournalLock }
  | { readonly status: "retry" }
  | { readonly status: "unavailable" };

async function inspectLocalLockPort(port: number, key: string): Promise<LocalLockPortState> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    let response = "";
    let timeoutImmediate: ReturnType<typeof setImmediate> | undefined;
    const settle = (state: LocalLockPortState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timeoutImmediate !== undefined) clearImmediate(timeoutImmediate);
      socket.destroy();
      resolve(state);
    };
    // An interrupted or incomplete probe may be a holder that is releasing or
    // acquiring this journal rather than an unrelated listener. Treat it as
    // unknown so a contender retries this candidate instead of selecting a
    // different port and bypassing the same lock.
    const timeout = setTimeout(() => {
      // Under host scheduling pressure, a local connection result can already
      // be queued when the timer phase runs. Give that result one check phase
      // to settle before treating the holder as incomplete and failing closed.
      timeoutImmediate = setImmediate(() => settle("unknown"));
    }, localLockProbeMilliseconds);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > localLockGreeting(key).length) {
        settle("occupied");
        return;
      }
      if (response.includes("\n")) settle(response === localLockGreeting(key) ? "held" : "occupied");
    });
    socket.once("end", () => {
      if (response === localLockGreeting(key)) {
        settle("held");
        return;
      }
      settle(response.includes("\n") ? "occupied" : "unknown");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "ECONNREFUSED" ? "available" : "unknown");
    });
  });
}

async function tryAcquireLocalLock(port: number, key: string): Promise<LocalLockAttempt> {
  return new Promise((resolve, reject) => {
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.once("close", () => clients.delete(socket));
      socket.end(localLockGreeting(key));
    });
    const fail = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE") {
        resolve({ status: "retry" });
        return;
      }
      if (error.code === "EACCES") {
        resolve({ status: "unavailable" });
        return;
      }
      reject(error);
    };
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", fail);
      server.on("error", () => {
        process.emitWarning("Miftah audit local lock listener encountered an error.");
      });
      resolve({ status: "acquired", lock: { server, clients } });
    });
  });
}

async function releaseLocalLock(lock: LocalJournalLock): Promise<void> {
  for (const client of lock.clients) client.destroy();
  await new Promise<void>((resolve) => {
    lock.server.close((error) => {
      if (error !== undefined) {
        process.emitWarning("Miftah audit local lock listener could not be closed after its operation completed.");
      }
      resolve();
    });
  });
}

async function acquireJournalLock(location: AuditJournalLocation): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  const key = localJournalLockKey(location);
  const ports = localJournalLockPorts(key);
  while (true) {
    for (const port of ports) {
      if (Date.now() - startedAt >= lockWaitMilliseconds) {
        throw new Error("Audit journal lock could not be acquired.");
      }
      const state = await inspectLocalLockPort(port, key);
      if (state === "held" || state === "unknown") {
        break;
      }
      if (state === "available") {
        const attempt = await tryAcquireLocalLock(port, key);
        if (attempt.status === "acquired") return async () => releaseLocalLock(attempt.lock);
        if (attempt.status === "unavailable") continue;
        break;
      }
    }
    await wait(lockRetryMilliseconds);
  }
}

async function withJournalLock<Result>(
  location: AuditJournalLocation,
  operation: () => Promise<Result>
): Promise<Result> {
  const release = await acquireJournalLock(location);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function assertHandleAtPath(
  file: FileHandle,
  path: string,
  segment: string,
  options: JournalFileSafetyOptions = {}
): Promise<void> {
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if (isNotFoundError(error)) throw new AuditJournalUnsafePathError(segment);
    throw error;
  }
  const opened = await file.stat();
  await assertJournalFileLinkSafety(current, segment, options);
  if (!opened.isFile() || opened.nlink !== current.nlink || !sameFileNode(current, opened)) {
    throw new AuditJournalUnsafePathError(segment);
  }
}

async function openExistingRegularFile(
  path: string,
  flags: number,
  segment: string,
  options: JournalFileSafetyOptions = {}
): Promise<FileHandle> {
  const before = await lstat(path);
  await assertJournalFileLinkSafety(before, segment, options);
  const file = await open(path, flags);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== before.nlink || !sameFileNode(before, opened)) {
      throw new AuditJournalUnsafePathError(segment);
    }
    await assertHandleAtPath(file, path, segment, options);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function openNewRegularFile(path: string, segment: string): Promise<FileHandle> {
  const file = await open(path, createExclusiveFlags, 0o600);
  try {
    await assertHandleAtPath(file, path, segment);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function openRegularForAppend(path: string, segment: string): Promise<FileHandle> {
  try {
    return await openExistingRegularFile(path, appendWriteFlags, segment);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  try {
    return await openNewRegularFile(path, segment);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    return openExistingRegularFile(path, appendWriteFlags, segment);
  }
}

async function setRestrictiveMode(file: FileHandle, mode: number): Promise<void> {
  try {
    await file.chmod(mode);
  } catch (error) {
    if (!isUnsupportedModeError(error)) throw error;
  }
}

function reportPostCommitCloseFailure(): void {
  process.emitWarning("Miftah audit journal file handle could not be closed after a synced commit.");
}

function reportPostCommitIntegrityBackupFailure(): void {
  process.emitWarning("Miftah audit integrity rollback metadata could not be removed after a committed checkpoint.");
}

function reportPostCommitIntegrityTransactionCleanupFailure(): void {
  process.emitWarning("Miftah audit integrity transaction metadata could not be removed after a committed checkpoint.");
}

function reportPostCommitRetentionFailure(): void {
  process.emitWarning("Miftah audit retention cleanup could not be completed after a committed audit event.");
}

async function closeFile(file: FileHandle, committed: boolean): Promise<void> {
  try {
    await file.close();
  } catch (error) {
    if (committed) {
      reportPostCommitCloseFailure();
      return;
    }
    throw error;
  }
}

async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten <= 0) throw new Error("Audit journal write made no progress.");
    offset += bytesWritten;
  }
}

async function appendCompleteLine(path: string, line: string, segment: string): Promise<void> {
  const file = await openRegularForAppend(path, segment);
  let committed = false;
  let failure: unknown;
  let originalSize = 0;
  let canRollback = false;
  try {
    originalSize = (await file.stat()).size;
    canRollback = true;
    await setRestrictiveMode(file, 0o600);
    await writeAll(file, Buffer.from(line, "utf8"));
    await file.sync();
    await assertHandleAtPath(file, path, segment);
    committed = true;
  } catch (error) {
    if (canRollback) {
      try {
        await file.truncate(originalSize);
        await file.sync();
      } catch {
        failure = new Error("Audit journal write failed and rollback could not be completed.");
      }
    }
    failure ??= error;
  }
  try {
    await closeFile(file, committed);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

async function truncateRegularFile(path: string, size: number, segment: string): Promise<void> {
  const file = await openExistingRegularFile(path, writeOnlyFlags, segment);
  let committed = false;
  let failure: unknown;
  try {
    await file.truncate(size);
    await file.sync();
    await assertHandleAtPath(file, path, segment);
    committed = true;
  } catch (error) {
    failure = error;
  }
  try {
    await closeFile(file, committed);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

async function createEmptyActiveFile(location: AuditJournalLocation): Promise<void> {
  const file = await openNewRegularFile(location.activePath, location.basename);
  let committed = false;
  let failure: unknown;
  try {
    await setRestrictiveMode(file, 0o600);
    await file.sync();
    await assertHandleAtPath(file, location.activePath, location.basename);
    committed = true;
  } catch (error) {
    failure = error;
  }
  try {
    await closeFile(file, committed);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

async function ensureActiveFile(location: AuditJournalLocation): Promise<void> {
  const file = await openRegularForAppend(location.activePath, location.basename);
  let committed = false;
  let failure: unknown;
  try {
    await setRestrictiveMode(file, 0o600);
    await file.sync();
    await assertHandleAtPath(file, location.activePath, location.basename);
    committed = true;
  } catch (error) {
    failure = error;
  }
  try {
    await closeFile(file, committed);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

async function activeFileExists(location: AuditJournalLocation): Promise<boolean> {
  try {
    const entry = await lstat(location.activePath);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new AuditJournalUnsafePathError(location.basename);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function readTerminalByte(path: string, segment: string): Promise<number | undefined> {
  const file = await openExistingRegularFile(path, readOnlyFlags, segment);
  let failure: unknown;
  try {
    const { size } = await file.stat();
    if (size === 0) return undefined;
    const byte = Buffer.allocUnsafe(1);
    const { bytesRead } = await file.read(byte, 0, 1, size - 1);
    await assertHandleAtPath(file, path, segment);
    return bytesRead === 1 ? byte[0] : undefined;
  } catch (error) {
    failure = error;
  } finally {
    try {
      await closeFile(file, false);
    } catch (error) {
      failure ??= error;
    }
  }
  throw failure;
}

async function assertCompleteJsonlBoundary(location: AuditJournalLocation): Promise<void> {
  try {
    const terminalByte = await readTerminalByte(location.activePath, location.basename);
    if (terminalByte !== undefined && terminalByte !== 0x0a) {
      throw new Error("Audit journal has an incomplete prior record.");
    }
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

async function listManagedArchives(
  location: AuditJournalLocation,
  options: { readonly rejectUnsafe?: boolean } = {}
): Promise<ManagedArchive[]> {
  const pattern = archiveNamePattern(location.basename);
  const entries = await readdir(location.directory, { withFileTypes: true });
  const archives: ManagedArchive[] = [];
  for (const entry of entries) {
    const match = pattern.exec(entry.name);
    if (match === null) continue;
    const sequenceText = match[1];
    if (sequenceText === undefined) continue;
    const path = join(location.directory, entry.name);
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()) {
      if (options.rejectUnsafe) throw new AuditJournalUnsafePathError(entry.name);
      continue;
    }
    archives.push({ name: entry.name, path, sequence: BigInt(sequenceText), sequenceText });
  }
  return archives.sort((left, right) => {
    if (left.sequence < right.sequence) return -1;
    if (left.sequence > right.sequence) return 1;
    return left.name.localeCompare(right.name);
  });
}

async function shouldRotate(
  location: AuditJournalLocation,
  rotation: AuditRotationOptions,
  incomingBytes: number
): Promise<boolean> {
  try {
    const entry = await lstat(location.activePath);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new AuditJournalUnsafePathError(location.basename);
    if (entry.size === 0) return false;
    if (rotation.maxBytes !== undefined && entry.size + incomingBytes > rotation.maxBytes) return true;
    return rotation.maxAgeMs !== undefined && Date.now() - entry.mtimeMs >= rotation.maxAgeMs;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function plannedArchive(location: AuditJournalLocation, sequence: bigint): ManagedArchive {
  const name = archiveName(location.basename, sequence);
  return {
    name,
    path: join(location.directory, name),
    sequence,
    sequenceText: sequence.toString().padStart(archiveSequenceWidth, "0")
  };
}

async function rotateActiveSegment(location: AuditJournalLocation, archive: ManagedArchive): Promise<ManagedArchive> {
  const destination = archive.path;
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new AuditJournalUnsafePathError(archive.name);
    throw new Error("Audit journal rotation destination already exists.");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  const active = await lstat(location.activePath);
  if (active.isSymbolicLink() || !active.isFile()) throw new AuditJournalUnsafePathError(location.basename);
  await rename(location.activePath, destination);
  try {
    await createEmptyActiveFile(location);
  } catch (error) {
    try {
      await rename(destination, location.activePath);
    } catch (rollbackError) {
      throw new Error("Audit journal rotation could not restore its prior active segment.", { cause: rollbackError });
    }
    throw error;
  }
  return archive;
}

async function rollbackActiveRotation(location: AuditJournalLocation, archive: ManagedArchive): Promise<void> {
  const [active, sealed] = await Promise.all([lstat(location.activePath), lstat(archive.path)]);
  if (active.isSymbolicLink() || !active.isFile() || active.size !== 0) {
    throw new AuditJournalUnsafePathError(location.basename);
  }
  if (sealed.isSymbolicLink() || !sealed.isFile()) {
    throw new AuditJournalUnsafePathError(archive.name);
  }
  await rename(archive.path, location.activePath);
}

async function retainArchives(location: AuditJournalLocation, retainFiles: number): Promise<void> {
  const archives = await listManagedArchives(location);
  const excess = Math.max(0, archives.length - retainFiles);
  for (const archive of archives.slice(0, excess)) {
    const current = await lstat(archive.path);
    if (current.isSymbolicLink() || !current.isFile()) continue;
    await unlink(archive.path);
  }
}

async function copySnapshotSegment(
  sourcePath: string,
  destinationPath: string,
  segment: string
): Promise<string | undefined> {
  const before = await lstat(sourcePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new AuditJournalUnsafePathError(segment);
  const source = await openExistingRegularFile(sourcePath, readOnlyFlags, segment);
  let destination: FileHandle | undefined;
  let failure: unknown;
  try {
    const opened = await source.stat();
    if (!opened.isFile() || !sameSnapshot(before, opened)) {
      throw new AuditJournalUnsafePathError(segment);
    }
    destination = await openNewRegularFile(destinationPath, basename(destinationPath));
    await setRestrictiveMode(destination, 0o600);
    const chunk = Buffer.allocUnsafe(integrityReadChunkBytes);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      await writeAll(destination, chunk.subarray(0, bytesRead));
    }
    const after = await source.stat();
    if (!sameSnapshot(opened, after)) throw new AuditJournalUnsafePathError(segment);
    await assertHandleAtPath(source, sourcePath, segment);
    await destination.sync();
    await assertHandleAtPath(destination, destinationPath, basename(destinationPath));
  } catch (error) {
    failure = error;
  }
  try {
    if (destination !== undefined) await closeFile(destination, failure === undefined);
  } catch (error) {
    failure ??= error;
  }
  try {
    await closeFile(source, false);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  return fileIdentity(before);
}

async function createSnapshotDirectory(temporaryDirectory?: string): Promise<string> {
  const directory = await mkdtemp(join(temporaryDirectory ?? tmpdir(), "miftah-audit-journal-"));
  try {
    await chmod(directory, 0o700);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Copies a stable managed-segment set into a private snapshot for readers and exports. */
export async function snapshotAuditJournal(
  path: string,
  options: AuditJournalSnapshotOptions = {}
): Promise<AuditJournalSnapshot> {
  let location: AuditJournalLocation;
  try {
    location = await resolveJournalLocation(path, { createDirectory: false });
  } catch (error) {
    if (options.allowEmpty && isMissingAuditJournalPathError(error)) {
      return { segments: [], cleanup: async () => undefined };
    }
    throw asAuditJournalUnavailableError(error);
  }
  let snapshotDirectory: string | undefined;
  try {
    const segments = await withJournalLock(location, async () => {
      const sourceSegments = (await listManagedArchives(location, { rejectUnsafe: true })).map((segment) => ({
        name: segment.name,
        path: segment.path
      }));
      if (await activeFileExists(location)) {
        sourceSegments.push({ name: location.basename, path: location.activePath });
      }
      if (sourceSegments.length === 0) {
        if (options.allowEmpty) return [];
        throw new Error("Audit journal is not available.");
      }
      snapshotDirectory = await createSnapshotDirectory(options.temporaryDirectory);
      const copiedSegments: { name: string; path: string; identity?: string }[] = [];
      for (const [index, segment] of sourceSegments.entries()) {
        const snapshotPath = join(snapshotDirectory, `${index.toString().padStart(6, "0")}.jsonl`);
        const identity = await copySnapshotSegment(segment.path, snapshotPath, segment.name);
        copiedSegments.push({ name: segment.name, path: snapshotPath, identity });
      }
      return copiedSegments;
    });
    const directory = snapshotDirectory;
    return {
      segments,
      cleanup: async () => {
        if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    if (snapshotDirectory !== undefined) {
      try {
        await rm(snapshotDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw asAuditJournalUnavailableError(cleanupError);
      }
    }
    if (options.allowEmpty && isMissingAuditJournalPathError(error)) {
      return { segments: [], cleanup: async () => undefined };
    }
    throw asAuditJournalUnavailableError(error);
  }
}

function activeState(
  basename: string,
  byteLength: number,
  recordCount: number,
  firstPreviousHash: string | null,
  tailHash: string | null
): ActiveSegmentState {
  return { name: basename, byteLength, recordCount, firstPreviousHash, tailHash };
}

function archiveState(active: ActiveSegmentState, archive: ManagedArchive): ArchivedSegmentState {
  return { ...active, name: archive.name, sequence: archive.sequenceText };
}

function stateForEmptyActive(location: AuditJournalLocation, previousHash: string | null): ActiveSegmentState {
  return activeState(location.basename, 0, 0, previousHash, null);
}

function checkpointPayload(checkpoint: Omit<IntegrityCheckpoint, "stateHash">): Record<string, unknown> {
  return {
    version: checkpoint.version,
    chainId: checkpoint.chainId,
    anchorHash: checkpoint.anchorHash,
    archives: checkpoint.archives,
    active: checkpoint.active,
    ledgerEntry: checkpoint.ledgerEntry,
    ledgerHash: checkpoint.ledgerHash,
    ledgerSize: checkpoint.ledgerSize
  };
}

function withCheckpointHash(checkpoint: Omit<IntegrityCheckpoint, "stateHash">): IntegrityCheckpoint {
  return { ...checkpoint, stateHash: calculateCheckpointHash(checkpointPayload(checkpoint)) };
}

function ledgerPayload(entry: Omit<IntegrityLedgerEntry, "entryHash">): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    version: entry.version,
    kind: entry.kind,
    entry: entry.entry,
    chainId: entry.chainId,
    previousEntryHash: entry.previousEntryHash,
    active: entry.active
  };
  if (entry.checkpoint !== undefined) payload.checkpoint = entry.checkpoint;
  if (entry.sealed !== undefined) payload.sealed = entry.sealed;
  if (entry.retired !== undefined) payload.retired = entry.retired;
  return payload;
}

function withLedgerHash(entry: Omit<IntegrityLedgerEntry, "entryHash">): IntegrityLedgerEntry {
  return { ...entry, entryHash: calculateLedgerHash(ledgerPayload(entry)) };
}

function transactionPayload(transaction: Omit<IntegrityTransaction, "transactionHash">): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    version: transaction.version,
    kind: transaction.kind,
    phase: transaction.phase,
    priorStateHash: transaction.priorStateHash,
    priorLedgerSize: transaction.priorLedgerSize,
    priorLedgerHash: transaction.priorLedgerHash,
    nextStateHash: transaction.nextStateHash,
    nextLedgerSize: transaction.nextLedgerSize,
    nextLedgerHash: transaction.nextLedgerHash
  };
  if (transaction.archive !== undefined) payload.archive = transaction.archive;
  if (transaction.retiredArchives !== undefined) payload.retiredArchives = transaction.retiredArchives;
  return payload;
}

function withTransactionHash(transaction: Omit<IntegrityTransaction, "transactionHash">): IntegrityTransaction {
  return { ...transaction, transactionHash: calculateTransactionHash(transactionPayload(transaction)) };
}

function createIntegrityTransaction(
  kind: IntegrityTransactionKind,
  prior: IntegrityCheckpoint | undefined,
  next: IntegrityCheckpoint,
  details: IntegrityTransactionDetails = {}
): IntegrityTransaction {
  return withTransactionHash({
    version: 1,
    kind,
    phase: "pending",
    priorStateHash: prior?.stateHash ?? null,
    priorLedgerSize: prior?.ledgerSize ?? 0,
    priorLedgerHash: prior?.ledgerHash ?? null,
    nextStateHash: next.stateHash,
    nextLedgerSize: next.ledgerSize,
    nextLedgerHash: next.ledgerHash,
    ...(details.archive === undefined
      ? {}
      : { archive: { name: details.archive.name, sequence: details.archive.sequenceText } }),
    ...(details.retiredArchives === undefined ? {} : { retiredArchives: details.retiredArchives.map((archive) => archive.name) })
  });
}

function parseActiveState(value: unknown, location: AuditJournalLocation): ActiveSegmentState {
  if (!isRecord(value)) throw new Error("Audit integrity checkpoint is invalid.");
  const { name, byteLength, recordCount, firstPreviousHash, tailHash } = value;
  if (
    name !== location.basename ||
    !isSafeNonNegativeInteger(byteLength) ||
    !isSafeNonNegativeInteger(recordCount) ||
    !isHashOrNull(firstPreviousHash) ||
    !isHashOrNull(tailHash)
  ) {
    throw new Error("Audit integrity checkpoint is invalid.");
  }
  if ((recordCount === 0 && (byteLength !== 0 || tailHash !== null)) || (recordCount > 0 && (byteLength === 0 || tailHash === null))) {
    throw new Error("Audit integrity checkpoint is invalid.");
  }
  return { name, byteLength, recordCount, firstPreviousHash, tailHash };
}

function parseArchivedState(value: unknown, location: AuditJournalLocation): ArchivedSegmentState {
  if (!isRecord(value)) throw new Error("Audit integrity checkpoint is invalid.");
  const active = parseActiveState({ ...value, name: location.basename }, location);
  const { name, sequence } = value;
  if (typeof name !== "string" || typeof sequence !== "string" || !/^[0-9]{20}$/u.test(sequence)) {
    throw new Error("Audit integrity checkpoint is invalid.");
  }
  if (archiveSequenceFromName(location.basename, name) !== sequence || active.recordCount === 0) {
    throw new Error("Audit integrity checkpoint is invalid.");
  }
  return { ...active, name, sequence };
}

function parseCheckpoint(value: unknown, location: AuditJournalLocation): IntegrityCheckpoint {
  if (!isRecord(value)) throw new Error("Audit integrity checkpoint is invalid.");
  const { version, chainId, anchorHash, archives, active, ledgerEntry, ledgerHash, ledgerSize, stateHash } = value;
  if (
    version !== 1 ||
    typeof chainId !== "string" ||
    !uuidPattern.test(chainId) ||
    !isHashOrNull(anchorHash) ||
    !Array.isArray(archives) ||
    !isSafeNonNegativeInteger(ledgerEntry) ||
    ledgerEntry === 0 ||
    typeof ledgerHash !== "string" ||
    !hashPattern.test(ledgerHash) ||
    !isSafeNonNegativeInteger(ledgerSize) ||
    ledgerSize === 0 ||
    typeof stateHash !== "string" ||
    !hashPattern.test(stateHash)
  ) {
    throw new Error("Audit integrity checkpoint is invalid.");
  }
  const parsedArchives = archives.map((archive) => parseArchivedState(archive, location));
  const names = new Set<string>();
  let previousSequence = -1n;
  for (const archive of parsedArchives) {
    if (names.has(archive.name) || BigInt(archive.sequence) <= previousSequence) {
      throw new Error("Audit integrity checkpoint is invalid.");
    }
    names.add(archive.name);
    previousSequence = BigInt(archive.sequence);
  }
  const checkpoint = {
    version,
    chainId,
    anchorHash,
    archives: parsedArchives,
    active: parseActiveState(active, location),
    ledgerEntry,
    ledgerHash,
    ledgerSize,
    stateHash
  } as IntegrityCheckpoint;
  if (calculateCheckpointHash(checkpointPayload(checkpoint)) !== checkpoint.stateHash) {
    throw new Error("Audit integrity checkpoint is invalid.");
  }
  return checkpoint;
}

function parseRetirement(value: unknown): IntegrityRetirement {
  if (!isRecord(value)) throw new Error("Audit integrity ledger is invalid.");
  const { throughSequence, anchorHash } = value;
  if (typeof throughSequence !== "string" || !/^[0-9]{20}$/u.test(throughSequence) || typeof anchorHash !== "string" || !hashPattern.test(anchorHash)) {
    throw new Error("Audit integrity ledger is invalid.");
  }
  return { throughSequence, anchorHash };
}

function parseLedgerCheckpoint(value: unknown, location: AuditJournalLocation): IntegrityLedgerCheckpoint {
  if (!isRecord(value) || !isHashOrNull(value.anchorHash) || !Array.isArray(value.archives)) {
    throw new Error("Audit integrity ledger is invalid.");
  }
  const archives = value.archives.map((archive) => parseArchivedState(archive, location));
  let previousSequence = -1n;
  for (const archive of archives) {
    if (BigInt(archive.sequence) <= previousSequence) throw new Error("Audit integrity ledger is invalid.");
    previousSequence = BigInt(archive.sequence);
  }
  return { anchorHash: value.anchorHash, archives };
}

function parseLedgerEntry(value: unknown, location: AuditJournalLocation): IntegrityLedgerEntry {
  if (!isRecord(value)) throw new Error("Audit integrity ledger is invalid.");
  const { version, kind, entry, chainId, previousEntryHash, active, checkpoint, sealed, retired, entryHash } = value;
  if (
    version !== 1 ||
    (kind !== "initialize" && kind !== "checkpoint" && kind !== "append" && kind !== "rotate" && kind !== "retire") ||
    !isSafeNonNegativeInteger(entry) ||
    entry === 0 ||
    typeof chainId !== "string" ||
    !uuidPattern.test(chainId) ||
    !isHashOrNull(previousEntryHash) ||
    typeof entryHash !== "string" ||
    !hashPattern.test(entryHash)
  ) {
    throw new Error("Audit integrity ledger is invalid.");
  }
  const parsed: Omit<IntegrityLedgerEntry, "entryHash"> = {
    version,
    kind,
    entry,
    chainId,
    previousEntryHash,
    active: parseActiveState(active, location),
    ...(kind === "checkpoint" ? { checkpoint: parseLedgerCheckpoint(checkpoint, location) } : {}),
    ...(kind === "rotate" ? { sealed: parseArchivedState(sealed, location) } : {}),
    ...(retired === undefined ? {} : { retired: parseRetirement(retired) })
  };
  if ((kind === "initialize" || kind === "append" || kind === "checkpoint") && (sealed !== undefined || retired !== undefined)) {
    throw new Error("Audit integrity ledger is invalid.");
  }
  if (kind !== "checkpoint" && checkpoint !== undefined) throw new Error("Audit integrity ledger is invalid.");
  if (kind === "retire" && retired === undefined) throw new Error("Audit integrity ledger is invalid.");
  if (calculateLedgerHash(ledgerPayload(parsed)) !== entryHash) {
    throw new Error("Audit integrity ledger is invalid.");
  }
  return { ...parsed, entryHash };
}

function parseIntegrityTransaction(value: unknown, location: AuditJournalLocation): IntegrityTransaction {
  if (!isRecord(value)) throw new Error("Audit integrity transaction is invalid.");
  const {
    version,
    kind,
    phase,
    priorStateHash,
    priorLedgerSize,
    priorLedgerHash,
    nextStateHash,
    nextLedgerSize,
    nextLedgerHash,
    archive,
    retiredArchives,
    transactionHash
  } = value;
  if (
    version !== 1 ||
    (kind !== "initialize" && kind !== "append" && kind !== "rotate" && kind !== "retire") ||
    (phase !== "pending" && phase !== "committed") ||
    !isHashOrNull(priorStateHash) ||
    !isSafeNonNegativeInteger(priorLedgerSize) ||
    !isHashOrNull(priorLedgerHash) ||
    typeof nextStateHash !== "string" ||
    !hashPattern.test(nextStateHash) ||
    !isSafeNonNegativeInteger(nextLedgerSize) ||
    nextLedgerSize === 0 ||
    typeof nextLedgerHash !== "string" ||
    !hashPattern.test(nextLedgerHash) ||
    typeof transactionHash !== "string" ||
    !hashPattern.test(transactionHash)
  ) {
    throw new Error("Audit integrity transaction is invalid.");
  }
  if ((priorStateHash === null) !== (priorLedgerHash === null) || (priorStateHash === null && priorLedgerSize !== 0)) {
    throw new Error("Audit integrity transaction is invalid.");
  }
  let parsedArchive: IntegrityTransaction["archive"];
  if (archive !== undefined) {
    if (!isRecord(archive) || typeof archive.name !== "string" || typeof archive.sequence !== "string") {
      throw new Error("Audit integrity transaction is invalid.");
    }
    if (archiveSequenceFromName(location.basename, archive.name) !== archive.sequence) {
      throw new Error("Audit integrity transaction is invalid.");
    }
    parsedArchive = { name: archive.name, sequence: archive.sequence };
  }
  let parsedRetiredArchives: readonly string[] | undefined;
  if (retiredArchives !== undefined) {
    if (!Array.isArray(retiredArchives) || retiredArchives.some((name) => typeof name !== "string")) {
      throw new Error("Audit integrity transaction is invalid.");
    }
    const names = retiredArchives as string[];
    if (
      new Set(names).size !== names.length ||
      names.some((name) => archiveSequenceFromName(location.basename, name) === undefined)
    ) {
      throw new Error("Audit integrity transaction is invalid.");
    }
    parsedRetiredArchives = names;
  }
  if (
    (kind === "initialize" && priorStateHash !== null) ||
    (kind !== "initialize" && priorStateHash === null) ||
    (kind === "rotate") !== (parsedArchive !== undefined) ||
    (kind === "retire") !== (parsedRetiredArchives !== undefined) ||
    (kind !== "rotate" && parsedArchive !== undefined) ||
    (kind !== "retire" && parsedRetiredArchives !== undefined)
  ) {
    throw new Error("Audit integrity transaction is invalid.");
  }
  const parsed: Omit<IntegrityTransaction, "transactionHash"> = {
    version,
    kind,
    phase,
    priorStateHash,
    priorLedgerSize,
    priorLedgerHash,
    nextStateHash,
    nextLedgerSize,
    nextLedgerHash,
    ...(parsedArchive === undefined ? {} : { archive: parsedArchive }),
    ...(parsedRetiredArchives === undefined ? {} : { retiredArchives: parsedRetiredArchives })
  };
  if (calculateTransactionHash(transactionPayload(parsed)) !== transactionHash) {
    throw new Error("Audit integrity transaction is invalid.");
  }
  return { ...parsed, transactionHash };
}

async function readSafeFile(
  path: string,
  segment: string,
  maximumBytes: number,
  options: JournalFileSafetyOptions = {}
): Promise<Buffer> {
  const file = await openExistingRegularFile(path, readOnlyFlags, segment, options);
  let failure: unknown;
  let contents: Buffer | undefined;
  try {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
      throw new Error("Audit journal file exceeds its safe size limit.");
    }
    contents = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await file.read(contents, offset, contents.length - offset, offset);
      if (bytesRead === 0) throw new Error("Audit journal file changed while reading.");
      offset += bytesRead;
    }
    await assertHandleAtPath(file, path, segment, options);
  } catch (error) {
    failure = error;
  }
  try {
    await closeFile(file, false);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  return contents!;
}

async function readLastLedgerEntryAtPath(
  location: AuditJournalLocation,
  path: string,
  segment: string,
  options: JournalFileSafetyOptions = {}
): Promise<IntegrityLedgerEntry> {
  const file = await openExistingRegularFile(path, readOnlyFlags, segment, options);
  let failure: unknown;
  let entry: IntegrityLedgerEntry | undefined;
  try {
    const { size } = await file.stat();
    if (size === 0 || size > Number.MAX_SAFE_INTEGER) throw new Error("Audit integrity ledger is invalid.");
    const bytesToRead = Math.min(size, maximumLedgerRecordBytes + 1);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, size - bytesToRead);
    if (bytesRead !== bytesToRead || buffer.at(-1) !== 0x0a) throw new Error("Audit integrity ledger is invalid.");
    const previousNewline = buffer.lastIndexOf(0x0a, buffer.length - 2);
    if (previousNewline === -1 && bytesToRead === maximumLedgerRecordBytes + 1 && size > bytesToRead) {
      throw new Error("Audit integrity ledger record is too large.");
    }
    const line = buffer.subarray(previousNewline + 1, buffer.length - 1);
    if (line.length === 0 || line.length > maximumLedgerRecordBytes) throw new Error("Audit integrity ledger is invalid.");
    entry = parseLedgerEntry(JSON.parse(line.toString("utf8")) as unknown, location);
    await assertHandleAtPath(file, path, segment, options);
  } catch (error) {
    failure = error;
  }
  try {
    await closeFile(file, false);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  return entry!;
}

async function fileExistsSafely(path: string, segment: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new AuditJournalUnsafePathError(segment);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function readCheckpointFileOnly(
  location: AuditJournalLocation,
  options: JournalFileSafetyOptions = {}
): Promise<IntegrityCheckpoint | undefined> {
  if (!(await fileExistsSafely(location.integrityCheckpointPath, basename(location.integrityCheckpointPath)))) return undefined;
  return parseCheckpoint(
    JSON.parse(
      (
        await readSafeFile(
          location.integrityCheckpointPath,
          basename(location.integrityCheckpointPath),
          maximumCheckpointBytes,
          options
        )
      ).toString("utf8")
    ) as unknown,
    location
  );
}

async function ledgerMatchesCheckpoint(
  location: AuditJournalLocation,
  path: string,
  segment: string,
  checkpoint: IntegrityCheckpoint,
  options: JournalFileSafetyOptions = {}
): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== checkpoint.ledgerSize) return false;
    const last = await readLastLedgerEntryAtPath(location, path, segment, options);
    return last.entry === checkpoint.ledgerEntry && last.entryHash === checkpoint.ledgerHash && last.chainId === checkpoint.chainId;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function removeRegularFile(path: string, segment: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new AuditJournalUnsafePathError(segment);
    await unlink(path);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

async function readIntegrityTransaction(location: AuditJournalLocation): Promise<IntegrityTransaction | undefined> {
  if (!(await fileExistsSafely(location.integrityTransactionPath, location.integrityTransactionName))) return undefined;
  return parseIntegrityTransaction(
    JSON.parse(
      (
        await readSafeFile(location.integrityTransactionPath, location.integrityTransactionName, maximumCheckpointBytes)
      ).toString("utf8")
    ) as unknown,
    location
  );
}

/** Removes only a verified orphan from the pre-marker backup-creation crash window. */
async function recoverOrphanIntegrityPriorCheckpointBackup(location: AuditJournalLocation): Promise<void> {
  if ((await readIntegrityTransaction(location)) !== undefined) return;
  if (!(await fileExistsSafely(location.integrityPriorCheckpointPath, location.integrityPriorCheckpointName))) return;
  const checkpoint = await readCheckpointFileOnly(location, checkpointWithPriorBackupSafety(location));
  if (checkpoint === undefined) {
    throw new Error("Audit integrity transaction prior checkpoint backup is unavailable.");
  }
  const [current, backup] = await Promise.all([
    lstat(location.integrityCheckpointPath),
    lstat(location.integrityPriorCheckpointPath)
  ]);
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    backup.isSymbolicLink() ||
    !backup.isFile() ||
    !sameFileNode(current, backup)
  ) {
    throw new Error("Audit integrity transaction prior checkpoint backup is ambiguous.");
  }
  const prior = parseCheckpoint(
    JSON.parse(
      (
        await readSafeFile(
          location.integrityPriorCheckpointPath,
          location.integrityPriorCheckpointName,
          maximumCheckpointBytes,
          priorCheckpointBackupSafety(location)
        )
      ).toString("utf8")
    ) as unknown,
    location
  );
  if (prior.stateHash !== checkpoint.stateHash) {
    throw new Error("Audit integrity transaction prior checkpoint backup is invalid.");
  }
  await removeRegularFile(location.integrityPriorCheckpointPath, location.integrityPriorCheckpointName);
}

async function createIntegrityPriorCheckpointBackup(
  location: AuditJournalLocation,
  prior: IntegrityCheckpoint
): Promise<void> {
  try {
    const existing = await lstat(location.integrityPriorCheckpointPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new AuditJournalUnsafePathError(location.integrityPriorCheckpointName);
    }
    throw new Error("Audit integrity transaction prior checkpoint backup already exists.");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  const source = await lstat(location.integrityCheckpointPath);
  await assertJournalFileLinkSafety(source, basename(location.integrityCheckpointPath));
  await link(location.integrityCheckpointPath, location.integrityPriorCheckpointPath);
  const [current, backup] = await Promise.all([
    lstat(location.integrityCheckpointPath),
    lstat(location.integrityPriorCheckpointPath)
  ]);
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    backup.isSymbolicLink() ||
    !backup.isFile() ||
    !sameFileNode(current, backup)
  ) {
    throw new AuditJournalUnsafePathError(location.integrityPriorCheckpointName);
  }
  await assertJournalFileLinkSafety(current, basename(location.integrityCheckpointPath), checkpointWithPriorBackupSafety(location));
  await assertJournalFileLinkSafety(backup, location.integrityPriorCheckpointName, priorCheckpointBackupSafety(location));
  const parsed = parseCheckpoint(
    JSON.parse(
      (
        await readSafeFile(
          location.integrityPriorCheckpointPath,
          location.integrityPriorCheckpointName,
          maximumCheckpointBytes,
          priorCheckpointBackupSafety(location)
        )
      ).toString("utf8")
    ) as unknown,
    location
  );
  if (parsed.stateHash !== prior.stateHash) {
    throw new Error("Audit integrity transaction prior checkpoint backup does not match its checkpoint.");
  }
}

async function readIntegrityPriorCheckpoint(
  location: AuditJournalLocation,
  transaction: IntegrityTransaction
): Promise<IntegrityCheckpoint | undefined> {
  if (transaction.priorStateHash === null) return undefined;
  if (!(await fileExistsSafely(location.integrityPriorCheckpointPath, location.integrityPriorCheckpointName))) {
    throw new Error("Audit integrity transaction prior checkpoint backup is unavailable.");
  }
  const prior = parseCheckpoint(
    JSON.parse(
      (
        await readSafeFile(
          location.integrityPriorCheckpointPath,
          location.integrityPriorCheckpointName,
          maximumCheckpointBytes,
          priorCheckpointBackupSafety(location)
        )
      ).toString("utf8")
    ) as unknown,
    location
  );
  if (
    prior.stateHash !== transaction.priorStateHash ||
    prior.ledgerSize !== transaction.priorLedgerSize ||
    prior.ledgerHash !== transaction.priorLedgerHash
  ) {
    throw new Error("Audit integrity transaction prior checkpoint backup is invalid.");
  }
  return prior;
}

async function beginIntegrityTransaction(
  location: AuditJournalLocation,
  transaction: IntegrityTransaction,
  prior: IntegrityCheckpoint | undefined
): Promise<void> {
  if (await readIntegrityTransaction(location)) {
    throw new Error("Audit integrity transaction is already active.");
  }
  if (await fileExistsSafely(location.integrityPriorCheckpointPath, location.integrityPriorCheckpointName)) {
    throw new Error("Audit integrity transaction prior checkpoint backup already exists.");
  }
  let markerWritten = false;
  try {
    await replacePrivateFile(
      location,
      location.integrityTransactionPath,
      location.integrityTransactionName,
      "miftah-integrity-transaction",
      Buffer.from(JSON.stringify(transaction), "utf8")
    );
    markerWritten = true;
    if (prior !== undefined) await createIntegrityPriorCheckpointBackup(location, prior);
  } catch (error) {
    if (markerWritten) {
      try {
        await recoverIntegrityTransaction(location);
      } catch (cleanupError) {
        throw new Error("Audit integrity transaction could not recover its durable intent record.", { cause: cleanupError });
      }
    }
    throw error;
  }
}

/** Persists the irreversible decision only after the next physical journal state verifies. */
async function markIntegrityTransactionCommitted(
  location: AuditJournalLocation,
  transaction: IntegrityTransaction,
  next: IntegrityCheckpoint
): Promise<IntegrityTransaction> {
  await validateIntegrityCheckpoint(location, next);
  if (transaction.phase === "committed") return transaction;
  const committed = withTransactionHash({ ...transaction, phase: "committed" });
  await replacePrivateFile(
    location,
    location.integrityTransactionPath,
    location.integrityTransactionName,
    "miftah-integrity-transaction",
    Buffer.from(JSON.stringify(committed), "utf8")
  );
  return committed;
}

async function completeIntegrityTransaction(location: AuditJournalLocation): Promise<void> {
  try {
    await removeRegularFile(location.integrityPriorCheckpointPath, location.integrityPriorCheckpointName);
    await removeRegularFile(location.integrityTransactionPath, location.integrityTransactionName);
  } catch {
    reportPostCommitIntegrityTransactionCleanupFailure();
  }
}

type IntegrityTransactionCheckpointState = "prior" | "next";
type IntegrityTransactionLedgerState = "prior" | "next";

async function transactionLedgerMatches(
  location: AuditJournalLocation,
  expectedSize: number,
  expectedHash: string | null
): Promise<boolean> {
  const present = await fileExistsSafely(location.integrityLedgerPath, location.integrityLedgerName);
  if (expectedSize === 0 && expectedHash === null) {
    if (!present) return true;
    const empty = await lstat(location.integrityLedgerPath);
    return empty.isFile() && !empty.isSymbolicLink() && empty.size === 0;
  }
  if (!present || expectedHash === null) return false;
  const stats = await lstat(location.integrityLedgerPath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== expectedSize) return false;
  const last = await readLastLedgerEntryAtPath(location, location.integrityLedgerPath, location.integrityLedgerName);
  return last.entryHash === expectedHash;
}

async function classifyIntegrityTransactionLedger(
  location: AuditJournalLocation,
  transaction: IntegrityTransaction
): Promise<IntegrityTransactionLedgerState> {
  if (
    await transactionLedgerMatches(location, transaction.nextLedgerSize, transaction.nextLedgerHash)
  ) {
    return "next";
  }
  if (
    await transactionLedgerMatches(location, transaction.priorLedgerSize, transaction.priorLedgerHash)
  ) {
    return "prior";
  }
  throw new Error("Audit integrity transaction ledger state is ambiguous.");
}

function classifyIntegrityTransactionCheckpoint(
  transaction: IntegrityTransaction,
  current: IntegrityCheckpoint | undefined
): IntegrityTransactionCheckpointState {
  if (current?.stateHash === transaction.nextStateHash) return "next";
  if (transaction.priorStateHash === null && current === undefined) return "prior";
  if (current?.stateHash === transaction.priorStateHash) return "prior";
  throw new Error("Audit integrity transaction checkpoint state is ambiguous.");
}

async function matchesIntegrityCheckpoint(location: AuditJournalLocation, checkpoint: IntegrityCheckpoint): Promise<boolean> {
  try {
    await validateIntegrityCheckpoint(location, checkpoint);
    return true;
  } catch (error) {
    if (error instanceof AuditIntegrityMismatchError) return false;
    throw error;
  }
}

async function restoreAppendTransactionPhysical(
  location: AuditJournalLocation,
  prior: IntegrityCheckpoint
): Promise<void> {
  const active = await lstat(location.activePath);
  if (active.isSymbolicLink() || !active.isFile() || active.size < prior.active.byteLength) {
    throw new AuditJournalUnsafePathError(location.basename);
  }
  if (active.size > prior.active.byteLength) {
    await truncateRegularFile(location.activePath, prior.active.byteLength, location.basename);
  }
}

async function restoreRotateTransactionPhysical(
  location: AuditJournalLocation,
  transaction: IntegrityTransaction,
  prior: IntegrityCheckpoint
): Promise<void> {
  if (await matchesIntegrityCheckpoint(location, prior)) return;
  const archive = transaction.archive;
  if (archive === undefined) throw new Error("Audit integrity rotation transaction is invalid.");
  const sequence = BigInt(archive.sequence);
  const planned: ManagedArchive = {
    name: archive.name,
    path: join(location.directory, archive.name),
    sequence,
    sequenceText: archive.sequence
  };
  const archivePresent = await fileExistsSafely(planned.path, planned.name);
  if (!archivePresent) throw new Error("Audit integrity rotation recovery is unavailable.");
  if (!(await activeFileExists(location))) {
    await rename(planned.path, location.activePath);
  } else {
    await rollbackActiveRotation(location, planned);
  }
}

async function restoreRetireTransactionPhysical(
  location: AuditJournalLocation,
  transaction: IntegrityTransaction,
  prior: IntegrityCheckpoint
): Promise<void> {
  const retired = transaction.retiredArchives;
  if (retired === undefined) throw new Error("Audit integrity retirement transaction is invalid.");
  for (const name of retired) {
    const archive = prior.archives.find((candidate) => candidate.name === name);
    if (archive === undefined) throw new Error("Audit integrity retirement transaction is invalid.");
    const stagedPath = join(location.directory, retiredArchiveName(archive));
    const destination = join(location.directory, archive.name);
    const staged = await fileExistsSafely(stagedPath, retiredArchiveName(archive));
    const original = await fileExistsSafely(destination, archive.name);
    if (staged && original) throw new Error("Audit integrity retirement recovery is ambiguous.");
    if (!staged && !original) throw new Error("Audit integrity retirement recovery is unavailable.");
    if (staged) await rename(stagedPath, destination);
  }
}

async function restoreIntegrityTransactionPhysical(
  location: AuditJournalLocation,
  transaction: IntegrityTransaction,
  prior: IntegrityCheckpoint | undefined
): Promise<void> {
  if (transaction.kind === "initialize") {
    if (!(await activeFileExists(location))) await ensureActiveFile(location);
    const active = await lstat(location.activePath);
    if (active.isSymbolicLink() || !active.isFile() || active.size !== 0) {
      throw new AuditJournalUnsafePathError(location.basename);
    }
    return;
  }
  if (prior === undefined) throw new Error("Audit integrity transaction prior checkpoint is unavailable.");
  if (transaction.kind === "append") await restoreAppendTransactionPhysical(location, prior);
  else if (transaction.kind === "rotate") await restoreRotateTransactionPhysical(location, transaction, prior);
  else await restoreRetireTransactionPhysical(location, transaction, prior);
  if (!(await matchesIntegrityCheckpoint(location, prior))) {
    throw new Error("Audit integrity transaction could not restore its prior journal state.");
  }
}

async function finalizeIntegrityTransactionPhysical(
  location: AuditJournalLocation,
  transaction: IntegrityTransaction,
  next: IntegrityCheckpoint
): Promise<void> {
  await validateIntegrityCheckpoint(location, next);
  if (transaction.kind === "retire") {
    const retired = transaction.retiredArchives;
    if (retired === undefined) throw new Error("Audit integrity retirement transaction is invalid.");
    for (const name of retired) {
      const stagedName = `.${name}.miftah-retiring`;
      await removeRegularFile(join(location.directory, stagedName), stagedName);
    }
  }
}

async function restoreIntegrityTransactionMetadata(
  location: AuditJournalLocation,
  prior: IntegrityCheckpoint | undefined
): Promise<void> {
  if (prior === undefined) {
    await removeCheckpoint(location);
    await removeRegularFile(location.integrityLedgerPath, location.integrityLedgerName);
    if (!(await transactionLedgerMatches(location, 0, null))) {
      throw new Error("Audit integrity transaction ledger could not be restored to its prior state.");
    }
    return;
  }
  const current = await readCheckpointFileOnly(location, checkpointWithPriorBackupSafety(location));
  if (current?.stateHash !== prior.stateHash) await writeCheckpoint(location, prior);
  if (!(await transactionLedgerMatches(location, prior.ledgerSize, prior.ledgerHash))) {
    const ledger = await lstat(location.integrityLedgerPath);
    if (ledger.isSymbolicLink() || !ledger.isFile()) {
      throw new AuditJournalUnsafePathError(location.integrityLedgerName);
    }
    if (ledger.size < prior.ledgerSize) {
      throw new Error("Audit integrity transaction ledger cannot be safely restored.");
    }
    await truncateRegularFile(location.integrityLedgerPath, prior.ledgerSize, location.integrityLedgerName);
  }
  if (!(await transactionLedgerMatches(location, prior.ledgerSize, prior.ledgerHash))) {
    throw new Error("Audit integrity transaction ledger could not be restored to its prior state.");
  }
}

/** Reconciles a fully-described interrupted integrity transaction before accepting a new mutation. */
async function recoverIntegrityTransaction(location: AuditJournalLocation): Promise<void> {
  const transaction = await readIntegrityTransaction(location);
  if (transaction === undefined) return;
  await recoverIntegrityLedgerReplacement(location);
  const current = await readCheckpointFileOnly(location, checkpointWithPriorBackupSafety(location));
  const checkpointState = classifyIntegrityTransactionCheckpoint(transaction, current);
  let ledgerState: IntegrityTransactionLedgerState;
  try {
    ledgerState = await classifyIntegrityTransactionLedger(location, transaction);
  } catch (error) {
    if (
      transaction.phase === "pending" &&
      checkpointState === "prior" &&
      (transaction.kind === "initialize" || transaction.kind === "append")
    ) {
      await restoreIntegrityTransactionPhysical(location, transaction, current);
      await restoreIntegrityTransactionMetadata(location, current);
      await completeIntegrityTransaction(location);
      return;
    }
    throw error;
  }
  if (transaction.phase === "committed") {
    if (checkpointState !== "next" || ledgerState !== "next" || current === undefined) {
      throw new Error("Audit integrity committed transaction metadata is unavailable.");
    }
    await finalizeIntegrityTransactionPhysical(location, transaction, current);
    await completeIntegrityTransaction(location);
    return;
  }
  if (checkpointState === "next" && ledgerState === "next" && current !== undefined) {
    if (await matchesIntegrityCheckpoint(location, current)) {
      const committed = await markIntegrityTransactionCommitted(location, transaction, current);
      await finalizeIntegrityTransactionPhysical(location, committed, current);
      await completeIntegrityTransaction(location);
      return;
    }
    if (transaction.kind !== "append" && transaction.kind !== "initialize") {
      throw new Error("Audit integrity transaction completed metadata does not match its journal.");
    }
  }
  const prior =
    checkpointState === "prior"
      ? current
      : await readIntegrityPriorCheckpoint(location, transaction);
  await restoreIntegrityTransactionPhysical(location, transaction, prior);
  await restoreIntegrityTransactionMetadata(location, prior);
  await completeIntegrityTransaction(location);
}

/** Makes a verified same-directory hard-link rollback copy before atomically replacing the ledger. */
async function createIntegrityLedgerBackup(location: AuditJournalLocation): Promise<void> {
  try {
    const existing = await lstat(location.integrityLedgerBackupPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new AuditJournalUnsafePathError(location.integrityLedgerBackupName);
    }
    throw new Error("Audit integrity ledger replacement backup already exists.");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  const source = await lstat(location.integrityLedgerPath);
  await assertJournalFileLinkSafety(source, location.integrityLedgerName);
  await link(location.integrityLedgerPath, location.integrityLedgerBackupPath);
  const [current, backup] = await Promise.all([
    lstat(location.integrityLedgerPath),
    lstat(location.integrityLedgerBackupPath)
  ]);
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    backup.isSymbolicLink() ||
    !backup.isFile() ||
    !sameFileNode(current, backup)
  ) {
    throw new AuditJournalUnsafePathError(location.integrityLedgerBackupName);
  }
  await assertJournalFileLinkSafety(current, location.integrityLedgerName, ledgerWithBackupSafety(location));
  await assertJournalFileLinkSafety(backup, location.integrityLedgerBackupName, ledgerBackupSafety(location));
}

async function restoreIntegrityLedgerBackup(location: AuditJournalLocation): Promise<void> {
  const backup = await lstat(location.integrityLedgerBackupPath);
  await assertJournalFileLinkSafety(backup, location.integrityLedgerBackupName, ledgerBackupSafety(location));
  await rename(location.integrityLedgerBackupPath, location.integrityLedgerPath);
}

/** Restores an interrupted ledger replacement before any new journal mutation starts. */
async function recoverIntegrityLedgerReplacement(location: AuditJournalLocation): Promise<void> {
  if (!(await fileExistsSafely(location.integrityLedgerBackupPath, location.integrityLedgerBackupName))) return;
  const checkpoint = await readCheckpointFileOnly(location, checkpointWithPriorBackupSafety(location));
  if (checkpoint === undefined) throw new Error("Audit integrity ledger recovery is unavailable.");
  if (
    await ledgerMatchesCheckpoint(
      location,
      location.integrityLedgerPath,
      location.integrityLedgerName,
      checkpoint,
      ledgerWithBackupSafety(location)
    )
  ) {
    await removeRegularFile(location.integrityLedgerBackupPath, location.integrityLedgerBackupName);
    return;
  }
  if (
    await ledgerMatchesCheckpoint(
      location,
      location.integrityLedgerBackupPath,
      location.integrityLedgerBackupName,
      checkpoint,
      ledgerBackupSafety(location)
    )
  ) {
    await rename(location.integrityLedgerBackupPath, location.integrityLedgerPath);
    return;
  }
  throw new Error("Audit integrity ledger recovery is ambiguous.");
}

async function readIntegrityCheckpoint(location: AuditJournalLocation): Promise<IntegrityCheckpoint | undefined> {
  await recoverOrphanIntegrityPriorCheckpointBackup(location);
  await recoverIntegrityLedgerReplacement(location);
  await recoverIntegrityTransaction(location);
  const ledgerPresent = await fileExistsSafely(location.integrityLedgerPath, location.integrityLedgerName);
  const checkpoint = await readCheckpointFileOnly(location);
  if (!ledgerPresent && checkpoint === undefined) return undefined;
  if (!ledgerPresent || checkpoint === undefined) throw new Error("Audit integrity checkpoint is unavailable.");
  await recoverIntegrityArchiveRetirements(location, checkpoint);
  if (!(await ledgerMatchesCheckpoint(location, location.integrityLedgerPath, location.integrityLedgerName, checkpoint))) {
    throw new Error("Audit integrity checkpoint is unavailable.");
  }
  const replayed = replayLedger(location, await readLedgerEntries(location));
  if (!equalCheckpointCore(checkpoint, replayed)) {
    throw new Error("Audit integrity checkpoint is unavailable.");
  }
  return checkpoint;
}

async function replacePrivateFile(
  location: AuditJournalLocation,
  destinationPath: string,
  destinationSegment: string,
  temporaryLabel: string,
  contents: Buffer
): Promise<void> {
  try {
    const existing = await lstat(destinationPath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new AuditJournalUnsafePathError(destinationSegment);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  const temporaryPath = join(location.directory, `.${location.basename}.${temporaryLabel}-${randomUUID()}`);
  const temporaryName = basename(temporaryPath);
  let file: FileHandle | undefined;
  let committed = false;
  let failure: unknown;
  try {
    file = await openNewRegularFile(temporaryPath, temporaryName);
    await setRestrictiveMode(file, 0o600);
    await writeAll(file, contents);
    await file.sync();
    await assertHandleAtPath(file, temporaryPath, temporaryName);
    await closeFile(file, true);
    file = undefined;
    await rename(temporaryPath, destinationPath);
    committed = true;
  } catch (error) {
    failure = error;
  }
  if (file !== undefined) {
    try {
      await closeFile(file, false);
    } catch (error) {
      failure ??= error;
    }
  }
  if (!committed) {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isNotFoundError(error)) failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

async function writeCheckpoint(location: AuditJournalLocation, checkpoint: IntegrityCheckpoint): Promise<void> {
  await replacePrivateFile(
    location,
    location.integrityCheckpointPath,
    basename(location.integrityCheckpointPath),
    "miftah-integrity-state",
    Buffer.from(JSON.stringify(checkpoint), "utf8")
  );
}

async function removeCheckpoint(location: AuditJournalLocation): Promise<void> {
  try {
    const entry = await lstat(location.integrityCheckpointPath);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new AuditJournalUnsafePathError(basename(location.integrityCheckpointPath));
    await unlink(location.integrityCheckpointPath);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

function prepareCheckpointTransition(
  prior: IntegrityCheckpoint | undefined,
  nextCore: IntegrityCheckpointCore,
  transition: LedgerTransition
): PreparedCheckpointTransition {
  const entry = (prior?.ledgerEntry ?? 0) + 1;
  const ledger = withLedgerHash({
    version: 1,
    kind: transition.kind,
    entry,
    chainId: nextCore.chainId,
    previousEntryHash: prior?.ledgerHash ?? null,
    active: nextCore.active,
    ...(transition.sealed === undefined ? {} : { sealed: transition.sealed }),
    ...(transition.retired === undefined ? {} : { retired: transition.retired })
  });
  const line = `${JSON.stringify(ledger)}\n`;
  const ledgerSize = (prior?.ledgerSize ?? 0) + Buffer.byteLength(line, "utf8");
  const checkpoint = withCheckpointHash({
    ...nextCore,
    ledgerEntry: entry,
    ledgerHash: ledger.entryHash,
    ledgerSize
  });
  return { ledgerLine: line, checkpoint };
}

async function commitPreparedCheckpoint(
  location: AuditJournalLocation,
  prior: IntegrityCheckpoint | undefined,
  prepared: PreparedCheckpointTransition
): Promise<IntegrityCheckpoint> {
  await appendCompleteLine(location.integrityLedgerPath, prepared.ledgerLine, location.integrityLedgerName);
  try {
    await writeCheckpoint(location, prepared.checkpoint);
  } catch (error) {
    try {
      await truncateRegularFile(location.integrityLedgerPath, prior?.ledgerSize ?? 0, location.integrityLedgerName);
    } catch {
      throw new Error("Audit integrity checkpoint update failed and ledger rollback could not be completed.");
    }
    throw error;
  }
  return prepared.checkpoint;
}

/** Builds bounded retained-integrity metadata before any physical archive mutation. */
function prepareCompactedIntegrityCheckpoint(nextCore: IntegrityCheckpointCore): PreparedCheckpointTransition {
  const ledger = withLedgerHash({
    version: 1,
    kind: "checkpoint",
    entry: 1,
    chainId: nextCore.chainId,
    previousEntryHash: null,
    active: nextCore.active,
    checkpoint: { anchorHash: nextCore.anchorHash, archives: nextCore.archives }
  });
  const serializedLedger = JSON.stringify(ledger);
  if (Buffer.byteLength(serializedLedger, "utf8") > maximumLedgerRecordBytes) {
    throw new Error("Audit integrity ledger metadata exceeds its safe size limit.");
  }
  const line = `${serializedLedger}\n`;
  const checkpoint = withCheckpointHash({
    ...nextCore,
    ledgerEntry: 1,
    ledgerHash: ledger.entryHash,
    ledgerSize: Buffer.byteLength(line, "utf8")
  });
  if (Buffer.byteLength(JSON.stringify(checkpoint), "utf8") > maximumCheckpointBytes) {
    throw new Error("Audit integrity checkpoint metadata exceeds its safe size limit.");
  }
  return { ledgerLine: line, checkpoint };
}

/** Bounds retained integrity metadata to the current managed checkpoint after a rotation/retirement boundary. */
async function compactIntegrityLedger(
  location: AuditJournalLocation,
  prepared: PreparedCheckpointTransition
): Promise<IntegrityCheckpoint> {
  await recoverIntegrityLedgerReplacement(location);
  await createIntegrityLedgerBackup(location);
  try {
    await replacePrivateFile(
      location,
      location.integrityLedgerPath,
      location.integrityLedgerName,
      "miftah-integrity-ledger",
      Buffer.from(prepared.ledgerLine, "utf8")
    );
  } catch (error) {
    try {
      await removeRegularFile(location.integrityLedgerBackupPath, location.integrityLedgerBackupName);
    } catch (cleanupError) {
      throw new Error("Audit integrity ledger compaction could not clean up its rollback backup.", { cause: cleanupError });
    }
    throw error;
  }
  try {
    await writeCheckpoint(location, prepared.checkpoint);
  } catch (error) {
    try {
      await restoreIntegrityLedgerBackup(location);
    } catch (rollbackError) {
      throw new Error("Audit integrity ledger compaction could not restore its prior ledger.", { cause: rollbackError });
    }
    throw new Error("Audit integrity ledger compaction could not update its checkpoint.", { cause: error });
  }
  try {
    await removeRegularFile(location.integrityLedgerBackupPath, location.integrityLedgerBackupName);
  } catch {
    reportPostCommitIntegrityBackupFailure();
  }
  return prepared.checkpoint;
}

function continuationHash(checkpoint: IntegrityCheckpoint): string | null {
  return checkpoint.active.tailHash ?? checkpoint.archives.at(-1)?.tailHash ?? checkpoint.anchorHash;
}

function checkpointCore(
  chainId: string,
  anchorHash: string | null,
  archives: readonly ArchivedSegmentState[],
  active: ActiveSegmentState
): IntegrityCheckpointCore {
  return { version: 1, chainId, anchorHash, archives, active };
}

function activeAfterAppend(
  location: AuditJournalLocation,
  checkpoint: IntegrityCheckpoint,
  output: { readonly line: string; readonly state: IntegrityChainState; readonly recordCount: number }
): ActiveSegmentState {
  const prior = checkpoint.active;
  const continuation = continuationHash(checkpoint);
  return activeState(
    location.basename,
    prior.byteLength + Buffer.byteLength(output.line, "utf8"),
    prior.recordCount + output.recordCount,
    prior.recordCount === 0 ? continuation : prior.firstPreviousHash,
    output.state.lastHash
  );
}

async function initializeIntegrityCheckpoint(location: AuditJournalLocation): Promise<IntegrityCheckpoint> {
  const checkpoint = await readIntegrityCheckpoint(location);
  if (checkpoint !== undefined) return checkpoint;
  if (await activeFileExists(location)) {
    await assertCompleteJsonlBoundary(location);
    const active = await lstat(location.activePath);
    if (active.size !== 0) throw new Error("Audit integrity requires an empty managed journal or an existing checkpoint.");
  } else {
    await ensureActiveFile(location);
  }
  const chainId = randomUUID();
  const core = checkpointCore(chainId, null, [], stateForEmptyActive(location, null));
  const prepared = prepareCheckpointTransition(undefined, core, { kind: "initialize" });
  const transaction = createIntegrityTransaction("initialize", undefined, prepared.checkpoint);
  try {
    await beginIntegrityTransaction(location, transaction, undefined);
    await commitPreparedCheckpoint(location, undefined, prepared);
    await markIntegrityTransactionCommitted(location, transaction, prepared.checkpoint);
    await completeIntegrityTransaction(location);
    return prepared.checkpoint;
  } catch (error) {
    try {
      await recoverIntegrityTransaction(location);
    } catch (rollbackError) {
      throw new Error("Audit integrity initialization rollback could not be completed.", { cause: rollbackError });
    }
    throw error;
  }
}

async function validateIntegrityCheckpoint(location: AuditJournalLocation, checkpoint: IntegrityCheckpoint): Promise<void> {
  const physical = await listManagedArchives(location, { rejectUnsafe: true });
  if (physical.length !== checkpoint.archives.length) {
    throw new AuditIntegrityMismatchError("Audit journal archive set does not match its checkpoint.");
  }
  let chain: IntegrityChainState = { chainId: checkpoint.chainId, lastHash: checkpoint.anchorHash };
  for (const [index, expected] of checkpoint.archives.entries()) {
    const actual = physical[index];
    if (actual === undefined || actual.name !== expected.name || actual.sequenceText !== expected.sequence) {
      throw new AuditIntegrityMismatchError("Audit journal archive set does not match its checkpoint.");
    }
    const scan = await scanIntegritySegment(actual.path, actual.name, chain);
    if (scan.firstBroken !== undefined || scan.state === undefined || !segmentMatchesScan(expected, scan)) {
      throw new AuditIntegrityMismatchError("Audit journal archive integrity does not match its checkpoint.");
    }
    chain = scan.state;
  }
  if (!(await activeFileExists(location))) {
    throw new AuditIntegrityMismatchError("Audit journal active segment is unavailable.");
  }
  const active = await scanIntegritySegment(location.activePath, location.basename, chain);
  if (active.firstBroken !== undefined || !segmentMatchesScan(checkpoint.active, active)) {
    throw new AuditIntegrityMismatchError("Audit journal active integrity does not match its checkpoint.");
  }
}

async function stageRetiredArchives(
  location: AuditJournalLocation,
  archives: readonly ArchivedSegmentState[]
): Promise<readonly StagedArchiveRetirement[]> {
  const staged: StagedArchiveRetirement[] = [];
  try {
    for (const archive of archives) {
      const path = join(location.directory, archive.name);
      const name = retiredArchiveName(archive);
      const retirementPath = join(location.directory, name);
      try {
        const existing = await lstat(retirementPath);
        if (existing.isSymbolicLink() || !existing.isFile()) throw new AuditJournalUnsafePathError(name);
        throw new Error("Audit journal retirement staging path already exists.");
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      const current = await lstat(path);
      if (current.isSymbolicLink() || !current.isFile()) throw new AuditJournalUnsafePathError(archive.name);
      await rename(path, retirementPath);
      staged.push({ archive, path: retirementPath, name });
    }
    return staged;
  } catch (error) {
    try {
      await restoreRetiredArchives(location, staged);
    } catch (rollbackError) {
      throw new Error("Audit journal retirement could not restore its prior archives.", { cause: rollbackError });
    }
    throw error;
  }
}

async function restoreRetiredArchives(
  location: AuditJournalLocation,
  staged: readonly StagedArchiveRetirement[]
): Promise<void> {
  for (const retirement of [...staged].reverse()) {
    const current = await lstat(retirement.path);
    if (current.isSymbolicLink() || !current.isFile()) throw new AuditJournalUnsafePathError(retirement.name);
    const destination = join(location.directory, retirement.archive.name);
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new AuditJournalUnsafePathError(retirement.archive.name);
      }
      throw new Error("Audit journal retirement archive destination already exists.");
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    await rename(retirement.path, destination);
  }
}

async function recoverIntegrityArchiveRetirements(
  location: AuditJournalLocation,
  checkpoint: IntegrityCheckpoint
): Promise<void> {
  const expected = new Set(checkpoint.archives.map((archive) => archive.name));
  const entries = await readdir(location.directory, { withFileTypes: true });
  const retiredEntries = entries.filter((entry) => archiveNameFromRetiredName(location.basename, entry.name) !== undefined);
  if (retiredEntries.length === 0) return;
  await validateIntegrityCheckpoint(location, checkpoint);
  for (const entry of retiredEntries) {
    const archiveName = archiveNameFromRetiredName(location.basename, entry.name);
    if (archiveName === undefined) continue;
    const path = join(location.directory, entry.name);
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile()) throw new AuditJournalUnsafePathError(entry.name);
    if (!expected.has(archiveName)) {
      await unlink(path);
      continue;
    }
    const destination = join(location.directory, archiveName);
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new AuditJournalUnsafePathError(archiveName);
      throw new Error("Audit journal retirement recovery is ambiguous.");
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    await rename(path, destination);
  }
}

function applyRetentionToCheckpoint(
  checkpoint: IntegrityCheckpoint,
  retainFiles: number
): { readonly archives: readonly ArchivedSegmentState[]; readonly anchorHash: string | null; readonly removed: readonly ArchivedSegmentState[] } {
  const excess = Math.max(0, checkpoint.archives.length - retainFiles);
  const removed = checkpoint.archives.slice(0, excess);
  return {
    archives: checkpoint.archives.slice(excess),
    anchorHash: removed.at(-1)?.tailHash ?? checkpoint.anchorHash,
    removed
  };
}

async function retireIntegrityArchives(
  location: AuditJournalLocation,
  checkpoint: IntegrityCheckpoint,
  retainFiles: number
): Promise<IntegrityCheckpoint> {
  const retained = applyRetentionToCheckpoint(checkpoint, retainFiles);
  if (retained.removed.length === 0) return checkpoint;
  const lastRemoved = retained.removed.at(-1);
  if (lastRemoved === undefined || lastRemoved.tailHash === null) throw new Error("Audit integrity retention checkpoint is invalid.");
  const prepared = prepareCompactedIntegrityCheckpoint(
    checkpointCore(checkpoint.chainId, retained.anchorHash, retained.archives, checkpoint.active)
  );
  const transaction = createIntegrityTransaction("retire", checkpoint, prepared.checkpoint, {
    retiredArchives: retained.removed
  });
  try {
    await beginIntegrityTransaction(location, transaction, checkpoint);
    await stageRetiredArchives(location, retained.removed);
    const compacted = await compactIntegrityLedger(location, prepared);
    const committed = await markIntegrityTransactionCommitted(location, transaction, compacted);
    await finalizeIntegrityTransactionPhysical(location, committed, compacted);
    await completeIntegrityTransaction(location);
    return compacted;
  } catch (error) {
    try {
      await recoverIntegrityTransaction(location);
    } catch (rollbackError) {
      throw new Error("Audit journal retirement could not recover its prior archives.", { cause: rollbackError });
    }
    throw error;
  }
}

async function rotateIntegrityJournal(
  location: AuditJournalLocation,
  checkpoint: IntegrityCheckpoint
): Promise<IntegrityCheckpoint> {
  if (checkpoint.active.recordCount === 0 || checkpoint.active.tailHash === null) {
    throw new Error("Audit journal cannot rotate an empty integrity segment.");
  }
  const physical = await listManagedArchives(location, { rejectUnsafe: true });
  const latestPhysical = physical.at(-1)?.sequence ?? 0n;
  const latestCheckpoint = checkpoint.archives.at(-1)?.sequence;
  const latest = latestCheckpoint === undefined ? latestPhysical : BigInt(latestCheckpoint) > latestPhysical ? BigInt(latestCheckpoint) : latestPhysical;
  if (latest >= maximumArchiveSequence) throw new Error("Audit journal archive sequence is exhausted.");
  const archive = plannedArchive(location, latest + 1n);
  const sealed = archiveState(checkpoint.active, archive);
  const withSealed = { ...checkpoint, archives: [...checkpoint.archives, sealed] } as IntegrityCheckpoint;
  const priorTail = checkpoint.active.tailHash;
  const nextCore = checkpointCore(
    checkpoint.chainId,
    checkpoint.anchorHash,
    withSealed.archives,
    stateForEmptyActive(location, priorTail)
  );
  const prepared = prepareCompactedIntegrityCheckpoint(nextCore);
  const transaction = createIntegrityTransaction("rotate", checkpoint, prepared.checkpoint, { archive });
  try {
    await beginIntegrityTransaction(location, transaction, checkpoint);
    await rotateActiveSegment(location, archive);
    const compacted = await compactIntegrityLedger(location, prepared);
    await markIntegrityTransactionCommitted(location, transaction, compacted);
    await completeIntegrityTransaction(location);
    return compacted;
  } catch (error) {
    try {
      await recoverIntegrityTransaction(location);
    } catch (rollbackError) {
      throw new Error("Audit journal rotation could not recover its prior active segment.", { cause: rollbackError });
    }
    throw error;
  }
}

async function appendWithIntegrity(
  location: AuditJournalLocation,
  line: string,
  rotation: AuditRotationOptions | undefined
): Promise<void> {
  let checkpoint = await initializeIntegrityCheckpoint(location);
  await validateIntegrityCheckpoint(location, checkpoint);
  if (rotation !== undefined) {
    const probe = applyIntegrityChain(line, { chainId: checkpoint.chainId, lastHash: continuationHash(checkpoint) });
    if (await shouldRotate(location, rotation, Buffer.byteLength(probe.line, "utf8"))) {
      checkpoint = await rotateIntegrityJournal(location, checkpoint);
    }
  }
  const output = applyIntegrityChain(line, { chainId: checkpoint.chainId, lastHash: continuationHash(checkpoint) });
  const nextCore = checkpointCore(
    checkpoint.chainId,
    checkpoint.anchorHash,
    checkpoint.archives,
    activeAfterAppend(location, checkpoint, output)
  );
  const prepared = prepareCheckpointTransition(checkpoint, nextCore, { kind: "append" });
  const transaction = createIntegrityTransaction("append", checkpoint, prepared.checkpoint);
  let committed: IntegrityCheckpoint;
  try {
    await beginIntegrityTransaction(location, transaction, checkpoint);
    committed = await commitPreparedCheckpoint(location, checkpoint, prepared);
    await appendCompleteLine(location.activePath, output.line, location.basename);
    await markIntegrityTransactionCommitted(location, transaction, committed);
    await completeIntegrityTransaction(location);
  } catch (error) {
    try {
      await recoverIntegrityTransaction(location);
    } catch (rollbackError) {
      throw new Error("Audit integrity append could not recover its prior checkpoint.", { cause: rollbackError });
    }
    throw error;
  }
  if (rotation !== undefined) {
    try {
      await retireIntegrityArchives(location, committed, rotation.retainFiles);
    } catch {
      reportPostCommitRetentionFailure();
    }
  }
}

async function appendWithoutIntegrity(
  location: AuditJournalLocation,
  line: string,
  rotation: AuditRotationOptions | undefined
): Promise<void> {
  await assertCompleteJsonlBoundary(location);
  if (rotation !== undefined) {
    if (await shouldRotate(location, rotation, Buffer.byteLength(line, "utf8"))) {
      const archives = await listManagedArchives(location);
      const latest = archives.at(-1)?.sequence ?? 0n;
      if (latest >= maximumArchiveSequence) throw new Error("Audit journal archive sequence is exhausted.");
      await rotateActiveSegment(location, plannedArchive(location, latest + 1n));
    }
  }
  await appendCompleteLine(location.activePath, line, location.basename);
  if (rotation !== undefined) {
    try {
      await retainArchives(location, rotation.retainFiles);
    } catch {
      reportPostCommitRetentionFailure();
    }
  }
}

async function scanIntegritySegment(
  path: string,
  segment: string,
  initialState: IntegrityChainState | undefined
): Promise<IntegritySegmentScan> {
  let file: FileHandle;
  try {
    file = await openExistingRegularFile(path, readOnlyFlags, segment);
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        byteLength: 0,
        recordCount: 0,
        state: initialState,
        firstBroken: integrityFailure(segment, 1, "SEGMENT_UNAVAILABLE")
      };
    }
    throw error;
  }
  let pending = Buffer.alloc(0);
  let recordCount = 0;
  let firstPreviousHash: string | null | undefined;
  let state = initialState;
  let failure: unknown;
  let result: IntegritySegmentScan | undefined;
  try {
    const { size } = await file.stat();
    const chunk = Buffer.allocUnsafe(integrityReadChunkBytes);
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const contents = pending.length === 0 ? Buffer.from(chunk.subarray(0, bytesRead)) : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let recordStart = 0;
      while (true) {
        const lineEnd = contents.indexOf(0x0a, recordStart);
        if (lineEnd === -1) break;
        const record = contents.subarray(recordStart, lineEnd);
        recordCount += 1;
        if (record.length > maximumIntegrityRecordBytes) {
          result = { byteLength: size, recordCount, firstPreviousHash, state, firstBroken: integrityFailure(segment, recordCount, "RECORD_TOO_LARGE") };
          break;
        }
        try {
          const inspection = inspectIntegrityRecord(parseJsonRecord(record.toString("utf8")), state);
          if (inspection.reason !== undefined) {
            result = { byteLength: size, recordCount, firstPreviousHash, state, firstBroken: integrityFailure(segment, recordCount, inspection.reason) };
            break;
          }
          if (firstPreviousHash === undefined) firstPreviousHash = inspection.previousHash;
          state = inspection.state;
        } catch {
          result = { byteLength: size, recordCount, firstPreviousHash, state, firstBroken: integrityFailure(segment, recordCount, "MALFORMED_RECORD") };
          break;
        }
        recordStart = lineEnd + 1;
      }
      if (result !== undefined) break;
      pending = Buffer.from(contents.subarray(recordStart));
      if (pending.length > maximumIntegrityRecordBytes) {
        result = {
          byteLength: size,
          recordCount,
          firstPreviousHash,
          state,
          firstBroken: integrityFailure(segment, recordCount + 1, "RECORD_TOO_LARGE")
        };
        break;
      }
    }
    if (result === undefined && pending.length > 0) {
      result = {
        byteLength: size,
        recordCount,
        firstPreviousHash,
        state,
        firstBroken: integrityFailure(segment, recordCount + 1, "INCOMPLETE_RECORD")
      };
    }
    await assertHandleAtPath(file, path, segment);
    result ??= { byteLength: size, recordCount, firstPreviousHash, state };
  } catch (error) {
    failure = error;
  }
  try {
    await closeFile(file, false);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  return result!;
}

async function readLedgerEntries(location: AuditJournalLocation): Promise<IntegrityLedgerEntry[]> {
  const file = await openExistingRegularFile(location.integrityLedgerPath, readOnlyFlags, location.integrityLedgerName);
  const entries: IntegrityLedgerEntry[] = [];
  let pending = Buffer.alloc(0);
  let failure: unknown;
  try {
    const chunk = Buffer.allocUnsafe(integrityReadChunkBytes);
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const contents = pending.length === 0 ? Buffer.from(chunk.subarray(0, bytesRead)) : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let start = 0;
      while (true) {
        const end = contents.indexOf(0x0a, start);
        if (end === -1) break;
        const line = contents.subarray(start, end);
        if (line.length === 0 || line.length > maximumLedgerRecordBytes) throw new Error("Audit integrity ledger is invalid.");
        entries.push(parseLedgerEntry(JSON.parse(line.toString("utf8")) as unknown, location));
        start = end + 1;
      }
      pending = Buffer.from(contents.subarray(start));
      if (pending.length > maximumLedgerRecordBytes) throw new Error("Audit integrity ledger is invalid.");
    }
    if (pending.length > 0 || entries.length === 0) throw new Error("Audit integrity ledger is invalid.");
    await assertHandleAtPath(file, location.integrityLedgerPath, location.integrityLedgerName);
  } catch (error) {
    failure = error;
  }
  try {
    await closeFile(file, false);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
  return entries;
}

function equalActiveState(left: ActiveSegmentState, right: ActiveSegmentState): boolean {
  return (
    left.name === right.name &&
    left.byteLength === right.byteLength &&
    left.recordCount === right.recordCount &&
    left.firstPreviousHash === right.firstPreviousHash &&
    left.tailHash === right.tailHash
  );
}

function equalArchivedState(left: ArchivedSegmentState, right: ArchivedSegmentState): boolean {
  return left.sequence === right.sequence && equalActiveState(left, right);
}

function replayRetirement(
  archives: readonly ArchivedSegmentState[],
  retired: IntegrityRetirement
): { readonly archives: readonly ArchivedSegmentState[]; readonly anchorHash: string } {
  const index = archives.findIndex((archive) => archive.sequence === retired.throughSequence);
  if (index === -1) throw new Error("Audit integrity ledger retirement is invalid.");
  const removed = archives.slice(0, index + 1);
  const last = removed.at(-1);
  if (last === undefined || last.tailHash !== retired.anchorHash) throw new Error("Audit integrity ledger retirement is invalid.");
  return { archives: archives.slice(index + 1), anchorHash: retired.anchorHash };
}

function replayLedger(location: AuditJournalLocation, entries: readonly IntegrityLedgerEntry[]): IntegrityCheckpointCore {
  let chainId: string | undefined;
  let previousEntryHash: string | null = null;
  let active: ActiveSegmentState | undefined;
  let archives: readonly ArchivedSegmentState[] = [];
  let anchorHash: string | null = null;
  let lastSequence = -1n;
  for (const [index, entry] of entries.entries()) {
    if (entry.entry !== index + 1 || entry.previousEntryHash !== previousEntryHash) {
      throw new Error("Audit integrity ledger ordering is invalid.");
    }
    if (chainId === undefined) chainId = entry.chainId;
    else if (entry.chainId !== chainId) throw new Error("Audit integrity ledger chain is invalid.");
    if (index === 0) {
      if (entry.kind === "initialize") {
        if (entry.active.recordCount !== 0 || entry.active.firstPreviousHash !== null) {
          throw new Error("Audit integrity ledger initialization is invalid.");
        }
        active = entry.active;
      } else if (entry.kind === "checkpoint" && entry.checkpoint !== undefined) {
        anchorHash = entry.checkpoint.anchorHash;
        archives = entry.checkpoint.archives;
        lastSequence = archives.at(-1) === undefined ? -1n : BigInt(archives.at(-1)!.sequence);
        active = entry.active;
      } else {
        throw new Error("Audit integrity ledger initialization is invalid.");
      }
    } else if (entry.kind === "append") {
      if (active === undefined || entry.active.recordCount <= active.recordCount || entry.active.byteLength <= active.byteLength) {
        throw new Error("Audit integrity ledger append is invalid.");
      }
      const expectedFirst = active.firstPreviousHash;
      if (entry.active.firstPreviousHash !== expectedFirst || entry.active.tailHash === null) {
        throw new Error("Audit integrity ledger append is invalid.");
      }
      active = entry.active;
    } else if (entry.kind === "rotate") {
      if (active === undefined || active.recordCount === 0 || entry.sealed === undefined || !equalActiveState(active, { ...entry.sealed, name: location.basename })) {
        throw new Error("Audit integrity ledger rotation is invalid.");
      }
      if (BigInt(entry.sealed.sequence) <= lastSequence || entry.active.recordCount !== 0 || entry.active.firstPreviousHash !== active.tailHash) {
        throw new Error("Audit integrity ledger rotation is invalid.");
      }
      archives = [...archives, entry.sealed];
      lastSequence = BigInt(entry.sealed.sequence);
      if (entry.retired !== undefined) {
        const replayed = replayRetirement(archives, entry.retired);
        archives = replayed.archives;
        anchorHash = replayed.anchorHash;
      }
      active = entry.active;
    } else if (entry.kind === "retire") {
      if (active === undefined || !equalActiveState(active, entry.active) || entry.retired === undefined) {
        throw new Error("Audit integrity ledger retirement is invalid.");
      }
      const replayed = replayRetirement(archives, entry.retired);
      archives = replayed.archives;
      anchorHash = replayed.anchorHash;
    } else {
      throw new Error("Audit integrity ledger is invalid.");
    }
    previousEntryHash = entry.entryHash;
  }
  if (chainId === undefined || active === undefined) throw new Error("Audit integrity ledger is invalid.");
  return checkpointCore(chainId, anchorHash, archives, active);
}

function segmentMatchesScan(state: ActiveSegmentState, scan: IntegritySegmentScan): boolean {
  if (state.byteLength !== scan.byteLength || state.recordCount !== scan.recordCount) return false;
  if (state.recordCount === 0) {
    return state.tailHash === null && state.firstPreviousHash === scan.state?.lastHash;
  }
  return state.firstPreviousHash === scan.firstPreviousHash && state.tailHash === scan.state?.lastHash;
}

function equalCheckpointCore(left: IntegrityCheckpointCore, right: IntegrityCheckpointCore): boolean {
  return (
    left.version === right.version &&
    left.chainId === right.chainId &&
    left.anchorHash === right.anchorHash &&
    left.archives.length === right.archives.length &&
    left.archives.every((archive, index) => {
      const other = right.archives[index];
      return other !== undefined && equalArchivedState(archive, other);
    }) &&
    equalActiveState(left.active, right.active)
  );
}

/** Appends a complete JSONL batch under the managed journal's rotation and integrity invariants. */
export async function appendAuditJournal(
  path: string,
  line: string,
  options: AuditJournalWriteOptions
): Promise<void> {
  if (options.rotation !== undefined) assertRotationOptions(options.rotation);
  if (options.integrity !== undefined) assertIntegrityOptions(options.integrity);
  const location = await resolveJournalLocation(path);
  if (options.rotation !== undefined || options.integrity !== undefined) {
    assertManagedJournalBasename(location, options);
  }
  await withJournalLock(location, async () => {
    if (options.integrity !== undefined) {
      await appendWithIntegrity(location, line, options.rotation);
    } else {
      await appendWithoutIntegrity(location, line, options.rotation);
    }
  });
}

/** Creates the active journal file under the same safety and integrity rules without rotating it. */
export async function prepareAuditJournal(path: string, options: AuditJournalWriteOptions): Promise<void> {
  if (options.rotation !== undefined) assertRotationOptions(options.rotation);
  if (options.integrity !== undefined) assertIntegrityOptions(options.integrity);
  const location = await resolveJournalLocation(path);
  if (options.rotation !== undefined || options.integrity !== undefined) {
    assertManagedJournalBasename(location, options);
  }
  await withJournalLock(location, async () => {
    await assertCompleteJsonlBoundary(location);
    if (options.integrity !== undefined) {
      const checkpoint = await initializeIntegrityCheckpoint(location);
      await validateIntegrityCheckpoint(location, checkpoint);
    } else {
      await ensureActiveFile(location);
    }
  });
}

/** Verifies every retained managed segment and reports only the first safe break location. */
export async function verifyAuditJournal(path: string): Promise<AuditIntegrityReport> {
  let safeSegment = safeAuditSegmentName(path);
  try {
    const location = await resolveJournalLocation(path, { createDirectory: false });
    safeSegment = location.basename;
    return await withJournalLock(location, async () => {
      try {
        const checkpoint = await readIntegrityCheckpoint(location);
        if (checkpoint === undefined) {
          return { ok: false, firstBroken: integrityFailure(location.basename, 1, "INTEGRITY_NOT_CONFIGURED") };
        }
        const entries = await readLedgerEntries(location);
        const replayed = replayLedger(location, entries);
        if (!equalCheckpointCore(checkpoint, replayed)) {
          return { ok: false, firstBroken: integrityFailure(location.integrityLedgerName, 1, "SEGMENT_METADATA_MISMATCH") };
        }
        const physical = await listManagedArchives(location, { rejectUnsafe: true });
        if (physical.length !== replayed.archives.length) {
          const expected = replayed.archives.find((archive) => !physical.some((item) => item.name === archive.name));
          return {
            ok: false,
            firstBroken: integrityFailure(expected?.name ?? physical[0]?.name ?? location.basename, 1, "SEGMENT_UNAVAILABLE")
          };
        }
        for (const archive of replayed.archives) {
          const physicalArchive = physical.find((item) => item.name === archive.name);
          if (physicalArchive === undefined || physicalArchive.sequenceText !== archive.sequence) {
            return { ok: false, firstBroken: integrityFailure(archive.name, 1, "SEGMENT_UNAVAILABLE") };
          }
        }
        let chain: IntegrityChainState = { chainId: replayed.chainId, lastHash: replayed.anchorHash };
        let totalRecords = 0;
        for (const archive of replayed.archives) {
          const physicalArchive = physical.find((item) => item.name === archive.name);
          if (physicalArchive === undefined) {
            return { ok: false, firstBroken: integrityFailure(archive.name, 1, "SEGMENT_UNAVAILABLE") };
          }
          const scan = await scanIntegritySegment(physicalArchive.path, archive.name, chain);
          totalRecords += scan.recordCount;
          if (scan.firstBroken !== undefined) return { ok: false, firstBroken: scan.firstBroken };
          if (!segmentMatchesScan(archive, scan) || scan.state === undefined) {
            return {
              ok: false,
              firstBroken: integrityFailure(archive.name, Math.max(1, scan.recordCount), "SEGMENT_METADATA_MISMATCH")
            };
          }
          chain = scan.state;
        }
        if (!(await activeFileExists(location))) {
          return { ok: false, firstBroken: integrityFailure(location.basename, 1, "SEGMENT_UNAVAILABLE") };
        }
        const active = await scanIntegritySegment(location.activePath, location.basename, chain);
        totalRecords += active.recordCount;
        if (active.firstBroken !== undefined) return { ok: false, firstBroken: active.firstBroken };
        if (!segmentMatchesScan(replayed.active, active)) {
          return {
            ok: false,
            firstBroken: integrityFailure(location.basename, Math.max(1, active.recordCount), "SEGMENT_METADATA_MISMATCH")
          };
        }
        return totalRecords > 0
          ? { ok: true }
          : { ok: false, firstBroken: integrityFailure(location.basename, 1, "NO_RECORDS") };
      } catch (error) {
        const segment = error instanceof AuditJournalUnsafePathError ? error.segment : location.integrityLedgerName;
        return { ok: false, firstBroken: integrityFailure(segment, 1, "SEGMENT_UNAVAILABLE") };
      }
    });
  } catch {
    return {
      ok: false,
      firstBroken: integrityFailure(safeSegment, 1, "SEGMENT_UNAVAILABLE")
    };
  }
}

/** Compatibility helper for callers that only need managed rotation. */
export async function appendRotatingAuditJournal(
  path: string,
  line: string,
  rotation: AuditRotationOptions
): Promise<void> {
  await appendAuditJournal(path, line, { rotation });
}

/** Compatibility helper for callers that only need managed rotation. */
export async function prepareRotatingAuditJournal(path: string, rotation: AuditRotationOptions): Promise<void> {
  await prepareAuditJournal(path, { rotation });
}
