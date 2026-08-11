import { createHmac, timingSafeEqual } from "node:crypto";

const bindingPrefix = "mab1.";
const auditCorrelationPrefix = "mac1.";
const minimumKeyBytes = 32;
const maximumKeyBytes = 4_096;
const maximumClaimBytes = 4_096;

/** Fixed, non-sensitive failures emitted by the authenticated request-context boundary. */
export type AuthenticatedRequestContextErrorCode =
  | "AUTH_CONTEXT_UNAVAILABLE"
  | "AUTH_CONTEXT_INVALID"
  | "AUTH_CONTEXT_EXPIRED"
  | "AUTH_CONTEXT_MISMATCH";

const authenticatedRequestContextErrorCodes = new Set<AuthenticatedRequestContextErrorCode>([
  "AUTH_CONTEXT_UNAVAILABLE",
  "AUTH_CONTEXT_INVALID",
  "AUTH_CONTEXT_EXPIRED",
  "AUTH_CONTEXT_MISMATCH"
]);

/** A safe error that never carries claims, requests, provider failures, or key material. */
export class AuthenticatedRequestContextError extends Error {
  readonly code: AuthenticatedRequestContextErrorCode;

  constructor(code: AuthenticatedRequestContextErrorCode) {
    const safeCode = authenticatedRequestContextErrorCodes.has(code) ? code : "AUTH_CONTEXT_INVALID";
    super(safeCode);
    Object.defineProperty(this, "name", { value: "AuthenticatedRequestContextError", configurable: true });
    this.code = safeCode;
  }
}

/**
 * Claims returned only after an embedding host has authenticated its request.
 *
 * Miftah does not derive these values from MCP clientInfo, arbitrary headers,
 * tool arguments, request metadata, or a model-provided conversation ID.
 */
export interface VerifiedHttpRequestClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
  readonly chatContext: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

/** Supplies claims from an authentication verifier owned by the embedding host. */
export type VerifiedHttpRequestClaimsProvider<Request> = (
  request: Request
) => VerifiedHttpRequestClaims | undefined | Promise<VerifiedHttpRequestClaims | undefined>;

/** Opaque request context safe to pass into routing and audit boundaries. */
export interface AuthenticatedRequestContext {
  /** Keyed issuer, subject, audience, chat, and deployment binding. */
  readonly binding: string;
  /** Separately keyed, non-sensitive audit correlation. */
  readonly auditCorrelation: string;
  /** Exact expiry inherited from the verified host assertion. */
  readonly expiresAtMs: number;
}

/** A deployment-scoped boundary used before stateless account-sensitive work. */
export interface AuthenticatedRequestContextBoundary<Request> {
  resolve(request: Request): Promise<AuthenticatedRequestContext>;
  assertBinding(expectedBinding: string, current: AuthenticatedRequestContext): void;
}

/** Inputs supplied by a trusted embedding host and deployment key manager. */
export interface AuthenticatedRequestContextBoundaryOptions<Request> {
  readonly deploymentId: string;
  readonly bindingKey: Uint8Array;
  readonly auditKey: Uint8Array;
  readonly verifiedClaimsProvider: VerifiedHttpRequestClaimsProvider<Request>;
  readonly clock?: () => number;
}

function invalid(): AuthenticatedRequestContextError {
  return new AuthenticatedRequestContextError("AUTH_CONTEXT_INVALID");
}

function unavailable(): AuthenticatedRequestContextError {
  return new AuthenticatedRequestContextError("AUTH_CONTEXT_UNAVAILABLE");
}

function isBoundedString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > maximumClaimBytes) return false;
  if (Buffer.from(value, "utf8").toString("utf8") !== value) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
}

function copyKey(value: Uint8Array): Buffer {
  try {
    if (!(value instanceof Uint8Array) || value.byteLength < minimumKeyBytes || value.byteLength > maximumKeyBytes) {
      throw invalid();
    }
    return Buffer.from(value);
  } catch {
    throw invalid();
  }
}

function areEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function updateSegment(hmac: ReturnType<typeof createHmac>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hmac.update(length);
  hmac.update(bytes);
}

function parseClaims(value: unknown, nowMs: number): VerifiedHttpRequestClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const claims = value as Partial<VerifiedHttpRequestClaims>;
  let issuer: unknown;
  let subject: unknown;
  let audience: unknown;
  let chatContext: unknown;
  let issuedAtMs: unknown;
  let expiresAtMs: unknown;
  try {
    issuer = claims.issuer;
    subject = claims.subject;
    audience = claims.audience;
    chatContext = claims.chatContext;
    issuedAtMs = claims.issuedAtMs;
    expiresAtMs = claims.expiresAtMs;
  } catch {
    throw invalid();
  }
  if (
    !isBoundedString(issuer) ||
    !isBoundedString(subject) ||
    !isBoundedString(audience) ||
    !isBoundedString(chatContext) ||
    typeof issuedAtMs !== "number" ||
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(issuedAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    issuedAtMs < 0 ||
    expiresAtMs <= issuedAtMs ||
    issuedAtMs > nowMs
  ) {
    throw invalid();
  }
  if (expiresAtMs <= nowMs) {
    throw new AuthenticatedRequestContextError("AUTH_CONTEXT_EXPIRED");
  }
  return Object.freeze({ issuer, subject, audience, chatContext, issuedAtMs, expiresAtMs });
}

function decodeBinding(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !value.startsWith(bindingPrefix)) return undefined;
  const encoded = value.slice(bindingPrefix.length);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== encoded) return undefined;
  return decoded;
}

/**
 * Creates a deterministic cross-instance binding from host-verified claims.
 *
 * The keys must be deployment-shared, distinct, and managed outside request
 * data. The result selects context only; it is not an authorization credential.
 */
export function createAuthenticatedRequestContextBoundary<Request>(
  options: AuthenticatedRequestContextBoundaryOptions<Request>
): AuthenticatedRequestContextBoundary<Request> {
  if (typeof options !== "object" || options === null) throw invalid();
  let deploymentId: unknown;
  let verifiedClaimsProvider: unknown;
  let bindingKeyInput: unknown;
  let auditKeyInput: unknown;
  let clockInput: unknown;
  try {
    deploymentId = options.deploymentId;
    verifiedClaimsProvider = options.verifiedClaimsProvider;
    bindingKeyInput = options.bindingKey;
    auditKeyInput = options.auditKey;
    clockInput = options.clock;
  } catch {
    throw invalid();
  }
  if (!isBoundedString(deploymentId) || typeof verifiedClaimsProvider !== "function") {
    throw invalid();
  }
  const bindingKey = copyKey(bindingKeyInput as Uint8Array);
  const auditKey = copyKey(auditKeyInput as Uint8Array);
  if (areEqual(bindingKey, auditKey)) throw invalid();
  const clock = clockInput ?? Date.now;
  if (typeof clock !== "function") throw invalid();

  return {
    async resolve(request): Promise<AuthenticatedRequestContext> {
      let claims: VerifiedHttpRequestClaims | undefined;
      try {
        claims = await (verifiedClaimsProvider as VerifiedHttpRequestClaimsProvider<Request>)(request);
      } catch {
        throw unavailable();
      }
      if (claims === undefined) throw unavailable();

      let currentTime: number;
      try {
        currentTime = clock();
      } catch {
        throw unavailable();
      }
      if (!Number.isSafeInteger(currentTime)) throw invalid();
      claims = parseClaims(claims, currentTime);

      const bindingHmac = createHmac("sha256", bindingKey);
      updateSegment(bindingHmac, "miftah-authenticated-request-context-v1");
      updateSegment(bindingHmac, deploymentId);
      updateSegment(bindingHmac, claims.issuer);
      updateSegment(bindingHmac, claims.subject);
      updateSegment(bindingHmac, claims.audience);
      updateSegment(bindingHmac, claims.chatContext);
      const bindingDigest = bindingHmac.digest();
      const binding = `${bindingPrefix}${bindingDigest.toString("base64url")}`;

      const auditHmac = createHmac("sha256", auditKey);
      updateSegment(auditHmac, "miftah-authenticated-request-audit-v1");
      auditHmac.update(bindingDigest);
      const auditCorrelation = `${auditCorrelationPrefix}${auditHmac.digest().subarray(0, 16).toString("base64url")}`;

      return Object.freeze({ binding, auditCorrelation, expiresAtMs: claims.expiresAtMs });
    },

    assertBinding(expectedBinding, current): void {
      const expected = decodeBinding(expectedBinding);
      let actual: Buffer | undefined;
      try {
        actual = decodeBinding((current as unknown as { readonly binding?: unknown } | undefined)?.binding);
      } catch {
        actual = undefined;
      }
      if (expected === undefined || actual === undefined || !areEqual(expected, actual)) {
        throw new AuthenticatedRequestContextError("AUTH_CONTEXT_MISMATCH");
      }
    }
  };
}

/** Requires a configured trusted host boundary without attempting any fallback identity source. */
export async function requireAuthenticatedRequestContext<Request>(
  boundary: AuthenticatedRequestContextBoundary<Request> | undefined,
  request: Request
): Promise<AuthenticatedRequestContext> {
  if (boundary === undefined) throw unavailable();
  return boundary.resolve(request);
}
