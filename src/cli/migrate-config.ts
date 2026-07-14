import { chmod, link, lstat, mkdtemp, open, readFile, rename, rm, rmdir, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { resolvePath } from "../config/path-resolve.js";
import { planConfigMigration, type ConfigMigrationPlan } from "../config/migrate-config.js";
import { MiftahError } from "../utils/errors.js";
import {
  copyWindowsConfigSecurityDescriptor,
  createWindowsPrivateMigrationDirectory
} from "./windows-config-acl.js";

export interface MigrateConfigCommandOptions {
  readonly configPath: string;
  readonly write?: boolean;
}

export interface MigrateConfigReport {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly changed: boolean;
  readonly actions: readonly string[];
  readonly write: boolean;
  readonly backupCreated: boolean;
}

interface MigrationSourceFingerprint {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly mode: number;
}

/** A byte-identical regular-file snapshot used only by the explicit migration transaction. */
export interface ConfigMigrationSource {
  readonly originalBytes: Buffer;
  readonly fingerprint: MigrationSourceFingerprint;
}

class MigrationSourceChangedError extends Error {
  constructor(
    readonly recoveryPath?: string,
    readonly replacementApplied = false
  ) {
    super("The configuration changed after migration planning.");
    this.name = "MigrationSourceChangedError";
  }
}

class MigrationTransactionError extends Error {
  constructor(
    readonly recoveryPath?: string,
    readonly replacementApplied = false
  ) {
    super("The migration transaction could not safely complete.");
    this.name = "MigrationTransactionError";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function migrationWriteError(message: string): MiftahError {
  return new MiftahError("CONFIG_MIGRATION_WRITE_FAILED", `CONFIG_MIGRATION_WRITE_FAILED: ${message}`);
}

function sourceChangedWriteError(recoveryPath?: string, replacementApplied = false, path?: string): MiftahError {
  const recovery = recoveryPath === undefined ? "" : `; a recovery copy was retained at '${recoveryPath}'`;
  if (replacementApplied) {
    return migrationWriteError(
      `the migrated configuration was installed at '${path}', but a concurrent source was retained${recovery}; compare it manually before deleting the recovery copy`
    );
  }
  return migrationWriteError(`the configuration changed after migration planning; no replacement was applied${recovery}`);
}

function transactionWriteError(path: string, error: MigrationTransactionError): MiftahError {
  const recovery = error.recoveryPath === undefined ? "" : `; the retained transaction is at '${error.recoveryPath}'`;
  if (error.replacementApplied) {
    return migrationWriteError(
      `the migrated configuration was installed at '${path}', but transaction cleanup could not complete${recovery}`
    );
  }
  return migrationWriteError(`could not safely complete the non-overwriting migration transaction${recovery}`);
}

function isRegularNonSymlink(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function fingerprint(stats: Stats): MigrationSourceFingerprint {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    mode: stats.mode & 0o777
  };
}

function matchesFingerprint(stats: Stats, expected: MigrationSourceFingerprint): boolean {
  const current = fingerprint(stats);
  return (
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs &&
    current.ctimeMs === expected.ctimeMs &&
    current.mode === expected.mode
  );
}

/** A rename changes ctime without changing the captured source content or permissions. */
function matchesFingerprintAfterMove(stats: Stats, expected: MigrationSourceFingerprint): boolean {
  const current = fingerprint(stats);
  return (
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs &&
    current.mode === expected.mode
  );
}

function sameRegularFile(first: Stats, second: Stats): boolean {
  return isRegularNonSymlink(first) && isRegularNonSymlink(second) && matchesFingerprint(second, fingerprint(first));
}

function sameRegularFileIdentity(first: Stats, second: Stats): boolean {
  return isRegularNonSymlink(first) && isRegularNonSymlink(second) && first.dev === second.dev && first.ino === second.ino;
}

async function closeAndRemove(handle: Awaited<ReturnType<typeof open>> | undefined, path: string): Promise<void> {
  const cleanup: unknown[] = [];
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      cleanup.push(error);
    }
  }
  try {
    await rm(path, { force: true });
  } catch (error) {
    cleanup.push(error);
  }
  if (cleanup.length > 0) throw new AggregateError(cleanup, "Unable to clean up migration file transaction");
}

async function writeSyncedExclusive(
  path: string,
  content: string | Uint8Array,
  mode: number,
  beforeWrite?: (path: string) => Promise<void>
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(path, "wx", mode);
    created = true;
    if (beforeWrite !== undefined) await beforeWrite(path);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await chmod(path, mode);
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
    }
  } catch (error) {
    const cleanupPath = created ? path : join(dirname(path), `.${basename(path)}.${randomUUID()}.unused`);
    try {
      await closeAndRemove(handle, cleanupPath);
    } catch {
      throw migrationWriteError("could not clean up an incomplete migration file");
    }
    throw error;
  }
}

async function writeMigrationFile(
  path: string,
  content: string | Uint8Array,
  mode: number,
  sourcePath: string
): Promise<void> {
  await writeSyncedExclusive(path, content, mode, async (targetPath) => {
    if (!(await copyWindowsConfigSecurityDescriptor(sourcePath, targetPath))) {
      throw migrationWriteError("could not preserve and verify the source Windows security descriptor");
    }
  });
}

interface MigrationTransaction {
  readonly directory: string;
  readonly holdingPath: string;
  readonly backupPath: string;
  readonly candidatePath: string;
}

/** Creates an atomically unique same-directory transaction area so a holding name can never be replaced by an unrelated file. */
async function createMigrationTransaction(path: string): Promise<MigrationTransaction> {
  let directory: string | undefined;
  try {
    const prefix = join(dirname(path), `.${basename(path)}.miftah-migrate-`);
    if (process.platform === "win32") {
      directory = `${prefix}${randomUUID()}`;
      if (!(await createWindowsPrivateMigrationDirectory(directory))) {
        throw new Error("migration transaction directory could not be created securely");
      }
    } else {
      directory = await mkdtemp(prefix);
      await chmod(directory, 0o700);
      if (((await lstat(directory)).mode & 0o077) !== 0) {
        throw new Error("migration transaction directory is not private");
      }
    }
  } catch {
    if (directory !== undefined) {
      try {
        await rmdir(directory);
      } catch {
        // This directory contains no source file because its setup failed before the source move.
      }
    }
    throw migrationWriteError("could not create a private migration transaction directory");
  }
  if (directory === undefined) {
    throw migrationWriteError("could not create a private migration transaction directory");
  }
  return {
    directory,
    holdingPath: join(directory, "source.miftah-migrate-hold"),
    backupPath: join(directory, "backup.miftah-migrate.tmp"),
    candidatePath: join(directory, "candidate.miftah-migrate.tmp")
  };
}

async function unlinkTransactionFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

async function removeTransactionDirectory(path: string): Promise<boolean> {
  try {
    await rmdir(path);
    return true;
  } catch {
    return false;
  }
}

async function discardUnmovedTransaction(transaction: MigrationTransaction): Promise<boolean> {
  const backupRemoved = await unlinkTransactionFile(transaction.backupPath);
  const candidateRemoved = await unlinkTransactionFile(transaction.candidatePath);
  const holdingRemoved = await unlinkTransactionFile(transaction.holdingPath);
  return backupRemoved && candidateRemoved && holdingRemoved && (await removeTransactionDirectory(transaction.directory));
}

/** Restores only the fingerprint that was verified after Miftah's own source move, never an arbitrary replacement. */
async function restoreHeldSource(
  transaction: MigrationTransaction,
  path: string,
  expected: MigrationSourceFingerprint
): Promise<boolean> {
  let held: Stats;
  try {
    held = await lstat(transaction.holdingPath);
  } catch {
    return false;
  }
  if (!isRegularNonSymlink(held) || !matchesFingerprint(held, expected)) return false;
  try {
    await link(transaction.holdingPath, path);
  } catch {
    return false;
  }
  return unlinkTransactionFile(transaction.holdingPath);
}

async function restoreCurrentHeldSource(transaction: MigrationTransaction, path: string): Promise<boolean> {
  let held: Stats;
  try {
    held = await lstat(transaction.holdingPath);
  } catch {
    return false;
  }
  return isRegularNonSymlink(held) && (await restoreHeldSource(transaction, path, fingerprint(held)));
}

/** Verifies both bytes and metadata after the intentional rename changed ctime. */
async function matchesHeldSourceSnapshot(
  holdingPath: string,
  expectedBytes: Buffer,
  expectedFingerprint: MigrationSourceFingerprint
): Promise<boolean> {
  let bytes: Buffer;
  let afterRead: Stats;
  try {
    bytes = await readFile(holdingPath);
    afterRead = await lstat(holdingPath);
  } catch {
    return false;
  }
  return matchesFingerprint(afterRead, expectedFingerprint) && bytes.equals(expectedBytes);
}

async function removeCandidateAndTransaction(transaction: MigrationTransaction): Promise<boolean> {
  const backupRemoved = await unlinkTransactionFile(transaction.backupPath);
  const candidateRemoved = await unlinkTransactionFile(transaction.candidatePath);
  return backupRemoved && candidateRemoved && (await removeTransactionDirectory(transaction.directory));
}

/** Publishes a synced candidate only into an absent path, retaining all uncertain state in its private transaction directory. */
async function installWithoutOverwriting(
  path: string,
  transaction: MigrationTransaction,
  source: ConfigMigrationSource,
  candidateContent: string
): Promise<void> {
  try {
    await rename(path, transaction.holdingPath);
  } catch {
    if (!(await discardUnmovedTransaction(transaction))) {
      throw new MigrationTransactionError(transaction.directory);
    }
    throw migrationWriteError("could not begin the non-overwriting migration transaction");
  }

  let held: Stats;
  try {
    held = await lstat(transaction.holdingPath);
  } catch {
    await unlinkTransactionFile(transaction.candidatePath);
    throw new MigrationTransactionError(transaction.directory);
  }
  const heldFingerprint = fingerprint(held);
  const heldMatchesSnapshot =
    isRegularNonSymlink(held) &&
    matchesFingerprintAfterMove(held, source.fingerprint) &&
    (await matchesHeldSourceSnapshot(transaction.holdingPath, source.originalBytes, heldFingerprint));
  if (!heldMatchesSnapshot) {
    const restored = await restoreCurrentHeldSource(transaction, path);
    if (restored && (await removeCandidateAndTransaction(transaction))) {
      throw new MigrationSourceChangedError();
    }
    await unlinkTransactionFile(transaction.candidatePath);
    throw new MigrationSourceChangedError(transaction.directory);
  }

  try {
    await writeMigrationFile(transaction.backupPath, source.originalBytes, source.fingerprint.mode, transaction.holdingPath);
    await link(transaction.backupPath, `${path}.bak`);
    const [privateBackup, publishedBackup] = await Promise.all([lstat(transaction.backupPath), lstat(`${path}.bak`)]);
    if (!sameRegularFileIdentity(privateBackup, publishedBackup)) {
      throw new Error("migration backup publication did not retain the private backup file");
    }
  } catch (error) {
    const restored = await restoreHeldSource(transaction, path, heldFingerprint);
    if (restored && (await removeCandidateAndTransaction(transaction))) {
      if (errorCode(error) === "EEXIST") {
        throw new MiftahError(
          "CONFIG_MIGRATION_BACKUP_EXISTS",
          "CONFIG_MIGRATION_BACKUP_EXISTS: refusing to overwrite the existing migration backup"
        );
      }
      throw migrationWriteError("could not create the configuration backup; the original configuration was restored");
    }
    throw new MigrationTransactionError(transaction.directory);
  }

  try {
    await writeMigrationFile(transaction.candidatePath, candidateContent, source.fingerprint.mode, transaction.holdingPath);
  } catch {
    const restored = await restoreHeldSource(transaction, path, heldFingerprint);
    if (restored && (await removeCandidateAndTransaction(transaction))) {
      throw migrationWriteError("could not create the synced migration candidate; the original configuration was restored");
    }
    throw new MigrationTransactionError(transaction.directory);
  }

  if (!(await matchesHeldSourceSnapshot(transaction.holdingPath, source.originalBytes, heldFingerprint))) {
    const restored = await restoreCurrentHeldSource(transaction, path);
    if (restored && (await removeCandidateAndTransaction(transaction))) {
      throw new MigrationSourceChangedError();
    }
    await unlinkTransactionFile(transaction.candidatePath);
    throw new MigrationSourceChangedError(transaction.directory);
  }

  try {
    await link(transaction.candidatePath, path);
  } catch {
    const restored = await restoreHeldSource(transaction, path, heldFingerprint);
    if (restored && (await removeCandidateAndTransaction(transaction))) {
      throw migrationWriteError("could not publish the migrated configuration; the original configuration was restored");
    }
    await unlinkTransactionFile(transaction.candidatePath);
    throw new MigrationTransactionError(transaction.directory);
  }

  let privateCandidate: Stats;
  let publishedCandidate: Stats;
  try {
    [privateCandidate, publishedCandidate] = await Promise.all([lstat(transaction.candidatePath), lstat(path)]);
  } catch {
    throw new MigrationTransactionError(transaction.directory);
  }
  if (!sameRegularFileIdentity(privateCandidate, publishedCandidate)) {
    throw new MigrationTransactionError(transaction.directory);
  }

  if (!(await matchesHeldSourceSnapshot(transaction.holdingPath, source.originalBytes, heldFingerprint))) {
    await unlinkTransactionFile(transaction.candidatePath);
    throw new MigrationSourceChangedError(transaction.directory, true);
  }
  const holdingRemoved = await unlinkTransactionFile(transaction.holdingPath);
  const candidateAndDirectoryRemoved = await removeCandidateAndTransaction(transaction);
  if (!holdingRemoved || !candidateAndDirectoryRemoved) {
    throw new MigrationTransactionError(transaction.directory, true);
  }
}

async function assertMigrationSourceUnchanged(path: string, source: ConfigMigrationSource): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch {
    throw new MigrationSourceChangedError();
  }
  if (!isRegularNonSymlink(current) || !matchesFingerprint(current, source.fingerprint)) {
    throw new MigrationSourceChangedError();
  }
}

/** Captures the source through a file handle and verifies that its path still names the same regular file. */
export async function readConfigMigrationSource(path: string): Promise<ConfigMigrationSource> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let result: ConfigMigrationSource | undefined;
  let failure: unknown;
  try {
    const beforeOpen = await lstat(path);
    if (!isRegularNonSymlink(beforeOpen)) {
      throw migrationWriteError("the configuration must be a regular non-symbolic-link file before migration");
    }
    handle = await open(path, "r");
    const opened = await handle.stat();
    const afterOpen = await lstat(path);
    if (!sameRegularFile(beforeOpen, opened) || !sameRegularFile(opened, afterOpen)) {
      throw new MigrationSourceChangedError();
    }
    const originalBytes = await handle.readFile();
    const afterRead = await handle.stat();
    const afterReadPath = await lstat(path);
    if (!sameRegularFile(opened, afterRead) || !sameRegularFile(afterRead, afterReadPath)) {
      throw new MigrationSourceChangedError();
    }
    result = { originalBytes, fingerprint: fingerprint(afterRead) };
  } catch (error) {
    failure = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      if (failure === undefined) failure = migrationWriteError("could not close the configuration before migration");
    }
  }
  if (failure instanceof MigrationSourceChangedError) throw sourceChangedWriteError();
  if (failure instanceof MiftahError) throw failure;
  if (failure !== undefined) throw migrationWriteError("could not inspect the configuration before migration");
  if (result === undefined) throw migrationWriteError("could not inspect the configuration before migration");
  return result;
}

/** Applies a prevalidated migration only if the exact source snapshot still occupies the requested path. */
export async function applyConfigMigration(
  path: string,
  source: ConfigMigrationSource,
  plan: ConfigMigrationPlan
): Promise<void> {
  try {
    await assertMigrationSourceUnchanged(path, source);
  } catch (error) {
    if (error instanceof MigrationSourceChangedError) throw sourceChangedWriteError();
    throw error;
  }
  const transaction = await createMigrationTransaction(path);
  try {
    await installWithoutOverwriting(path, transaction, source, `${JSON.stringify(plan.config, null, 2)}\n`);
  } catch (error) {
    if (error instanceof MigrationSourceChangedError) {
      throw sourceChangedWriteError(error.recoveryPath, error.replacementApplied, path);
    }
    if (error instanceof MigrationTransactionError) {
      throw transactionWriteError(path, error);
    }
    throw error;
  }
}

async function readConfigBytes(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new MiftahError("CONFIG_NOT_FOUND", `CONFIG_NOT_FOUND: unable to read config '${path}'`);
  }
}

function parseConfigBytes(bytes: Buffer, path: string): unknown {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", `CONFIG_INVALID_JSON: config '${path}' is not valid UTF-8 JSON`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", `CONFIG_INVALID_JSON: config '${path}' is not valid JSON`);
  }
}

/** Plans by default; writes only after an explicit opt-in and a mandatory exact-byte backup. */
export async function runMigrateConfigCommand(options: MigrateConfigCommandOptions): Promise<MigrateConfigReport> {
  const path = resolvePath(options.configPath);
  let plan = planConfigMigration(parseConfigBytes(await readConfigBytes(path), path));
  let write = false;
  if (options.write === true && plan.changed) {
    const source = await readConfigMigrationSource(path);
    plan = planConfigMigration(parseConfigBytes(source.originalBytes, path));
    if (plan.changed) {
      await applyConfigMigration(path, source, plan);
      write = true;
    }
  }
  return {
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    changed: plan.changed,
    actions: plan.actions,
    write,
    backupCreated: write
  };
}
