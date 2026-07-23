import {
  createOAuthConnectionBinding,
  parseOAuthConnectionRef,
  sameOAuthConnectionBinding,
  type OAuthConnectionBinding,
  type OAuthConnectionRef,
  type OAuthCredentialState,
  type OAuthIdentityState
} from "./connection-types.js";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { OAuthLocalLockUnavailableError, withOAuthLocalLock } from "./local-lock.js";
import { MiftahError } from "../utils/errors.js";

/** Non-secret local state for one credential-vault binding. */
export interface OAuthConnectionRecord {
  readonly binding: OAuthConnectionBinding;
  readonly credentialState: OAuthCredentialState;
  readonly identityState: OAuthIdentityState;
  readonly expiresAt?: string;
  readonly updatedAt: string;
}

/** Persistent metadata boundary. Implementations must never serialize an OAuth token. */
export interface OAuthConnectionMetadataStore {
  load(): Promise<readonly OAuthConnectionRecord[]>;
  save(records: readonly OAuthConnectionRecord[]): Promise<void>;
}

interface LockingOAuthConnectionMetadataStore extends OAuthConnectionMetadataStore {
  withExclusiveLock<Value>(operation: () => Promise<Value>): Promise<Value>;
}

const credentialStates = new Set<OAuthCredentialState>([
  "connected",
  "expiring",
  "expired",
  "reauth-required",
  "disconnected",
  "unsupported"
]);
const identityStates = new Set<OAuthIdentityState>([
  "verified",
  "unverified",
  "changed",
  "expired",
  "unavailable",
  "unknown",
  "unsupported"
]);
const maximumMetadataBytes = 1_024 * 1_024;
const metadataLockWaitMilliseconds = 5_000;

function invalidConnection(): never {
  throw new MiftahError("OAUTH_CONNECTION_INVALID", "OAUTH_CONNECTION_INVALID: OAuth connection metadata is invalid");
}

function missingConnection(): never {
  throw new MiftahError("OAUTH_CONNECTION_NOT_FOUND", "OAUTH_CONNECTION_NOT_FOUND: OAuth connection does not exist");
}

function mismatchedConnection(): never {
  throw new MiftahError(
    "OAUTH_CONNECTION_BINDING_MISMATCH",
    "OAUTH_CONNECTION_BINDING_MISMATCH: OAuth connection does not match its expected binding"
  );
}

function unavailableStore(): never {
  throw new MiftahError(
    "OAUTH_CONNECTION_STORE_UNAVAILABLE",
    "OAUTH_CONNECTION_STORE_UNAVAILABLE: OAuth connection metadata storage is unavailable"
  );
}

function validTimestamp(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizeRecord(value: unknown): OAuthConnectionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidConnection();
  const record = value as Record<string, unknown>;
  if (typeof record.binding !== "object" || record.binding === null || Array.isArray(record.binding)) invalidConnection();
  const binding = record.binding as Record<string, unknown>;
  if (
    binding.version !== 1 ||
    typeof binding.configIdentity !== "string" ||
    typeof binding.connectionRef !== "string" ||
    typeof binding.profile !== "string" ||
    typeof binding.upstream !== "string" ||
    typeof binding.canonicalResource !== "string" ||
    typeof binding.issuer !== "string" ||
    typeof binding.clientRegistration !== "string" ||
    !Array.isArray(binding.scopes) ||
    !binding.scopes.every((scope) => typeof scope === "string") ||
    !credentialStates.has(record.credentialState as OAuthCredentialState) ||
    !identityStates.has(record.identityState as OAuthIdentityState) ||
    !validTimestamp(record.updatedAt as string | undefined) ||
    (record.expiresAt !== undefined && !validTimestamp(record.expiresAt as string | undefined))
  ) {
    invalidConnection();
  }
  return Object.freeze({
    binding: createOAuthConnectionBinding({
      configIdentity: binding.configIdentity,
      connectionRef: binding.connectionRef,
      profile: binding.profile,
      upstream: binding.upstream,
      resource: binding.canonicalResource,
      issuer: binding.issuer,
      clientRegistration: binding.clientRegistration,
      scopes: binding.scopes as string[]
    }),
    credentialState: record.credentialState as OAuthCredentialState,
    identityState: record.identityState as OAuthIdentityState,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt as string }),
    updatedAt: record.updatedAt as string
  });
}

function storedRecord(record: OAuthConnectionRecord): OAuthConnectionRecord {
  const normalized = normalizeRecord(record);
  return {
    binding: {
      version: 1,
      configIdentity: normalized.binding.configIdentity,
      connectionRef: normalized.binding.connectionRef,
      profile: normalized.binding.profile,
      upstream: normalized.binding.upstream,
      canonicalResource: normalized.binding.canonicalResource,
      issuer: normalized.binding.issuer,
      clientRegistration: normalized.binding.clientRegistration,
      scopes: [...normalized.binding.scopes]
    },
    credentialState: normalized.credentialState,
    identityState: normalized.identityState,
    ...(normalized.expiresAt === undefined ? {} : { expiresAt: normalized.expiresAt }),
    updatedAt: normalized.updatedAt
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function setRestrictiveMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  }
}

function supportsExclusiveLock(store: OAuthConnectionMetadataStore): store is LockingOAuthConnectionMetadataStore {
  return "withExclusiveLock" in store && typeof store.withExclusiveLock === "function";
}

/**
 * Persists only non-secret OAuth connection state with restrictive file permissions. Token
 * envelopes remain exclusively in the native OS vault handled by PlatformOAuthCredentialStore.
 */
export class FileOAuthConnectionMetadataStore implements OAuthConnectionMetadataStore {
  constructor(private readonly path: string) {}

  /**
   * Runs a whole read-modify-write operation under a local OS-visible lock. The operating system
   * releases the listener when its owner exits, so an abnormal exit cannot strand metadata behind
   * a stale lock artifact. A bound lock is still never stolen while its owning process is alive.
   */
  async withExclusiveLock<Value>(operation: () => Promise<Value>): Promise<Value> {
    const directory = dirname(this.path);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await setRestrictiveMode(directory, 0o700);
      return await withOAuthLocalLock("connection-metadata", resolve(this.path), metadataLockWaitMilliseconds, operation);
    } catch (error) {
      if (error instanceof MiftahError) throw error;
      if (error instanceof OAuthLocalLockUnavailableError) unavailableStore();
      unavailableStore();
    }
  }

  async load(): Promise<readonly OAuthConnectionRecord[]> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      unavailableStore();
    }
    if (Buffer.byteLength(content, "utf8") > maximumMetadataBytes) invalidConnection();
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      invalidConnection();
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).version !== 1 ||
      !Array.isArray((value as Record<string, unknown>).records)
    ) {
      invalidConnection();
    }
    return (value as { records: OAuthConnectionRecord[] }).records;
  }

  async save(records: readonly OAuthConnectionRecord[]): Promise<void> {
    const content = JSON.stringify({ version: 1, records: records.map(storedRecord) });
    if (Buffer.byteLength(content, "utf8") > maximumMetadataBytes) invalidConnection();
    const directory = dirname(this.path);
    const temporaryPath = join(directory, `.${basename(this.path)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await setRestrictiveMode(directory, 0o700);
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await setRestrictiveMode(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // The following best-effort cleanup is intentionally independent of the original failure.
      }
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // A stale temporary file does not expose OAuth tokens because it never contains credentials.
      }
      if (error instanceof MiftahError) throw error;
      unavailableStore();
    }
  }

}

/**
 * Serializes metadata operations in one runtime and requires an exact expected binding for every
 * lookup or lifecycle update. File-backed stores extend that serialization across independently
 * running Miftah processes so a whole read-modify-write update cannot lose another connection.
 */
export class OAuthConnectionRegistry {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: OAuthConnectionMetadataStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async create(binding: OAuthConnectionBinding): Promise<OAuthConnectionRecord> {
    return this.serialized(async () => {
      const records = await this.records();
      const existing = records.find((record) => record.binding.connectionRef === binding.connectionRef);
      if (existing !== undefined) {
        if (!sameOAuthConnectionBinding(existing.binding, binding)) mismatchedConnection();
        return existing;
      }
      if (
        records.some(
          (record) =>
            record.binding.configIdentity === binding.configIdentity &&
            record.binding.profile === binding.profile &&
            record.binding.upstream === binding.upstream
        )
      ) {
        invalidConnection();
      }
      const record: OAuthConnectionRecord = Object.freeze({
        binding,
        credentialState: "disconnected",
        identityState: "unverified",
        updatedAt: this.timestamp()
      });
      await this.persist([...records, record]);
      return record;
    });
  }

  async get(connectionRef: OAuthConnectionRef | string, expected: OAuthConnectionBinding): Promise<OAuthConnectionRecord> {
    return this.serialized(async () => this.requireExact(await this.records(), connectionRef, expected));
  }

  async setCredentialState(
    connectionRef: OAuthConnectionRef | string,
    expected: OAuthConnectionBinding,
    credentialState: OAuthCredentialState,
    expiresAt?: string
  ): Promise<OAuthConnectionRecord> {
    if (!credentialStates.has(credentialState) || (expiresAt !== undefined && !validTimestamp(expiresAt))) invalidConnection();
    return this.serialized(async () => {
      const records = await this.records();
      const existing = this.requireExact(records, connectionRef, expected);
      const updated: OAuthConnectionRecord = Object.freeze({
        binding: existing.binding,
        credentialState,
        identityState: existing.identityState,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        updatedAt: this.timestamp()
      });
      await this.persist(records.map((record) => (record.binding.connectionRef === existing.binding.connectionRef ? updated : record)));
      return updated;
    });
  }

  async setIdentityState(
    connectionRef: OAuthConnectionRef | string,
    expected: OAuthConnectionBinding,
    identityState: OAuthIdentityState
  ): Promise<OAuthConnectionRecord> {
    if (!identityStates.has(identityState)) invalidConnection();
    return this.serialized(async () => {
      const records = await this.records();
      const existing = this.requireExact(records, connectionRef, expected);
      const updated: OAuthConnectionRecord = Object.freeze({
        binding: existing.binding,
        credentialState: existing.credentialState,
        identityState,
        ...(existing.expiresAt === undefined ? {} : { expiresAt: existing.expiresAt }),
        updatedAt: this.timestamp()
      });
      await this.persist(records.map((record) => (record.binding.connectionRef === existing.binding.connectionRef ? updated : record)));
      return updated;
    });
  }

  async remove(connectionRef: OAuthConnectionRef | string, expected: OAuthConnectionBinding): Promise<void> {
    await this.serialized(async () => {
      const records = await this.records();
      const existing = this.requireExact(records, connectionRef, expected);
      await this.persist(records.filter((record) => record.binding.connectionRef !== existing.binding.connectionRef));
    });
  }

  private async records(): Promise<OAuthConnectionRecord[]> {
    try {
      const values = await this.store.load();
      if (!Array.isArray(values)) invalidConnection();
      return values.map(normalizeRecord);
    } catch (error) {
      if (error instanceof MiftahError) throw error;
      invalidConnection();
    }
  }

  private async persist(records: readonly OAuthConnectionRecord[]): Promise<void> {
    try {
      await this.store.save(records);
    } catch (error) {
      if (error instanceof MiftahError) throw error;
      invalidConnection();
    }
  }

  private requireExact(
    records: readonly OAuthConnectionRecord[],
    connectionRef: OAuthConnectionRef | string,
    expected: OAuthConnectionBinding
  ): OAuthConnectionRecord {
    const reference = parseOAuthConnectionRef(connectionRef);
    const record = records.find((candidate) => candidate.binding.connectionRef === reference);
    if (record === undefined) missingConnection();
    if (!sameOAuthConnectionBinding(record.binding, expected)) mismatchedConnection();
    return record;
  }

  private timestamp(): string {
    const value = this.now();
    if (!validTimestamp(value)) invalidConnection();
    return value;
  }

  private async serialized<Value>(operation: () => Promise<Value>): Promise<Value> {
    let release: (() => void) | undefined;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return supportsExclusiveLock(this.store) ? await this.store.withExclusiveLock(operation) : await operation();
    } finally {
      release?.();
    }
  }
}
