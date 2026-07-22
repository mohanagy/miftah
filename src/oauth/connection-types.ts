import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { canonicalizeOAuthResource } from "./canonical-resource.js";
import { MiftahError } from "../utils/errors.js";

const connectionReferencePattern = /^oauthconn:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const configIdentityPattern = /^[a-f0-9]{64}$/u;
const scopePattern = /^[\x21-\x7e]+$/u;

/** An opaque, generated connection identifier; it never encodes a provider, account, or credential. */
export type OAuthConnectionRef = `oauthconn:${string}`;

export type OAuthCredentialState =
  | "connected"
  | "expiring"
  | "expired"
  | "reauth-required"
  | "disconnected"
  | "unsupported";

/** Account evidence is deliberately distinct from OAuth credential validity. */
export type OAuthIdentityState = "verified" | "unverified" | "unknown" | "unsupported";

export interface OAuthConnectionBindingInput {
  readonly configIdentity: string;
  readonly connectionRef: OAuthConnectionRef | string;
  readonly profile: string;
  readonly upstream: string;
  readonly resource: string;
  /** An exact issuer identifier selected by later metadata discovery; it is never normalized. */
  readonly issuer: string;
  /** A non-secret registration identifier, never a client secret. */
  readonly clientRegistration: string;
  readonly scopes: readonly string[];
}

/** The exact non-secret tuple that owns a connection's secure-store credential envelope. */
export interface OAuthConnectionBinding {
  readonly version: 1;
  readonly configIdentity: string;
  readonly connectionRef: OAuthConnectionRef;
  readonly profile: string;
  readonly upstream: string;
  readonly canonicalResource: string;
  readonly issuer: string;
  readonly clientRegistration: string;
  readonly scopes: readonly string[];
}

function invalidConnection(): never {
  throw new MiftahError("OAUTH_CONNECTION_INVALID", "OAUTH_CONNECTION_INVALID: OAuth connection binding is invalid");
}

function hasWhitespaceOrControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code === undefined || code <= 0x20 || code === 0x7f;
  });
}

function assertIdentifier(value: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    hasWhitespaceOrControl(value)
  ) {
    invalidConnection();
  }
  return value;
}

/** Validates an issuer without normalizing it, so discovery can later require exact string equality. */
export function validateOAuthIssuer(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || value.trim() !== value || hasWhitespaceOrControl(value)) {
    invalidConnection();
  }
  if (!value.startsWith("https://") || value.includes("\\")) invalidConnection();
  const authorityAndPath = value.slice("https://".length);
  const authorityEnd = authorityAndPath.search(/[/?#]/u);
  const authority = authorityEnd < 0 ? authorityAndPath : authorityAndPath.slice(0, authorityEnd);
  if (authority.length === 0 || authority.includes("@")) invalidConnection();

  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    invalidConnection();
  }
  const bareOrigin = `https://${issuer.host}`;
  if (
    issuer.protocol !== "https:" ||
    issuer.hostname.length === 0 ||
    issuer.username.length > 0 ||
    issuer.password.length > 0 ||
    issuer.search.length > 0 ||
    issuer.hash.length > 0 ||
    (issuer.toString() !== value && bareOrigin !== value)
  ) {
    invalidConnection();
  }
  return value;
}

function canonicalScopes(scopes: readonly string[]): readonly string[] {
  if (!Array.isArray(scopes) || scopes.length > 64) invalidConnection();
  const normalized = scopes.map((scope) => {
    if (typeof scope !== "string" || scope.length === 0 || scope.length > 256 || !scopePattern.test(scope)) {
      invalidConnection();
    }
    return scope;
  });
  const sorted = normalized.sort((left, right) => left.localeCompare(right, "en", { sensitivity: "variant" }));
  if (new Set(sorted).size !== sorted.length) invalidConnection();
  return Object.freeze(sorted);
}

function lengthPrefixed(parts: readonly string[]): Buffer {
  const buffers = parts.map((part) => {
    const value = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  });
  return Buffer.concat(buffers);
}

/** Derives a non-reversible config identity, so metadata and vault keys never reveal a local path. */
export function createOAuthConfigIdentity(configPath: string): string {
  if (typeof configPath !== "string" || configPath.length === 0) invalidConnection();
  return createHash("sha256").update(resolve(configPath), "utf8").digest("hex");
}

/** Validates a generated opaque reference without putting its raw value into a diagnostic. */
export function parseOAuthConnectionRef(value: string): OAuthConnectionRef {
  if (typeof value !== "string" || !connectionReferencePattern.test(value)) invalidConnection();
  return value as OAuthConnectionRef;
}

/** Canonicalizes a connection's binding inputs before they can be used for storage selection. */
export function createOAuthConnectionBinding(input: OAuthConnectionBindingInput): OAuthConnectionBinding {
  if (!configIdentityPattern.test(input.configIdentity)) invalidConnection();
  return Object.freeze({
    version: 1,
    configIdentity: input.configIdentity,
    connectionRef: parseOAuthConnectionRef(input.connectionRef),
    profile: assertIdentifier(input.profile, 256),
    upstream: assertIdentifier(input.upstream, 256),
    canonicalResource: canonicalizeOAuthResource(input.resource),
    issuer: validateOAuthIssuer(input.issuer),
    clientRegistration: assertIdentifier(input.clientRegistration, 512),
    scopes: canonicalScopes(input.scopes)
  });
}

/** Generates an opaque OS-vault account key from an unambiguous versioned binding encoding. */
export function connectionCredentialKey(binding: OAuthConnectionBinding): string {
  const digest = createHash("sha256")
    .update(
      lengthPrefixed([
        "miftah.oauth.credential-key.v1",
        binding.configIdentity,
        binding.connectionRef,
        binding.profile,
        binding.upstream,
        binding.canonicalResource,
        binding.issuer,
        binding.clientRegistration,
        ...binding.scopes
      ])
    )
    .digest("base64url");
  return `v1-${digest}`;
}

/** Performs exact tuple comparison; partial profile/provider matching is intentionally impossible. */
export function sameOAuthConnectionBinding(left: OAuthConnectionBinding, right: OAuthConnectionBinding): boolean {
  return (
    left.version === right.version &&
    left.configIdentity === right.configIdentity &&
    left.connectionRef === right.connectionRef &&
    left.profile === right.profile &&
    left.upstream === right.upstream &&
    left.canonicalResource === right.canonicalResource &&
    left.issuer === right.issuer &&
    left.clientRegistration === right.clientRegistration &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => scope === right.scopes[index])
  );
}
