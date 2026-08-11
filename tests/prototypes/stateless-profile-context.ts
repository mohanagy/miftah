import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const handlePrefix = "mctx1";
const maximumHandleLength = 4_096;
const maximumLifetimeMs = 15 * 60_000;
const initializationVectorBytes = 12;
const authenticationTagBytes = 16;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

export interface AuthenticatedProfileContext {
  /** Verified authorization-server issuer, never a client-supplied MCP metadata value. */
  readonly issuer: string;
  /** Verified subject for the authenticated human or workload. */
  readonly subject: string;
  /** Verified audience for this Miftah deployment. */
  readonly audience: string;
  /** Unforgeable per-chat/request-context claim supplied by the authenticating host. */
  readonly contextId: string;
}

interface ProfileContextPayload {
  readonly version: 1;
  readonly id: string;
  readonly deploymentId: string;
  readonly profile: string;
  readonly binding: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export type StatelessProfileContextErrorCode =
  | "PROFILE_CONTEXT_EXPIRED"
  | "PROFILE_CONTEXT_INVALID"
  | "PROFILE_CONTEXT_REVOKED";

/** Fixed, non-sensitive failure returned by the executable design prototype. */
export class StatelessProfileContextError extends Error {
  constructor(readonly code: StatelessProfileContextErrorCode, message: string) {
    super(message);
    this.name = "StatelessProfileContextError";
  }
}

export interface ProfileContextRevocations {
  isRevoked(id: string, atMs: number): boolean;
  revoke(id: string, expiresAtMs: number): void;
}

/** Models the deployment-wide revocation backend required for immediate cross-instance revocation. */
export class InMemoryProfileContextRevocations implements ProfileContextRevocations {
  private readonly expirations = new Map<string, number>();

  isRevoked(id: string, atMs: number): boolean {
    const expiresAtMs = this.expirations.get(id);
    if (expiresAtMs === undefined) return false;
    if (expiresAtMs <= atMs) {
      this.expirations.delete(id);
      return false;
    }
    return true;
  }

  revoke(id: string, expiresAtMs: number): void {
    this.expirations.set(id, expiresAtMs);
  }
}

export interface StatelessProfileContextPrototypeOptions {
  readonly deploymentId: string;
  readonly profiles: readonly string[];
  readonly encryptionKey: Buffer;
  readonly bindingKey: Buffer;
  readonly auditKey: Buffer;
  readonly revocations: ProfileContextRevocations;
  readonly now?: () => Date;
}

export interface ResolvedProfileContext {
  readonly profile: string;
  /** Safe correlation derived from the internal identifier, never from the bearer itself. */
  readonly auditCorrelation: string;
  readonly expiresAt: string;
}

/**
 * Non-shipping executable model for an explicit, authenticated, cross-instance profile handle.
 * It deliberately has no mutable active-profile state.
 */
export class StatelessProfileContextPrototype {
  private readonly deploymentId: string;
  private readonly profiles: ReadonlySet<string>;
  private readonly encryptionKey: Buffer;
  private readonly bindingKey: Buffer;
  private readonly auditKey: Buffer;
  private readonly revocations: ProfileContextRevocations;
  private readonly now: () => Date;

  constructor(options: StatelessProfileContextPrototypeOptions) {
    assertBoundedValue(options.deploymentId, "deployment ID");
    if (options.profiles.length === 0 || new Set(options.profiles).size !== options.profiles.length) {
      throw new Error("Profiles must be a non-empty unique collection.");
    }
    for (const profile of options.profiles) assertBoundedValue(profile, "profile");
    assertKey(options.encryptionKey, "Encryption");
    assertKey(options.bindingKey, "Binding");
    assertKey(options.auditKey, "Audit");
    this.deploymentId = options.deploymentId;
    this.profiles = new Set(options.profiles);
    this.encryptionKey = Buffer.from(options.encryptionKey);
    this.bindingKey = Buffer.from(options.bindingKey);
    this.auditKey = Buffer.from(options.auditKey);
    this.revocations = options.revocations;
    this.now = options.now ?? (() => new Date());
  }

  mint(profile: string, authenticated: AuthenticatedProfileContext, lifetimeMs: number): string {
    if (!this.profiles.has(profile)) throw invalidContext();
    assertAuthenticatedContext(authenticated);
    if (!Number.isInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > maximumLifetimeMs) {
      throw new Error("Profile context lifetime must be a positive integer no greater than 15 minutes.");
    }
    const issuedAtMs = this.nowMs();
    const payload: ProfileContextPayload = {
      version: 1,
      id: randomBytes(16).toString("base64url"),
      deploymentId: this.deploymentId,
      profile,
      binding: this.binding(authenticated),
      issuedAtMs,
      expiresAtMs: issuedAtMs + lifetimeMs
    };
    return this.seal(payload);
  }

  resolve(handle: string, authenticated: AuthenticatedProfileContext): ResolvedProfileContext {
    const payload = this.resolvePayload(handle, authenticated);
    return {
      profile: payload.profile,
      auditCorrelation: this.auditCorrelation(payload.id),
      expiresAt: new Date(payload.expiresAtMs).toISOString()
    };
  }

  revoke(handle: string, authenticated: AuthenticatedProfileContext): void {
    const payload = this.resolvePayload(handle, authenticated);
    this.revocations.revoke(payload.id, payload.expiresAtMs);
  }

  private resolvePayload(handle: string, authenticated: AuthenticatedProfileContext): ProfileContextPayload {
    assertAuthenticatedContext(authenticated);
    const payload = this.open(handle);
    if (
      payload.deploymentId !== this.deploymentId ||
      !this.profiles.has(payload.profile) ||
      !safeEqual(payload.binding, this.binding(authenticated))
    ) {
      throw invalidContext();
    }
    const nowMs = this.nowMs();
    if (payload.expiresAtMs <= nowMs) {
      throw new StatelessProfileContextError("PROFILE_CONTEXT_EXPIRED", "Profile context has expired.");
    }
    if (this.revocations.isRevoked(payload.id, nowMs)) {
      throw new StatelessProfileContextError("PROFILE_CONTEXT_REVOKED", "Profile context has been revoked.");
    }
    return payload;
  }

  private seal(payload: ProfileContextPayload): string {
    const initializationVector = randomBytes(initializationVectorBytes);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, initializationVector, {
      authTagLength: authenticationTagBytes
    });
    cipher.setAAD(this.additionalAuthenticatedData());
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    return [
      handlePrefix,
      initializationVector.toString("base64url"),
      ciphertext.toString("base64url"),
      authenticationTag.toString("base64url")
    ].join(".");
  }

  private open(handle: string): ProfileContextPayload {
    try {
      if (handle.length === 0 || handle.length > maximumHandleLength) throw invalidContext();
      const parts = handle.split(".");
      if (parts.length !== 4 || parts[0] !== handlePrefix) throw invalidContext();
      const initializationVector = decodePart(parts[1]!, initializationVectorBytes);
      const ciphertext = decodePart(parts[2]!);
      const authenticationTag = decodePart(parts[3]!, authenticationTagBytes);
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, initializationVector, {
        authTagLength: authenticationTagBytes
      });
      decipher.setAAD(this.additionalAuthenticatedData());
      decipher.setAuthTag(authenticationTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      return parsePayload(JSON.parse(plaintext) as unknown);
    } catch (error) {
      if (error instanceof StatelessProfileContextError) throw error;
      throw invalidContext();
    }
  }

  private binding(authenticated: AuthenticatedProfileContext): string {
    return createHmac("sha256", this.bindingKey)
      .update(lengthPrefixed([
        authenticated.issuer,
        authenticated.subject,
        authenticated.audience,
        authenticated.contextId
      ]))
      .digest("base64url");
  }

  private auditCorrelation(id: string): string {
    return `mctx_${createHmac("sha256", this.auditKey).update(id).digest("hex").slice(0, 16)}`;
  }

  private additionalAuthenticatedData(): Buffer {
    return Buffer.from(`miftah-profile-context\u0000${this.deploymentId}\u0000v1`, "utf8");
  }

  private nowMs(): number {
    const value = this.now().getTime();
    if (!Number.isFinite(value)) throw new Error("Prototype clock returned an invalid time.");
    return value;
  }
}

function parsePayload(value: unknown): ProfileContextPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidContext();
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  const expectedKeys = [
    "binding",
    "deploymentId",
    "expiresAtMs",
    "id",
    "issuedAtMs",
    "profile",
    "version"
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw invalidContext();
  }
  if (
    payload.version !== 1 ||
    typeof payload.id !== "string" ||
    typeof payload.deploymentId !== "string" ||
    typeof payload.profile !== "string" ||
    typeof payload.binding !== "string" ||
    typeof payload.issuedAtMs !== "number" ||
    typeof payload.expiresAtMs !== "number" ||
    !Number.isSafeInteger(payload.issuedAtMs) ||
    !Number.isSafeInteger(payload.expiresAtMs) ||
    payload.expiresAtMs <= payload.issuedAtMs
  ) {
    throw invalidContext();
  }
  return payload as unknown as ProfileContextPayload;
}

function assertAuthenticatedContext(authenticated: AuthenticatedProfileContext): void {
  assertBoundedValue(authenticated.issuer, "authenticated issuer");
  assertBoundedValue(authenticated.subject, "authenticated subject");
  assertBoundedValue(authenticated.audience, "authenticated audience");
  assertBoundedValue(authenticated.contextId, "authenticated context ID");
}

function assertBoundedValue(value: string, label: string): void {
  if (value.length === 0 || value.length > 1_024 || hasControlCharacter(value)) {
    throw new Error(`${label} must be a bounded printable value.`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function assertKey(key: Buffer, label: string): void {
  if (key.length !== 32) throw new Error(`${label} key must contain exactly 32 bytes.`);
}

function decodePart(value: string, exactBytes?: number): Buffer {
  if (value.length === 0 || !base64UrlPattern.test(value)) throw invalidContext();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || (exactBytes !== undefined && decoded.length !== exactBytes)) throw invalidContext();
  return decoded;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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

function invalidContext(): StatelessProfileContextError {
  return new StatelessProfileContextError("PROFILE_CONTEXT_INVALID", "Profile context is invalid.");
}
