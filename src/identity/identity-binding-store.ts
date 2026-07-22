import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { OAuthLocalLockUnavailableError, withOAuthLocalLock } from "../oauth/local-lock.js";
import { MiftahError } from "../utils/errors.js";
import type { IdentityBindingRecord, IdentityBindingStore } from "./identity-manager.js";

const maximumStoreBytes = 1_024 * 1_024;
const storeLockWaitMilliseconds = 5_000;
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const identityFields = ["provider", "login", "organization", "host"] as const;

function unavailable(): never {
  throw new MiftahError(
    "IDENTITY_BINDING_UNAVAILABLE",
    "IDENTITY_BINDING_UNAVAILABLE: identity binding storage is unavailable"
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 0x20 || code === 0x7f;
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRecord(value: unknown): IdentityBindingRecord {
  if (!isRecord(value) || !isRecord(value.evidence)) unavailable();
  if (
    value.version !== 1 ||
    !boundedIdentifier(value.profile) ||
    (value.upstream !== null && !boundedIdentifier(value.upstream)) ||
    typeof value.configurationFingerprint !== "string" ||
    !fingerprintPattern.test(value.configurationFingerprint) ||
    !validTimestamp(value.verifiedAt) ||
    !Object.keys(value.evidence).every((field) => identityFields.includes(field as typeof identityFields[number]))
  ) {
    unavailable();
  }
  const evidence: IdentityBindingRecord["evidence"] = {};
  for (const field of identityFields) {
    const fieldValue = value.evidence[field];
    if (fieldValue === undefined) continue;
    if (!boundedIdentifier(fieldValue)) unavailable();
    evidence[field] = fieldValue;
  }
  if (Object.keys(evidence).length === 0) unavailable();
  return {
    version: 1,
    profile: value.profile,
    upstream: value.upstream,
    configurationFingerprint: value.configurationFingerprint,
    evidence,
    verifiedAt: value.verifiedAt
  };
}

function normalizeRecords(values: readonly unknown[]): IdentityBindingRecord[] {
  const records = values.map(normalizeRecord);
  const targets = new Set<string>();
  for (const record of records) {
    const target = JSON.stringify([record.profile, record.upstream]);
    if (targets.has(target)) unavailable();
    targets.add(target);
  }
  return records;
}

function mergeRecords(
  existing: readonly IdentityBindingRecord[],
  incoming: readonly IdentityBindingRecord[]
): IdentityBindingRecord[] {
  const records = new Map<string, IdentityBindingRecord>();
  for (const record of [...existing, ...incoming]) {
    const target = JSON.stringify([record.profile, record.upstream]);
    const current = records.get(target);
    if (current === undefined || Date.parse(record.verifiedAt) >= Date.parse(current.verifiedAt)) {
      records.set(target, record);
    }
  }
  return [...records.values()].sort((left, right) =>
    JSON.stringify([left.profile, left.upstream]).localeCompare(JSON.stringify([right.profile, right.upstream]))
  );
}

async function setRestrictiveMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  }
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

/** Returns a config-identity-namespaced path without exposing the raw config path. */
export function defaultIdentityBindingPath(configPath: string): string {
  const identity = createHash("sha256").update(resolve(configPath), "utf8").digest("hex");
  const productDirectory = platform() === "win32" || platform() === "darwin" ? "Miftah" : "miftah";
  return join(globalStateRoot(), productDirectory, "identity-bindings", `${identity}.json`);
}

/** Restrictive, atomic persistence for bounded non-secret identity evidence. */
export class FileIdentityBindingStore implements IdentityBindingStore {
  constructor(private readonly path: string) {}

  async load(): Promise<readonly IdentityBindingRecord[]> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      unavailable();
    }
    if (Buffer.byteLength(content, "utf8") > maximumStoreBytes) unavailable();
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      unavailable();
    }
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) unavailable();
    return normalizeRecords(value.records);
  }

  async save(records: readonly IdentityBindingRecord[]): Promise<void> {
    const normalized = normalizeRecords(records);
    try {
      await withOAuthLocalLock("identity-binding", resolve(this.path), storeLockWaitMilliseconds, async () => {
        const existing = await this.load();
        await this.persist(mergeRecords(existing, normalized));
      });
    } catch (error) {
      if (error instanceof MiftahError) throw error;
      if (error instanceof OAuthLocalLockUnavailableError) unavailable();
      unavailable();
    }
  }

  private async persist(records: readonly IdentityBindingRecord[]): Promise<void> {
    const content = JSON.stringify({ version: 1, records });
    if (Buffer.byteLength(content, "utf8") > maximumStoreBytes) unavailable();
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
        // Cleanup must not replace the stable storage diagnostic.
      }
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // The temporary file contains only bounded non-secret evidence.
      }
      if (error instanceof MiftahError) throw error;
      unavailable();
    }
  }
}
