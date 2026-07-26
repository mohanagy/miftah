import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  applyConfigReplacement,
  readConfigMigrationSource,
  restoreConfigReplacementWithoutPublishingBackup,
  writeNewConfigFile,
  type ConfigMigrationSource
} from "../cli/migrate-config.js";
import type { MiftahConfig } from "../config/types.js";
import { MiftahError } from "../utils/errors.js";
import { withOAuthConnectionBindingLocks, oauthConnectionTransactionLockWaitMilliseconds } from "./connection-lifecycle.js";
import {
  FileOAuthConnectionMetadataStore,
  OAuthConnectionRegistry,
  type OAuthConnectionRecord
} from "./connection-registry.js";
import {
  connectionCredentialKey,
  createOAuthConfigIdentity,
  createOAuthConnectionBinding,
  sameOAuthConnectionBinding,
  sameOAuthConnectionBindingExceptProfile,
  type OAuthConnectionBinding
} from "./connection-types.js";
import { defaultOAuthConnectionMetadataPath } from "./local-state-paths.js";
import { OAuthLocalLockUnavailableError, withOAuthLocalLock } from "./local-lock.js";
import { createPlatformOAuthCredentialStore, type OAuthCredential, type OAuthCredentialStore } from "./secure-credential-store.js";
import { SecretRedactor } from "../secrets/redact.js";

const journalVersion = 1;
const journalSuffix = ".miftah-oauth-profile-rename-journal";
const sourceBackupMarker = ".miftah-oauth-profile-rename-source-";
const maximumJournalBytes = 256 * 1_024;
const hashPattern = /^[a-f0-9]{64}$/u;
const credentialStates = new Set([
  "connected",
  "expiring",
  "expired",
  "reauth-required",
  "disconnected",
  "unsupported"
]);
const identityStates = new Set([
  "verified",
  "unverified",
  "changed",
  "expired",
  "unavailable",
  "unknown",
  "unsupported"
]);

export interface OAuthProfileRenameBindingPair {
  readonly from: OAuthConnectionBinding;
  readonly to: OAuthConnectionBinding;
}

export interface OAuthProfileRenameDependencies {
  readonly credentialStore: OAuthCredentialStore;
  readonly registry: OAuthConnectionRegistry;
  readonly journalStore?: OAuthProfileRenameJournalStore;
}

export interface OAuthProfileRenameJournalStore {
  load(configPath: string): Promise<OAuthProfileRenameJournal | undefined>;
  create(configPath: string, journal: OAuthProfileRenameJournal): Promise<void>;
  remove(configPath: string): Promise<void>;
}

export interface OAuthProfileRenameTransactionRequest {
  readonly configPath: string;
  readonly source: ConfigMigrationSource;
  readonly candidate: MiftahConfig;
  readonly bindings: readonly OAuthProfileRenameBindingPair[];
  /** Required configuration audit finalization, when the initiating surface has an audit sink. */
  readonly recordAudit?: () => Promise<void>;
}

export interface OAuthProfileRenameTransactionReport {
  readonly backupPath: string;
}

/** Non-secret profile labels supplied only to a trusted initiating audit surface during recovery. */
export interface OAuthProfileRenameRecoveryAuditEvent {
  readonly profile: string;
  readonly newProfile: string;
}

export interface OAuthProfileRenameRecoveryOptions {
  /** Required to finish a forward recovery for a transaction that recorded a required audit intent. */
  readonly finalizeAudit?: (event: OAuthProfileRenameRecoveryAuditEvent) => Promise<void>;
}

interface OAuthProfileRenameJournalBinding {
  readonly from: OAuthConnectionBinding;
  readonly to: OAuthConnectionBinding;
  readonly originalCredentialPresent: boolean;
  readonly originalMetadata?: OAuthConnectionRecord;
}

/** This journal contains only binding and lifecycle metadata; OAuth credentials never leave the OS vault. */
export interface OAuthProfileRenameJournal {
  readonly version: 1;
  readonly configIdentity: string;
  readonly sourceHash: string;
  readonly targetHash: string;
  /** Whether recovery must retain this transaction until its initiating audit surface finalizes it. */
  readonly auditRequired: boolean;
  /** A current-user-only byte-exact source backup retained only while the transaction is in flight. */
  readonly sourceBackupPath: string;
  readonly bindings: readonly OAuthProfileRenameJournalBinding[];
}

function recoveryRequired(): never {
  throw new MiftahError(
    "OAUTH_PROFILE_RENAME_RECOVERY_REQUIRED",
    "OAUTH_PROFILE_RENAME_RECOVERY_REQUIRED: OAuth profile rename recovery must complete before another change can proceed"
  );
}

function invalidJournal(): never {
  recoveryRequired();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function serializeBinding(binding: OAuthConnectionBinding): Record<string, unknown> {
  return {
    version: 1,
    configIdentity: binding.configIdentity,
    connectionRef: binding.connectionRef,
    profile: binding.profile,
    upstream: binding.upstream,
    canonicalResource: binding.canonicalResource,
    issuer: binding.issuer,
    clientRegistration: binding.clientRegistration,
    scopes: [...binding.scopes]
  };
}

function parseBinding(value: unknown): OAuthConnectionBinding {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasOnlyKeys(record, [
      "version",
      "configIdentity",
      "connectionRef",
      "profile",
      "upstream",
      "canonicalResource",
      "issuer",
      "clientRegistration",
      "scopes"
    ]) ||
    record.version !== 1 ||
    typeof record.configIdentity !== "string" ||
    typeof record.connectionRef !== "string" ||
    typeof record.profile !== "string" ||
    typeof record.upstream !== "string" ||
    typeof record.canonicalResource !== "string" ||
    typeof record.issuer !== "string" ||
    typeof record.clientRegistration !== "string" ||
    !Array.isArray(record.scopes) ||
    !record.scopes.every((scope) => typeof scope === "string")
  ) {
    invalidJournal();
  }
  try {
    return createOAuthConnectionBinding({
      configIdentity: record.configIdentity,
      connectionRef: record.connectionRef,
      profile: record.profile,
      upstream: record.upstream,
      resource: record.canonicalResource,
      issuer: record.issuer,
      clientRegistration: record.clientRegistration,
      scopes: record.scopes
    });
  } catch {
    invalidJournal();
  }
}

function serializeMetadata(record: OAuthConnectionRecord): Record<string, unknown> {
  return {
    binding: serializeBinding(record.binding),
    credentialState: record.credentialState,
    identityState: record.identityState,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    updatedAt: record.updatedAt
  };
}

function parseMetadata(value: unknown): OAuthConnectionRecord {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasOnlyKeys(record, ["binding", "credentialState", "identityState", "expiresAt", "updatedAt"]) ||
    !credentialStates.has(record.credentialState as string) ||
    !identityStates.has(record.identityState as string) ||
    !validTimestamp(record.updatedAt) ||
    (record.expiresAt !== undefined && !validTimestamp(record.expiresAt))
  ) {
    invalidJournal();
  }
  return Object.freeze({
    binding: parseBinding(record.binding),
    credentialState: record.credentialState as OAuthConnectionRecord["credentialState"],
    identityState: record.identityState as OAuthConnectionRecord["identityState"],
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt as string }),
    updatedAt: record.updatedAt as string
  });
}

function serializeJournal(journal: OAuthProfileRenameJournal): string {
  return JSON.stringify({
    version: journal.version,
    configIdentity: journal.configIdentity,
    sourceHash: journal.sourceHash,
    targetHash: journal.targetHash,
    auditRequired: journal.auditRequired,
    sourceBackupPath: journal.sourceBackupPath,
    bindings: journal.bindings.map((binding) => ({
      from: serializeBinding(binding.from),
      to: serializeBinding(binding.to),
      originalCredentialPresent: binding.originalCredentialPresent,
      ...(binding.originalMetadata === undefined ? {} : { originalMetadata: serializeMetadata(binding.originalMetadata) })
    }))
  });
}

function journalStorageLimitExceeded(): never {
  throw new MiftahError(
    "OAUTH_CONNECTION_INVALID",
    "OAUTH_CONNECTION_INVALID: OAuth profile rename cannot create a journal that recovery could not safely reload"
  );
}

function assertJournalStorageBounds(journal: OAuthProfileRenameJournal): void {
  if (journal.bindings.length === 0 || journal.bindings.length > 128) journalStorageLimitExceeded();
  if (Buffer.byteLength(serializeJournal(journal), "utf8") > maximumJournalBytes) journalStorageLimitExceeded();
}

function parseJournal(value: unknown): OAuthProfileRenameJournal {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasOnlyKeys(record, ["version", "configIdentity", "sourceHash", "targetHash", "auditRequired", "sourceBackupPath", "bindings"]) ||
    record.version !== journalVersion ||
    typeof record.configIdentity !== "string" ||
    !hashPattern.test(record.configIdentity) ||
    typeof record.sourceHash !== "string" ||
    !hashPattern.test(record.sourceHash) ||
    typeof record.targetHash !== "string" ||
    !hashPattern.test(record.targetHash) ||
    typeof record.auditRequired !== "boolean" ||
    typeof record.sourceBackupPath !== "string" ||
    record.sourceBackupPath.length === 0 ||
    record.sourceBackupPath.length > 4_096 ||
    record.sourceBackupPath.includes("\u0000") ||
    !Array.isArray(record.bindings) ||
    record.bindings.length === 0 ||
    record.bindings.length > 128
  ) {
    invalidJournal();
  }
  const bindings = record.bindings.map((value) => {
    const entry = asRecord(value);
    if (
      entry === undefined ||
      !hasOnlyKeys(entry, ["from", "to", "originalCredentialPresent", "originalMetadata"]) ||
      typeof entry.originalCredentialPresent !== "boolean"
    ) {
      invalidJournal();
    }
    const from = parseBinding(entry.from);
    const to = parseBinding(entry.to);
    if (!sameOAuthConnectionBindingExceptProfile(from, to)) invalidJournal();
    const originalMetadata = entry.originalMetadata === undefined ? undefined : parseMetadata(entry.originalMetadata);
    if (originalMetadata !== undefined && !sameOAuthConnectionBinding(originalMetadata.binding, from)) invalidJournal();
    return Object.freeze({ from, to, originalCredentialPresent: entry.originalCredentialPresent, ...(originalMetadata === undefined ? {} : { originalMetadata }) });
  });
  if (new Set(bindings.map((binding) => connectionCredentialKey(binding.from))).size !== bindings.length) invalidJournal();
  if (bindings.some((binding) => binding.from.configIdentity !== record.configIdentity || binding.to.configIdentity !== record.configIdentity)) {
    invalidJournal();
  }
  const first = bindings[0];
  if (first === undefined) invalidJournal();
  if (bindings.some((binding) => binding.from.profile !== first.from.profile || binding.to.profile !== first.to.profile)) {
    invalidJournal();
  }
  return Object.freeze({
    version: 1,
    configIdentity: record.configIdentity,
    sourceHash: record.sourceHash,
    targetHash: record.targetHash,
    auditRequired: record.auditRequired,
    sourceBackupPath: record.sourceBackupPath,
    bindings: Object.freeze(bindings)
  });
}

function journalPath(configPath: string): string {
  return `${resolve(configPath)}${journalSuffix}`;
}

/** Uses the same filesystem-canonical config identity that the remote OAuth runtime uses for vault keys. */
export async function canonicalOAuthProfileRenameConfigPath(configPath: string): Promise<string> {
  const path = resolve(configPath);
  try {
    return await realpath(path);
  } catch {
    // The guarded source read below retains the authoritative configuration-path error.
    return path;
  }
}

/** Exposed for diagnostics only; it contains no token or credential data. */
export function oauthProfileRenameJournalPath(configPath: string): string {
  return journalPath(configPath);
}

/** File-backed immutable intent journal. Updates are deliberately unnecessary: recovery direction is the exact config bytes. */
export class FileOAuthProfileRenameJournalStore implements OAuthProfileRenameJournalStore {
  async load(configPath: string): Promise<OAuthProfileRenameJournal | undefined> {
    const path = journalPath(configPath);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      recoveryRequired();
    }
    if (!stats.isFile() || stats.isSymbolicLink()) invalidJournal();
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      recoveryRequired();
    }
    if (Buffer.byteLength(content, "utf8") > maximumJournalBytes) invalidJournal();
    try {
      return parseJournal(JSON.parse(content));
    } catch (error) {
      if (error instanceof MiftahError) throw error;
      invalidJournal();
    }
  }

  async create(configPath: string, journal: OAuthProfileRenameJournal): Promise<void> {
    try {
      assertJournalStorageBounds(journal);
      await writeNewConfigFile(journalPath(configPath), serializeJournal(journal));
    } catch (error) {
      if (error instanceof MiftahError) throw error;
      recoveryRequired();
    }
  }

  async remove(configPath: string): Promise<void> {
    try {
      await rm(journalPath(configPath), { force: true });
    } catch {
      recoveryRequired();
    }
  }
}

function journalStoreFor(dependencies: OAuthProfileRenameDependencies): OAuthProfileRenameJournalStore {
  return dependencies.journalStore ?? new FileOAuthProfileRenameJournalStore();
}

function bytesHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function serializedConfig(config: MiftahConfig): Buffer {
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

function sourceBackupPath(configPath: string): string {
  return resolve(dirname(configPath), `.${basename(configPath)}${sourceBackupMarker}${randomUUID()}`);
}

function validBackupPath(configPath: string, backupPath: string): boolean {
  const resolvedConfig = resolve(configPath);
  const resolvedBackup = resolve(backupPath);
  return (
    dirname(resolvedBackup) === dirname(resolvedConfig) &&
    basename(resolvedBackup).startsWith(`.${basename(resolvedConfig)}${sourceBackupMarker}`) &&
    resolvedBackup !== resolvedConfig
  );
}

async function createSourceBackup(path: string, source: ConfigMigrationSource): Promise<void> {
  try {
    await writeNewConfigFile(path, source.originalBytes);
  } catch (error) {
    if (error instanceof MiftahError) throw error;
    recoveryRequired();
  }
}

async function readSourceBackup(configPath: string, journal: OAuthProfileRenameJournal): Promise<ConfigMigrationSource> {
  if (!validBackupPath(configPath, journal.sourceBackupPath)) invalidJournal();
  let source: ConfigMigrationSource;
  try {
    const metadata = await lstat(journal.sourceBackupPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) recoveryRequired();
    source = await readConfigMigrationSource(journal.sourceBackupPath);
  } catch {
    recoveryRequired();
  }
  if (bytesHash(source.originalBytes) !== journal.sourceHash) recoveryRequired();
  return source;
}

async function withProfileRenameLock<Value>(configPath: string, operation: () => Promise<Value>): Promise<Value> {
  try {
    return await withOAuthLocalLock(
      "profile-rename",
      createOAuthConfigIdentity(configPath),
      oauthConnectionTransactionLockWaitMilliseconds,
      operation
    );
  } catch (error) {
    if (error instanceof OAuthLocalLockUnavailableError) {
      throw new MiftahError(
        "OAUTH_CONNECTION_STORE_UNAVAILABLE",
        "OAUTH_CONNECTION_STORE_UNAVAILABLE: OAuth profile rename coordination is unavailable"
      );
    }
    throw error;
  }
}

function credentialsEqual(left: OAuthCredential, right: OAuthCredential): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt &&
    left.clientId === right.clientId &&
    left.clientSecret === right.clientSecret &&
    left.scopes?.length === right.scopes?.length &&
    left.scopes?.every((scope, index) => scope === right.scopes?.[index]) !== false
  );
}

async function captureJournal(
  configPath: string,
  source: ConfigMigrationSource,
  candidate: MiftahConfig,
  pairs: readonly OAuthProfileRenameBindingPair[],
  auditRequired: boolean,
  dependencies: OAuthProfileRenameDependencies
): Promise<OAuthProfileRenameJournal> {
  const bindings: OAuthProfileRenameJournalBinding[] = [];
  for (const pair of pairs) {
    const [credential, metadata] = await Promise.all([
      dependencies.credentialStore.load(pair.from),
      dependencies.registry.snapshot(pair.from)
    ]);
    bindings.push(Object.freeze({
      from: pair.from,
      to: pair.to,
      originalCredentialPresent: credential !== undefined,
      ...(metadata === undefined ? {} : { originalMetadata: metadata })
    }));
  }
  const backupPath = sourceBackupPath(configPath);
  const journal = Object.freeze({
    version: 1,
    configIdentity: createOAuthConfigIdentity(configPath),
    sourceHash: bytesHash(source.originalBytes),
    targetHash: bytesHash(serializedConfig(candidate)),
    auditRequired,
    sourceBackupPath: backupPath,
    bindings: Object.freeze(bindings)
  });
  assertJournalStorageBounds(journal);
  await createSourceBackup(backupPath, source);
  return journal;
}

async function cleanupJournal(
  configPath: string,
  journal: OAuthProfileRenameJournal,
  store: OAuthProfileRenameJournalStore
): Promise<void> {
  // Verify the backup before beginning cleanup. Remove the journal before its backup so a process
  // crash can leave at most an owner-only orphaned source copy, never a recoverable journal that
  // no longer has the bytes required to roll a failed recovered audit back safely.
  await readSourceBackup(configPath, journal);
  try {
    await store.remove(configPath);
  } catch {
    recoveryRequired();
  }
  try {
    await rm(journal.sourceBackupPath);
  } catch {
    try {
      await store.create(configPath, journal);
    } catch {
      recoveryRequired();
    }
    recoveryRequired();
  }
}

async function prepareTargetCredentials(
  journal: OAuthProfileRenameJournal,
  store: OAuthCredentialStore
): Promise<void> {
  for (const binding of journal.bindings) {
    const [from, to] = await Promise.all([store.load(binding.from), store.load(binding.to)]);
    if (to !== undefined) recoveryRequired();
    if (binding.originalCredentialPresent) {
      if (from === undefined) recoveryRequired();
      await store.save(binding.to, from);
    } else if (from !== undefined) {
      recoveryRequired();
    }
  }
}

async function assertDestinationCredentialsAbsent(
  bindings: readonly OAuthProfileRenameBindingPair[],
  store: OAuthCredentialStore
): Promise<void> {
  for (const binding of bindings) {
    if (await store.load(binding.to) !== undefined) {
      throw new MiftahError(
        "OAUTH_CONNECTION_INVALID",
        "OAUTH_CONNECTION_INVALID: the renamed OAuth connection already has a destination credential"
      );
    }
  }
}

async function completeForward(
  journal: OAuthProfileRenameJournal,
  dependencies: OAuthProfileRenameDependencies
): Promise<void> {
  for (const binding of journal.bindings) {
    const [from, to] = await Promise.all([
      dependencies.credentialStore.load(binding.from),
      dependencies.credentialStore.load(binding.to)
    ]);
    if (binding.originalCredentialPresent) {
      if (to === undefined) {
        if (from === undefined) recoveryRequired();
        await dependencies.credentialStore.save(binding.to, from);
      } else if (from !== undefined && !credentialsEqual(from, to)) {
        recoveryRequired();
      }
    } else if (from !== undefined || to !== undefined) {
      recoveryRequired();
    }
    const migrated = await dependencies.registry.migrateProfileBinding(binding.from, binding.to);
    if (migrated === undefined && binding.originalMetadata !== undefined) recoveryRequired();
  }

  for (const binding of journal.bindings) {
    if (!binding.originalCredentialPresent) continue;
    const [from, to] = await Promise.all([
      dependencies.credentialStore.load(binding.from),
      dependencies.credentialStore.load(binding.to)
    ]);
    if (to === undefined) recoveryRequired();
    if (from !== undefined) {
      if (!credentialsEqual(from, to)) recoveryRequired();
      await dependencies.credentialStore.delete(binding.from);
    }
  }
}

async function completeRollback(
  journal: OAuthProfileRenameJournal,
  dependencies: OAuthProfileRenameDependencies
): Promise<void> {
  for (const binding of journal.bindings) {
    const [from, to] = await Promise.all([
      dependencies.credentialStore.load(binding.from),
      dependencies.credentialStore.load(binding.to)
    ]);
    if (binding.originalCredentialPresent) {
      if (from === undefined) {
        if (to === undefined) recoveryRequired();
        await dependencies.credentialStore.save(binding.from, to);
      } else if (to !== undefined && !credentialsEqual(from, to)) {
        recoveryRequired();
      }
    } else if (from !== undefined || to !== undefined) {
      recoveryRequired();
    }
    if (binding.originalCredentialPresent && to !== undefined) await dependencies.credentialStore.delete(binding.to);
    await dependencies.registry.restoreProfileBinding(binding.from, binding.to, binding.originalMetadata);
  }
}

async function currentDirection(configPath: string, journal: OAuthProfileRenameJournal): Promise<"forward" | "rollback"> {
  const current = await readConfigMigrationSource(configPath);
  const currentHash = bytesHash(current.originalBytes);
  if (currentHash === journal.sourceHash) return "rollback";
  if (currentHash === journal.targetHash) return "forward";
  recoveryRequired();
}

async function restoreSourceConfig(configPath: string, journal: OAuthProfileRenameJournal): Promise<void> {
  const current = await readConfigMigrationSource(configPath);
  const currentHash = bytesHash(current.originalBytes);
  if (currentHash === journal.sourceHash) return;
  if (currentHash !== journal.targetHash) recoveryRequired();
  const original = await readSourceBackup(configPath, journal);
  await restoreConfigReplacementWithoutPublishingBackup(configPath, current, original);
  const restored = await readConfigMigrationSource(configPath);
  if (bytesHash(restored.originalBytes) !== journal.sourceHash) recoveryRequired();
}

async function recoverLocked(
  configPath: string,
  journal: OAuthProfileRenameJournal,
  dependencies: OAuthProfileRenameDependencies,
  store: OAuthProfileRenameJournalStore,
  options: OAuthProfileRenameRecoveryOptions
): Promise<void> {
  if (journal.configIdentity !== createOAuthConfigIdentity(configPath) || !validBackupPath(configPath, journal.sourceBackupPath)) {
    invalidJournal();
  }
  // Validate the byte-exact source backup before any forward credential or metadata mutation.
  // Cleanup revalidates it immediately before removing durable recovery state.
  await readSourceBackup(configPath, journal);
  await withOAuthConnectionBindingLocks(
    journal.bindings.flatMap((binding) => [binding.from, binding.to]),
    async () => {
      if (await currentDirection(configPath, journal) === "forward") {
        const finalizeAudit = options.finalizeAudit;
        if (journal.auditRequired) {
          if (finalizeAudit === undefined) recoveryRequired();
          await completeForward(journal, dependencies);
          const first = journal.bindings[0];
          if (first === undefined) invalidJournal();
          try {
            await finalizeAudit({ profile: first.from.profile, newProfile: first.to.profile });
          } catch {
            try {
              await restoreSourceConfig(configPath, journal);
              await completeRollback(journal, dependencies);
              await cleanupJournal(configPath, journal, store);
            } catch {
              recoveryRequired();
            }
            throw new MiftahError(
              "AUDIT_WRITE_FAILED",
              "AUDIT_WRITE_FAILED: required recovered audit finalization failed; configuration and OAuth connection state were restored"
            );
          }
        } else {
          await completeForward(journal, dependencies);
        }
      } else {
        await completeRollback(journal, dependencies);
      }
      await cleanupJournal(configPath, journal, store);
    }
  );
}

/** Returns whether a durable native OAuth profile-rename journal is present for this config. */
export async function hasOAuthProfileRenameJournal(configPath: string): Promise<boolean> {
  const path = journalPath(await canonicalOAuthProfileRenameConfigPath(configPath));
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    recoveryRequired();
  }
}

/** Completes or reverses an interrupted transaction based solely on the byte-exact selected config. */
export async function recoverOAuthProfileRename(
  configPath: string,
  dependencies: OAuthProfileRenameDependencies,
  options: OAuthProfileRenameRecoveryOptions = {}
): Promise<boolean> {
  const path = await canonicalOAuthProfileRenameConfigPath(configPath);
  const store = journalStoreFor(dependencies);
  return withProfileRenameLock(path, async () => {
    const journal = await store.load(path);
    if (journal === undefined) return false;
    await recoverLocked(path, journal, dependencies, store, options);
    return true;
  });
}

function auditFailureAfterRollback(backupPath: string): MiftahError {
  return new MiftahError(
    "AUDIT_WRITE_FAILED",
    `AUDIT_WRITE_FAILED: required audit finalization failed; configuration and OAuth connection state were restored and the original configuration backup was retained at '${backupPath}'`,
    { backupPaths: [backupPath] }
  );
}

/**
 * Publishes a native OAuth profile rename as one recoverable transaction. It never serializes a
 * credential outside the OS vault: the durable journal contains only binding keys and metadata.
 */
export async function runOAuthProfileRenameTransaction(
  request: OAuthProfileRenameTransactionRequest,
  dependencies: OAuthProfileRenameDependencies
): Promise<OAuthProfileRenameTransactionReport> {
  if (request.bindings.length === 0) {
    throw new MiftahError("OAUTH_CONNECTION_INVALID", "OAUTH_CONNECTION_INVALID: OAuth profile rename requires at least one exact binding");
  }
  if (request.bindings.length > 128) journalStorageLimitExceeded();
  const configPath = await canonicalOAuthProfileRenameConfigPath(request.configPath);
  const store = journalStoreFor(dependencies);
  return withProfileRenameLock(configPath, async () => {
    const existing = await store.load(configPath);
    if (existing !== undefined) {
      await recoverLocked(configPath, existing, dependencies, store, {});
      recoveryRequired();
    }

    const expectedIdentity = createOAuthConfigIdentity(configPath);
    const first = request.bindings[0];
    if (
      first === undefined ||
      new Set(request.bindings.map((binding) => connectionCredentialKey(binding.from))).size !== request.bindings.length ||
      request.bindings.some(
        (binding) =>
          !sameOAuthConnectionBindingExceptProfile(binding.from, binding.to) ||
          binding.from.configIdentity !== expectedIdentity ||
          binding.to.configIdentity !== expectedIdentity ||
          binding.from.profile !== first.from.profile ||
          binding.to.profile !== first.to.profile
      )
    ) {
      throw new MiftahError("OAUTH_CONNECTION_INVALID", "OAUTH_CONNECTION_INVALID: OAuth profile rename bindings are invalid");
    }

    return withOAuthConnectionBindingLocks(
      request.bindings.flatMap((binding) => [binding.from, binding.to]),
      async () => {
        await assertDestinationCredentialsAbsent(request.bindings, dependencies.credentialStore);
        const journal = await captureJournal(
          configPath,
          request.source,
          request.candidate,
          request.bindings,
          request.recordAudit !== undefined,
          dependencies
        );
        try {
          await store.create(configPath, journal);
        } catch (error) {
          try {
            await rm(journal.sourceBackupPath, { force: true });
          } catch {
            recoveryRequired();
          }
          throw error;
        }

        let backupPath: string | undefined;
        try {
          await prepareTargetCredentials(journal, dependencies.credentialStore);
          backupPath = await applyConfigReplacement(configPath, request.source, request.candidate);
          await completeForward(journal, dependencies);
        } catch (error) {
          try {
            await restoreSourceConfig(configPath, journal);
            await completeRollback(journal, dependencies);
            await cleanupJournal(configPath, journal, store);
          } catch {
            recoveryRequired();
          }
          throw error;
        }

        try {
          await request.recordAudit?.();
        } catch {
          try {
            await restoreSourceConfig(configPath, journal);
            await completeRollback(journal, dependencies);
            await cleanupJournal(configPath, journal, store);
          } catch {
            recoveryRequired();
          }
          throw auditFailureAfterRollback(backupPath);
        }

        await cleanupJournal(configPath, journal, store);
        return { backupPath };
      }
    );
  });
}

/** Builds the production-only native vault and non-secret metadata dependencies. */
export async function createPlatformOAuthProfileRenameDependencies(
  redactor: SecretRedactor = new SecretRedactor()
): Promise<OAuthProfileRenameDependencies> {
  return {
    credentialStore: await createPlatformOAuthCredentialStore(redactor),
    registry: new OAuthConnectionRegistry(new FileOAuthConnectionMetadataStore(defaultOAuthConnectionMetadataPath()))
  };
}

/** Builds the exact old/new vault bindings for configured connections owned by one renamed profile. */
export function createOAuthProfileRenameBindingPairs(
  configPath: string,
  source: MiftahConfig,
  candidate: MiftahConfig,
  profile: string,
  newProfile: string
): readonly OAuthProfileRenameBindingPair[] {
  if (source.version !== "3" || candidate.version !== "3") return [];
  const configIdentity = createOAuthConfigIdentity(configPath);
  const pairs: OAuthProfileRenameBindingPair[] = [];
  const renamedConnections = candidate.oauth?.connections ?? {};
  for (const [connectionRef, connection] of Object.entries(source.oauth?.connections ?? {})) {
    if (connection.profile !== profile) continue;
    const renamed = renamedConnections[connectionRef as keyof typeof renamedConnections];
    if (renamed === undefined || renamed.profile !== newProfile) {
      throw new MiftahError("OAUTH_CONNECTION_INVALID", "OAUTH_CONNECTION_INVALID: renamed OAuth configuration is incomplete");
    }
    const from = createOAuthConnectionBinding({
      configIdentity,
      connectionRef,
      profile: connection.profile,
      upstream: connection.upstream,
      resource: connection.resource,
      issuer: connection.issuer,
      clientRegistration: connection.clientRegistration,
      scopes: connection.scopes
    });
    const to = createOAuthConnectionBinding({
      configIdentity,
      connectionRef,
      profile: renamed.profile,
      upstream: renamed.upstream,
      resource: renamed.resource,
      issuer: renamed.issuer,
      clientRegistration: renamed.clientRegistration,
      scopes: renamed.scopes
    });
    if (!sameOAuthConnectionBindingExceptProfile(from, to)) {
      throw new MiftahError("OAUTH_CONNECTION_INVALID", "OAUTH_CONNECTION_INVALID: renamed OAuth configuration changed an immutable binding field");
    }
    pairs.push(Object.freeze({ from, to }));
  }
  return Object.freeze(pairs.sort((left, right) => connectionCredentialKey(left.from).localeCompare(connectionCredentialKey(right.from), "en", { sensitivity: "variant" })));
}
