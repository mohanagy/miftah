import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  createWindowsPrivateDirectory,
  secureWindowsConfigFile,
  verifyWindowsConfigPathSecurity
} from "../cli/windows-config-acl.js";
import { PRESET_CATALOG, type PresetCatalogName } from "../config/presets.js";
import { withOAuthLocalLock } from "../oauth/local-lock.js";
import { MiftahError } from "../utils/errors.js";

const maximumDraftBytes = 4 * 1024;
const draftLockWaitMilliseconds = 5_000;
const draftFileName = "setup-draft-v1.json";
const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const readOnlyFlags = constants.O_RDONLY | noFollowFlag;
const allowedStoredFields = new Set([
  "schemaVersion",
  "revision",
  "source",
  "name",
  "preset",
  "stage",
  "savedAt"
]);
const configurationNamePattern = /^[a-z0-9](?:[a-z0-9._-]{0,63})?$/u;

/**
 * The only user intent persisted by the first resumable setup slice. Connection details,
 * output paths, client handoff content, credentials, and OAuth state must be re-entered.
 */
export interface SetupDraftInput {
  readonly source: "connector";
  readonly name: string;
  /** Untrusted input is runtime-checked against the versioned preset catalog before persistence. */
  readonly preset: string;
  readonly stage: "connection";
}

/** A versioned, non-secret setup checkpoint shared by the CLI and Console. */
export interface SetupDraft extends SetupDraftInput {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly savedAt: string;
}

/** Minimal storage contract so the CLI and Console can use one safe checkpoint boundary. */
export interface SetupDraftStore {
  load(): Promise<SetupDraft | undefined>;
  save(input: SetupDraftInput, expectedRevision?: number): Promise<SetupDraft>;
  discard(expectedRevision: number): Promise<void>;
}

export interface FileSetupDraftStoreOptions {
  /** Overrides the private product state directory for tests or an explicitly managed install. */
  readonly directory?: string;
  /** Injected clock for deterministic callers and tests. */
  readonly now?: () => string;
}

function setupDraftInputInvalid(): never {
  throw new MiftahError(
    "SETUP_DRAFT_INPUT_INVALID",
    "SETUP_DRAFT_INPUT_INVALID: setup draft intent must contain only a bounded connector name, catalog preset, and stage"
  );
}

function setupDraftInvalid(): never {
  throw new MiftahError(
    "SETUP_DRAFT_INVALID",
    "SETUP_DRAFT_INVALID: persisted setup draft is malformed or contains excluded data"
  );
}

function setupDraftConflict(): never {
  throw new MiftahError(
    "SETUP_DRAFT_CONFLICT",
    "SETUP_DRAFT_CONFLICT: setup draft changed in another CLI or Console session"
  );
}

function setupDraftUnavailable(cause?: unknown): never {
  throw new MiftahError(
    "SETUP_DRAFT_UNAVAILABLE",
    "SETUP_DRAFT_UNAVAILABLE: private setup draft storage is unavailable",
    cause === undefined ? undefined : { cause }
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function ownedByCurrentUser(metadata: Pick<BigIntStats, "uid"> | { readonly uid: number }): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  const owner = metadata.uid;
  const current = process.getuid();
  return typeof owner === "bigint" ? owner === BigInt(current) : owner === current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validExpectedRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validConfigurationName(value: unknown): value is string {
  return typeof value === "string" && configurationNamePattern.test(value);
}

function validPreset(value: unknown): value is PresetCatalogName {
  return typeof value === "string" && Object.hasOwn(PRESET_CATALOG.presets, value);
}

function normalizeInput(value: unknown): SetupDraftInput {
  if (
    !isRecord(value) ||
    Object.keys(value).some((field) => !["source", "name", "preset", "stage"].includes(field)) ||
    value.source !== "connector" ||
    !validConfigurationName(value.name) ||
    !validPreset(value.preset) ||
    value.stage !== "connection"
  ) {
    setupDraftInputInvalid();
  }
  return {
    source: "connector",
    name: value.name,
    preset: value.preset,
    stage: "connection"
  };
}

function normalizeStoredDraft(value: unknown): SetupDraft {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== allowedStoredFields.size ||
    Object.keys(value).some((field) => !allowedStoredFields.has(field)) ||
    value.schemaVersion !== 1 ||
    !validRevision(value.revision) ||
    value.source !== "connector" ||
    !validConfigurationName(value.name) ||
    !validPreset(value.preset) ||
    value.stage !== "connection" ||
    !validTimestamp(value.savedAt)
  ) {
    setupDraftInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: value.revision,
    source: "connector",
    name: value.name,
    preset: value.preset,
    stage: "connection",
    savedAt: value.savedAt
  });
}

function globalStateRoot(): string {
  if (platform() === "win32") {
    const configured = process.env.LOCALAPPDATA;
    return configured !== undefined && isAbsolute(configured)
      ? resolve(configured)
      : join(homedir(), "AppData", "Local");
  }
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support");
  const configured = process.env.XDG_STATE_HOME;
  return configured !== undefined && isAbsolute(configured)
    ? resolve(configured)
    : join(homedir(), ".local", "state");
}

function defaultSetupDraftDirectory(): string {
  const productDirectory = platform() === "win32" || platform() === "darwin" ? "Miftah" : "miftah";
  return join(globalStateRoot(), productDirectory, "setup");
}

/** Returns the single private, non-secret draft path shared across setup surfaces. */
export function resolveSetupDraftPath(directory: string = defaultSetupDraftDirectory()): string {
  return join(resolve(directory), draftFileName);
}

async function setRestrictiveMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  }
}

async function isPrivatePosixPath(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return false;
    if (kind === "file" ? !metadata.isFile() : !metadata.isDirectory()) return false;
    return ownedByCurrentUser(metadata) && (metadata.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    if (process.platform !== "win32") {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await setRestrictiveMode(directory, 0o700);
      if (!(await isPrivatePosixPath(directory, "directory"))) setupDraftUnavailable();
      return;
    }
    const parent = dirname(directory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!(await verifyWindowsConfigPathSecurity(parent, "directory"))) setupDraftUnavailable();
    if (await privateDirectoryMetadata(directory) !== undefined) return;
    // Exclusive creation may lose a race to another Miftah process. Validate the
    // resulting path rather than treating that safe race as a storage failure.
    await createWindowsPrivateDirectory(directory);
    if (await privateDirectoryMetadata(directory) === undefined) setupDraftUnavailable();
  } catch (error) {
    if (error instanceof MiftahError) throw error;
    setupDraftUnavailable(error);
  }
}

async function verifyPrivateFile(path: string): Promise<void> {
  if (await privateFileMetadata(path) === undefined) setupDraftUnavailable();
}

function sameFileIdentity(left: Pick<BigIntStats, "dev" | "ino">, right: Pick<BigIntStats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Validates the private draft directory without following a final symlink. */
async function privateDirectoryMetadata(
  path: string,
  verifyWindowsAcl: boolean = true
): Promise<BigIntStats | undefined> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    setupDraftUnavailable();
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) setupDraftUnavailable();
  if (process.platform === "win32") {
    if (verifyWindowsAcl && !(await verifyWindowsConfigPathSecurity(path, "directory"))) setupDraftUnavailable();
  } else if ((Number(metadata.mode) & 0o077) !== 0) {
    setupDraftUnavailable();
  }
  return metadata;
}

/** Returns the current secure file identity without following symlinks. */
async function privateFileMetadata(path: string, verifyWindowsAcl: boolean = true): Promise<BigIntStats | undefined> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    setupDraftUnavailable();
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) setupDraftUnavailable();
  if (process.platform === "win32") {
    if (verifyWindowsAcl && !(await verifyWindowsConfigPathSecurity(path, "file"))) setupDraftUnavailable();
  } else if ((Number(metadata.mode) & 0o077) !== 0) {
    setupDraftUnavailable();
  }
  return metadata;
}

/** Restrictive, atomic, compare-and-swap persistence for a single non-secret setup intent. */
export class FileSetupDraftStore implements SetupDraftStore {
  private readonly directory: string;
  private readonly path: string;
  private readonly now: () => string;

  constructor(options: FileSetupDraftStoreOptions = {}) {
    this.directory = resolve(options.directory ?? defaultSetupDraftDirectory());
    this.path = resolveSetupDraftPath(this.directory);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async load(): Promise<SetupDraft | undefined> {
    return this.loadUnchecked();
  }

  async save(input: SetupDraftInput, expectedRevision?: number): Promise<SetupDraft> {
    const normalized = normalizeInput(input);
    if (expectedRevision !== undefined && !validExpectedRevision(expectedRevision)) setupDraftInputInvalid();
    return this.withLock(async () => {
      const existing = await this.loadUnchecked(true);
      if (expectedRevision !== undefined && expectedRevision !== (existing?.revision ?? 0)) {
        setupDraftConflict();
      }
      const revision = existing === undefined ? 1 : existing.revision + 1;
      if (!Number.isSafeInteger(revision)) setupDraftUnavailable();
      const draft = normalizeStoredDraft({
        schemaVersion: 1,
        revision,
        ...normalized,
        savedAt: this.now()
      });
      await this.persist(draft);
      return draft;
    });
  }

  async discard(expectedRevision: number): Promise<void> {
    if (!validRevision(expectedRevision)) setupDraftInputInvalid();
    await this.withLock(async () => {
      const existing = await this.loadUnchecked(true);
      if (existing === undefined) return;
      if (existing.revision !== expectedRevision) setupDraftConflict();
      try {
        await rm(this.path, { force: true });
      } catch {
        setupDraftUnavailable();
      }
    });
  }

  private async withLock<Value>(operation: () => Promise<Value>): Promise<Value> {
    try {
      await ensurePrivateDirectory(this.directory);
      return await withOAuthLocalLock("setup-draft", this.path, draftLockWaitMilliseconds, operation);
    } catch (error) {
      if (error instanceof MiftahError) throw error;
      setupDraftUnavailable(error);
    }
  }

  private async loadUnchecked(directoryAlreadyVerified: boolean = false): Promise<SetupDraft | undefined> {
    if (await privateDirectoryMetadata(this.directory, !directoryAlreadyVerified) === undefined) return undefined;
    const observed = await privateFileMetadata(this.path);
    if (observed === undefined) return undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let content: string | undefined;
    let failure: unknown;
    try {
      handle = await open(this.path, readOnlyFlags);
      const opened = await handle.stat({ bigint: true });
      // The initial full ACL check establishes that untrusted principals cannot
      // replace this file. Retain the lstat identity checks below to catch any
      // pathname swap without spawning another Windows verifier per read step.
      const afterOpen = await privateFileMetadata(this.path, false);
      if (
        afterOpen === undefined ||
        !sameFileIdentity(observed, opened) ||
        !sameFileIdentity(opened, afterOpen)
      ) {
        setupDraftUnavailable();
      }
      if (opened.size > BigInt(maximumDraftBytes)) setupDraftInvalid();
      const boundedBytes = Buffer.alloc(maximumDraftBytes + 1);
      const { bytesRead } = await handle.read(boundedBytes, 0, boundedBytes.byteLength, 0);
      if (bytesRead > maximumDraftBytes) setupDraftInvalid();
      const bytes = boundedBytes.subarray(0, bytesRead);
      const afterRead = await handle.stat({ bigint: true });
      const afterReadPath = await privateFileMetadata(this.path, false);
      if (
        afterReadPath === undefined ||
        !sameFileIdentity(opened, afterRead) ||
        !sameFileIdentity(afterRead, afterReadPath) ||
        afterRead.size !== opened.size
      ) {
        setupDraftUnavailable();
      }
      if (bytes.byteLength > maximumDraftBytes) setupDraftInvalid();
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        setupDraftInvalid();
      }
    } catch (error) {
      failure = error;
    }
    try {
      await handle?.close();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    if (failure instanceof MiftahError) throw failure;
    if (failure !== undefined || content === undefined) setupDraftUnavailable();
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      setupDraftInvalid();
    }
    return normalizeStoredDraft(value);
  }

  private async persist(draft: SetupDraft): Promise<void> {
    const content = JSON.stringify(draft);
    if (Buffer.byteLength(content, "utf8") > maximumDraftBytes) setupDraftUnavailable();
    const temporaryPath = join(this.directory, `.${basename(this.path)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      if (!(await secureWindowsConfigFile(temporaryPath))) setupDraftUnavailable();
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await setRestrictiveMode(temporaryPath, 0o600);
      await verifyPrivateFile(temporaryPath);
      await rename(temporaryPath, this.path);
      await verifyPrivateFile(this.path);
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // Preserve the stable storage error below.
      }
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // The temporary file contains only the bounded public intent fields above.
      }
      if (error instanceof MiftahError) throw error;
      setupDraftUnavailable();
    }
  }
}
