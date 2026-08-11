import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual
} from "node:crypto";
import type {
  AuthenticatedRequestContext,
  AuthenticatedRequestContextBoundary
} from "../http/authenticated-request-context.js";

export const PROFILE_CONTEXT_ARGUMENT = "_miftah_profile_context";
export const PROFILE_CONTEXT_META_KEY = "miftah/profile-context";

const handlePrefix = "mctx1";
const auditCorrelationPrefix = "mctxc1.";
const maximumHandleBytes = 4_096;
const maximumTextBytes = 4_096;
const keyBytes = 32;
const initializationVectorBytes = 12;
const authenticationTagBytes = 16;
const identifierBytes = 16;
const defaultMaximumLifetimeMs = 15 * 60_000;
const defaultClockSkewMs = 30_000;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const decimalPattern = /^(?:0|[1-9]\d*)$/u;

export type ProfileContextHandleErrorCode =
  | "PROFILE_CONTEXT_UNAVAILABLE"
  | "PROFILE_CONTEXT_INVALID"
  | "PROFILE_CONTEXT_EXPIRED"
  | "PROFILE_CONTEXT_REVOKED";

const safeMessages: Readonly<Record<ProfileContextHandleErrorCode, string>> = Object.freeze({
  PROFILE_CONTEXT_UNAVAILABLE: "Profile context is unavailable.",
  PROFILE_CONTEXT_INVALID: "Profile context is invalid.",
  PROFILE_CONTEXT_EXPIRED: "Profile context has expired.",
  PROFILE_CONTEXT_REVOKED: "Profile context has been revoked."
});

/** A fixed, bearer-free failure emitted by the production profile-context boundary. */
export class ProfileContextHandleError extends Error {
  readonly code: ProfileContextHandleErrorCode;

  constructor(code: ProfileContextHandleErrorCode) {
    super(safeMessages[code] ?? safeMessages.PROFILE_CONTEXT_INVALID);
    Object.defineProperty(this, "name", { value: "ProfileContextHandleError", configurable: true });
    this.code = Object.hasOwn(safeMessages, code) ? code : "PROFILE_CONTEXT_INVALID";
  }
}

/** One deployment sealing epoch. Only the snapshot active epoch may mint. */
export interface ProfileContextKeyEpoch {
  readonly epoch: number;
  readonly key: Uint8Array;
  readonly activatedAtMs: number;
  /** Required for a retained resolution-only epoch and forbidden on the active epoch. */
  readonly resolveUntilMs?: number;
}

/** Atomic key-manager view shared by every instance in one deployment. */
export interface ProfileContextKeyringSnapshot {
  readonly activeEpoch: number;
  readonly epochs: readonly ProfileContextKeyEpoch[];
}

/**
 * Returns a short-TTL cached atomic snapshot with a host-enforced timeout.
 * The service calls it once per mint, resolve, or revoke and twice per replace.
 */
export type ProfileContextKeyringProvider =
  () => ProfileContextKeyringSnapshot | Promise<ProfileContextKeyringSnapshot>;

/** Deployment-wide bounded revocation state. Backend failures must reject. */
export interface ProfileContextRevocationStore {
  isRevoked(id: string, atMs: number): boolean | Promise<boolean>;
  revoke(id: string, expiresAtMs: number, atMs: number): void | Promise<void>;
}

export interface ProfileContextHandleServiceOptions {
  readonly deploymentId: string;
  readonly profiles: readonly string[];
  readonly keyringProvider: ProfileContextKeyringProvider;
  readonly auditKey: Uint8Array;
  readonly revocations: ProfileContextRevocationStore;
  readonly maximumLifetimeMs?: number;
  readonly clockSkewMs?: number;
  readonly clock?: () => number;
  /** Internal deterministic-test seam. Production callers should omit it. */
  readonly randomBytes?: (size: number) => Uint8Array;
}

/** Opt-in bridge used only by a host that supplies verified request authentication. */
export interface ModernProfileContextRuntimeOptions {
  readonly handles: ProfileContextHandleService;
  readonly authenticatedRequestContext: AuthenticatedRequestContextBoundary<unknown>;
  readonly handleLifetimeMs?: number;
}

export interface MintedProfileContext {
  /** Model-visible bearer. Never place it in logs, diagnostics, audit, or upstream arguments. */
  readonly handle: string;
  readonly profile: string;
  readonly auditCorrelation: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ResolvedProfileContext {
  readonly profile: string;
  readonly auditCorrelation: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ProfileContextReplacementAudit {
  readonly previous: ResolvedProfileContext;
  readonly replacement: ResolvedProfileContext;
}

interface ProfileContextPayload {
  readonly version: 1;
  readonly id: string;
  readonly deploymentId: string;
  readonly keyEpoch: number;
  readonly profile: string;
  readonly binding: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

interface ValidatedKeyring {
  readonly activeEpoch: number;
  readonly active: ProfileContextKeyEpoch & { readonly key: Buffer };
  readonly epochs: ReadonlyMap<number, ProfileContextKeyEpoch & { readonly key: Buffer }>;
}

interface OpenedProfileContext {
  readonly payload: ProfileContextPayload;
  readonly resolved: ResolvedProfileContext;
}

/**
 * Production, request-scoped profile selector for modern stateless MCP hosts.
 *
 * The service authenticates selection only. Callers must authenticate first and
 * continue to enforce policy, approvals, identity, and operation authorization.
 */
export class ProfileContextHandleService {
  private readonly deploymentId: string;
  private readonly profiles: ReadonlySet<string>;
  private readonly keyringProvider: ProfileContextKeyringProvider;
  private readonly auditKey: Buffer;
  private readonly revocations: ProfileContextRevocationStore;
  private readonly maximumLifetimeMs: number;
  private readonly clockSkewMs: number;
  private readonly clock: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;
  private highestActiveEpoch = -1;
  private highestActiveKey: Buffer | undefined;

  constructor(options: ProfileContextHandleServiceOptions) {
    if (typeof options !== "object" || options === null) throw invalid();
    this.deploymentId = boundedText(readProperty(options, "deploymentId"));
    const profiles = readProperty(options, "profiles");
    if (!Array.isArray(profiles) || profiles.length === 0) throw invalid();
    const copiedProfiles = profiles.map((profile) => boundedText(profile));
    if (new Set(copiedProfiles).size !== copiedProfiles.length) throw invalid();
    this.profiles = new Set(copiedProfiles);

    const keyringProvider = readProperty(options, "keyringProvider");
    const revocations = readProperty(options, "revocations");
    if (typeof keyringProvider !== "function" || !isRevocationStore(revocations)) throw invalid();
    this.keyringProvider = keyringProvider as ProfileContextKeyringProvider;
    this.revocations = revocations;
    this.auditKey = copyExactKey(readProperty(options, "auditKey"));

    this.maximumLifetimeMs = positiveSafeInteger(
      readProperty(options, "maximumLifetimeMs") ?? defaultMaximumLifetimeMs
    );
    this.clockSkewMs = nonNegativeSafeInteger(readProperty(options, "clockSkewMs") ?? defaultClockSkewMs);
    const clock = readProperty(options, "clock") ?? Date.now;
    const randomBytes = readProperty(options, "randomBytes") ?? nodeRandomBytes;
    if (typeof clock !== "function" || typeof randomBytes !== "function") throw invalid();
    this.clock = clock as () => number;
    this.randomBytes = randomBytes as (size: number) => Uint8Array;
  }

  async mint(
    profile: string,
    authenticated: AuthenticatedRequestContext,
    lifetimeMs: number
  ): Promise<MintedProfileContext> {
    const nowMs = this.nowMs();
    return this.mintAt(profile, authenticated, lifetimeMs, nowMs, await this.keyring(nowMs));
  }

  async resolve(
    handle: string,
    authenticated: AuthenticatedRequestContext
  ): Promise<ResolvedProfileContext> {
    return (await this.openAndValidate(handle, authenticated)).resolved;
  }

  async revoke(handle: string, authenticated: AuthenticatedRequestContext): Promise<void> {
    const opened = await this.openAndValidate(handle, authenticated);
    await this.revokeOpened(opened);
  }

  /**
   * Mints a replacement, commits a bearer-free audit transition, revokes the
   * prior context, and only then discloses the replacement to the caller.
   */
  async replace(
    handle: string,
    profile: string,
    authenticated: AuthenticatedRequestContext,
    lifetimeMs: number,
    commitAudit: (audit: ProfileContextReplacementAudit) => void | Promise<void>
  ): Promise<MintedProfileContext> {
    if (typeof commitAudit !== "function") throw invalid();
    const previous = await this.openAndValidate(handle, authenticated);
    const nowMs = this.nowMs();
    const replacement = await this.mintAt(
      profile,
      authenticated,
      lifetimeMs,
      nowMs,
      await this.keyring(nowMs)
    );
    await commitAudit({
      previous: previous.resolved,
      replacement: withoutHandle(replacement)
    });
    await this.revokeOpened(previous);
    return replacement;
  }

  private async mintAt(
    profileInput: string,
    authenticated: AuthenticatedRequestContext,
    lifetimeMsInput: number,
    nowMs: number,
    keyring: ValidatedKeyring
  ): Promise<MintedProfileContext> {
    const profile = boundedText(profileInput);
    if (!this.profiles.has(profile)) throw invalid();
    const binding = authenticatedBinding(authenticated, nowMs);
    const lifetimeMs = positiveSafeInteger(lifetimeMsInput);
    if (lifetimeMs > this.maximumLifetimeMs) throw invalid();
    const expiresAtMs = Math.min(nowMs + lifetimeMs, authenticated.expiresAtMs);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) throw expired();
    const id = this.randomIdentifier();
    const payload: ProfileContextPayload = Object.freeze({
      version: 1,
      id,
      deploymentId: this.deploymentId,
      keyEpoch: keyring.activeEpoch,
      profile,
      binding,
      issuedAtMs: nowMs,
      expiresAtMs
    });
    return Object.freeze({
      handle: this.seal(payload, keyring.active),
      profile,
      auditCorrelation: this.auditCorrelation(id),
      issuedAtMs: nowMs,
      expiresAtMs
    });
  }

  private async openAndValidate(
    handleInput: string,
    authenticated: AuthenticatedRequestContext
  ): Promise<OpenedProfileContext> {
    const nowMs = this.nowMs();
    const binding = authenticatedBinding(authenticated, nowMs);
    const envelope = parseEnvelope(handleInput);
    const keyring = await this.keyring(nowMs);
    const keyEpoch = keyring.epochs.get(envelope.epoch);
    if (
      keyEpoch === undefined ||
      envelope.epoch > keyring.activeEpoch ||
      (envelope.epoch !== keyring.activeEpoch &&
        (keyEpoch.resolveUntilMs === undefined || keyEpoch.resolveUntilMs <= nowMs))
    ) {
      throw invalid();
    }
    const payload = this.open(envelope, keyEpoch);
    if (
      payload.deploymentId !== this.deploymentId ||
      payload.keyEpoch !== envelope.epoch ||
      !this.profiles.has(payload.profile) ||
      !safeTextEqual(payload.binding, binding) ||
      payload.issuedAtMs > nowMs + this.clockSkewMs ||
      payload.expiresAtMs - payload.issuedAtMs > this.maximumLifetimeMs
    ) {
      throw invalid();
    }
    if (payload.expiresAtMs <= nowMs) throw expired();
    let revoked: unknown;
    try {
      revoked = await this.revocations.isRevoked(payload.id, nowMs);
    } catch {
      throw unavailable();
    }
    if (typeof revoked !== "boolean") throw unavailable();
    if (revoked) throw new ProfileContextHandleError("PROFILE_CONTEXT_REVOKED");
    return Object.freeze({
      payload,
      resolved: Object.freeze({
        profile: payload.profile,
        auditCorrelation: this.auditCorrelation(payload.id),
        issuedAtMs: payload.issuedAtMs,
        expiresAtMs: payload.expiresAtMs
      })
    });
  }

  private async revokeOpened(opened: OpenedProfileContext): Promise<void> {
    try {
      await this.revocations.revoke(opened.payload.id, opened.payload.expiresAtMs, this.nowMs());
    } catch {
      throw unavailable();
    }
  }

  private seal(payload: ProfileContextPayload, epoch: ProfileContextKeyEpoch & { readonly key: Buffer }): string {
    try {
      const initializationVector = copyRandomBytes(this.randomBytes, initializationVectorBytes);
      const cipher = createCipheriv("aes-256-gcm", epoch.key, initializationVector, {
        authTagLength: authenticationTagBytes
      });
      cipher.setAAD(this.additionalAuthenticatedData(epoch.epoch));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
      return [
        handlePrefix,
        String(epoch.epoch),
        initializationVector.toString("base64url"),
        ciphertext.toString("base64url"),
        cipher.getAuthTag().toString("base64url")
      ].join(".");
    } catch (error) {
      if (error instanceof ProfileContextHandleError) throw error;
      throw unavailable();
    }
  }

  private open(
    envelope: ReturnType<typeof parseEnvelope>,
    epoch: ProfileContextKeyEpoch & { readonly key: Buffer }
  ): ProfileContextPayload {
    try {
      const decipher = createDecipheriv("aes-256-gcm", epoch.key, envelope.initializationVector, {
        authTagLength: authenticationTagBytes
      });
      decipher.setAAD(this.additionalAuthenticatedData(envelope.epoch));
      decipher.setAuthTag(envelope.authenticationTag);
      const plaintext = Buffer.concat([
        decipher.update(envelope.ciphertext),
        decipher.final()
      ]).toString("utf8");
      return parsePayload(JSON.parse(plaintext) as unknown);
    } catch (error) {
      if (error instanceof ProfileContextHandleError) throw error;
      throw invalid();
    }
  }

  private async keyring(nowMs: number): Promise<ValidatedKeyring> {
    let snapshot: unknown;
    try {
      snapshot = await this.keyringProvider();
    } catch {
      throw unavailable();
    }
    let validated: ValidatedKeyring;
    try {
      validated = validateKeyring(snapshot, nowMs, this.maximumLifetimeMs, this.clockSkewMs, this.auditKey);
    } catch {
      throw unavailable();
    }
    if (validated.activeEpoch < this.highestActiveEpoch) throw unavailable();
    if (
      validated.activeEpoch === this.highestActiveEpoch &&
      this.highestActiveKey !== undefined &&
      !safeBufferEqual(validated.active.key, this.highestActiveKey)
    ) {
      throw unavailable();
    }
    if (validated.activeEpoch > this.highestActiveEpoch) {
      this.highestActiveEpoch = validated.activeEpoch;
      this.highestActiveKey = Buffer.from(validated.active.key);
    }
    return validated;
  }

  private additionalAuthenticatedData(epoch: number): Buffer {
    return lengthPrefixed(["miftah-profile-context-v1", this.deploymentId, String(epoch)]);
  }

  private auditCorrelation(id: string): string {
    return `${auditCorrelationPrefix}${createHmac("sha256", this.auditKey)
      .update("miftah-profile-context-audit-v1\0", "utf8")
      .update(id, "utf8")
      .digest()
      .subarray(0, 16)
      .toString("base64url")}`;
  }

  private randomIdentifier(): string {
    return copyRandomBytes(this.randomBytes, identifierBytes).toString("base64url");
  }

  private nowMs(): number {
    let value: unknown;
    try {
      value = this.clock();
    } catch {
      throw unavailable();
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw unavailable();
    return value;
  }
}

/** A bounded store suitable for tests or multiple services in one process only. */
export class InMemoryProfileContextRevocationStore implements ProfileContextRevocationStore {
  private readonly expirations = new Map<string, number>();

  constructor(private readonly maximumEntries = 1_024) {
    positiveSafeInteger(maximumEntries);
  }

  isRevoked(id: string, atMs: number): boolean {
    const safeId = internalIdentifier(id);
    const nowMs = nonNegativeSafeInteger(atMs);
    this.prune(nowMs);
    const expiresAtMs = this.expirations.get(safeId);
    return expiresAtMs !== undefined && expiresAtMs > nowMs;
  }

  revoke(id: string, expiresAtMs: number, atMs: number): void {
    const safeId = internalIdentifier(id);
    const expiry = positiveSafeInteger(expiresAtMs);
    const nowMs = nonNegativeSafeInteger(atMs);
    this.prune(nowMs);
    if (expiry <= nowMs) {
      this.expirations.delete(safeId);
      return;
    }
    if (!this.expirations.has(safeId) && this.expirations.size >= this.maximumEntries) {
      throw new Error("Profile context revocation capacity is unavailable.");
    }
    this.expirations.set(safeId, expiry);
  }

  private prune(atMs: number): void {
    for (const [id, expiresAtMs] of this.expirations) {
      if (expiresAtMs <= atMs) this.expirations.delete(id);
    }
  }
}

function validateKeyring(
  value: unknown,
  nowMs: number,
  maximumLifetimeMs: number,
  clockSkewMs: number,
  auditKey: Buffer
): ValidatedKeyring {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const snapshot = value as Partial<ProfileContextKeyringSnapshot>;
  const activeEpoch = positiveSafeInteger(snapshot.activeEpoch);
  if (!Array.isArray(snapshot.epochs) || snapshot.epochs.length === 0) throw invalid();
  const epochs = new Map<number, ProfileContextKeyEpoch & { readonly key: Buffer }>();
  for (const input of snapshot.epochs) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid();
    const epoch = positiveSafeInteger(input.epoch);
    if (epochs.has(epoch)) throw invalid();
    const key = copyExactKey(input.key);
    if (safeBufferEqual(key, auditKey)) throw invalid();
    const activatedAtMs = nonNegativeSafeInteger(input.activatedAtMs);
    const resolveUntilMs = input.resolveUntilMs;
    if (epoch === activeEpoch) {
      if (resolveUntilMs !== undefined || activatedAtMs > nowMs + clockSkewMs) throw invalid();
    } else {
      if (epoch > activeEpoch || resolveUntilMs === undefined) throw invalid();
      const resolveUntil = positiveSafeInteger(resolveUntilMs);
      if (resolveUntil <= activatedAtMs) throw invalid();
    }
    epochs.set(epoch, Object.freeze({
      epoch,
      key,
      activatedAtMs,
      ...(resolveUntilMs === undefined ? {} : { resolveUntilMs })
    }));
  }
  const active = epochs.get(activeEpoch);
  if (active === undefined) throw invalid();
  for (const epoch of epochs.values()) {
    if (
      epoch.epoch !== activeEpoch &&
      (epoch.resolveUntilMs === undefined ||
        epoch.resolveUntilMs <= active.activatedAtMs ||
        epoch.resolveUntilMs > active.activatedAtMs + maximumLifetimeMs + clockSkewMs)
    ) {
      throw invalid();
    }
  }
  return Object.freeze({ activeEpoch, active, epochs });
}

function parseEnvelope(handle: unknown): {
  readonly epoch: number;
  readonly initializationVector: Buffer;
  readonly ciphertext: Buffer;
  readonly authenticationTag: Buffer;
} {
  try {
    if (typeof handle !== "string" || Buffer.byteLength(handle, "utf8") > maximumHandleBytes) throw invalid();
    const parts = handle.split(".");
    if (parts.length !== 5 || parts[0] !== handlePrefix || !decimalPattern.test(parts[1]!)) throw invalid();
    const epoch = positiveSafeInteger(Number(parts[1]));
    if (String(epoch) !== parts[1]) throw invalid();
    return Object.freeze({
      epoch,
      initializationVector: decodePart(parts[2], initializationVectorBytes),
      ciphertext: decodePart(parts[3]),
      authenticationTag: decodePart(parts[4], authenticationTagBytes)
    });
  } catch (error) {
    if (error instanceof ProfileContextHandleError) throw error;
    throw invalid();
  }
}

function parsePayload(value: unknown): ProfileContextPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const payload = value as Record<string, unknown>;
  const expectedKeys = [
    "binding",
    "deploymentId",
    "expiresAtMs",
    "id",
    "issuedAtMs",
    "keyEpoch",
    "profile",
    "version"
  ];
  const keys = Object.keys(payload).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw invalid();
  if (
    payload.version !== 1 ||
    typeof payload.id !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/u.test(payload.id) ||
    typeof payload.deploymentId !== "string" ||
    typeof payload.profile !== "string" ||
    typeof payload.binding !== "string" ||
    typeof payload.keyEpoch !== "number" ||
    typeof payload.issuedAtMs !== "number" ||
    typeof payload.expiresAtMs !== "number" ||
    !Number.isSafeInteger(payload.keyEpoch) ||
    !Number.isSafeInteger(payload.issuedAtMs) ||
    !Number.isSafeInteger(payload.expiresAtMs) ||
    payload.keyEpoch <= 0 ||
    payload.issuedAtMs < 0 ||
    payload.expiresAtMs <= payload.issuedAtMs
  ) {
    throw invalid();
  }
  boundedText(payload.deploymentId);
  boundedText(payload.profile);
  decodeAuthenticatedBinding(payload.binding);
  return Object.freeze(payload as unknown as ProfileContextPayload);
}

function authenticatedBinding(value: unknown, nowMs: number): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  let binding: unknown;
  let expiresAtMs: unknown;
  try {
    binding = (value as Partial<AuthenticatedRequestContext>).binding;
    expiresAtMs = (value as Partial<AuthenticatedRequestContext>).expiresAtMs;
  } catch {
    throw invalid();
  }
  decodeAuthenticatedBinding(binding);
  if (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs)) throw invalid();
  if (expiresAtMs <= nowMs) throw expired();
  return binding as string;
}

function decodeAuthenticatedBinding(value: unknown): Buffer {
  if (typeof value !== "string" || !/^mab1\.[A-Za-z0-9_-]{43}$/u.test(value)) throw invalid();
  const encoded = value.slice("mab1.".length);
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== encoded) throw invalid();
  return decoded;
}

function withoutHandle(value: MintedProfileContext): ResolvedProfileContext {
  return Object.freeze({
    profile: value.profile,
    auditCorrelation: value.auditCorrelation,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs
  });
}

function isRevocationStore(value: unknown): value is ProfileContextRevocationStore {
  if (typeof value !== "object" || value === null) return false;
  try {
    const store = value as Partial<ProfileContextRevocationStore>;
    return typeof store.isRevoked === "function" && typeof store.revoke === "function";
  } catch {
    return false;
  }
}

function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    throw invalid();
  }
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw invalid();
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > maximumTextBytes || Buffer.from(value, "utf8").toString("utf8") !== value) throw invalid();
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) throw invalid();
  }
  return value;
}

function copyExactKey(value: unknown): Buffer {
  try {
    if (!(value instanceof Uint8Array) || value.byteLength !== keyBytes) throw invalid();
    return Buffer.from(value);
  } catch {
    throw invalid();
  }
}

function copyRandomBytes(randomBytes: (size: number) => Uint8Array, size: number): Buffer {
  try {
    const value = randomBytes(size);
    if (!(value instanceof Uint8Array) || value.byteLength !== size) throw unavailable();
    return Buffer.from(value);
  } catch (error) {
    if (error instanceof ProfileContextHandleError) throw error;
    throw unavailable();
  }
}

function positiveSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw invalid();
  return value;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}

function internalIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(value)) throw invalid();
  return value;
}

function decodePart(value: unknown, exactBytes?: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || !base64UrlPattern.test(value)) throw invalid();
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length === 0 ||
    decoded.toString("base64url") !== value ||
    (exactBytes !== undefined && decoded.length !== exactBytes)
  ) {
    throw invalid();
  }
  return decoded;
}

function safeBufferEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeTextEqual(left: string, right: string): boolean {
  return safeBufferEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function lengthPrefixed(values: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const value of values) {
    const encoded = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.length);
    parts.push(length, encoded);
  }
  return Buffer.concat(parts);
}

function invalid(): ProfileContextHandleError {
  return new ProfileContextHandleError("PROFILE_CONTEXT_INVALID");
}

function expired(): ProfileContextHandleError {
  return new ProfileContextHandleError("PROFILE_CONTEXT_EXPIRED");
}

function unavailable(): ProfileContextHandleError {
  return new ProfileContextHandleError("PROFILE_CONTEXT_UNAVAILABLE");
}
