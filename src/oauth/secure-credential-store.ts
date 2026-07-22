import { connectionCredentialKey, type OAuthConnectionBinding } from "./connection-types.js";
import { SecretRedactor } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";

const keyringService = "miftah.oauth.v1";
const maximumCredentialBytes = 32 * 1_024;
const maximumSerializedCredentialBytes = maximumCredentialBytes * 2;
const credentialEnvelopeKeys = new Set(["version", "bindingKey", "accessToken", "refreshToken", "expiresAt"]);

/** Secret material that may exist only in the operating-system credential vault. */
export interface OAuthCredential {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
}

/** The minimal adapter required to bind credentials to an operating-system credential vault. */
export interface OAuthKeyringAdapter {
  getPassword(service: string, account: string): Promise<string | undefined>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
}

/** Persistence contract used by the OAuth lifecycle; it intentionally has no env, file, or plugin fallback. */
export interface OAuthCredentialStore {
  load(binding: OAuthConnectionBinding): Promise<OAuthCredential | undefined>;
  save(binding: OAuthConnectionBinding, credential: OAuthCredential): Promise<void>;
  delete(binding: OAuthConnectionBinding): Promise<void>;
}

interface StoredOAuthCredentialEnvelope extends OAuthCredential {
  readonly version: 1;
  readonly bindingKey: string;
}

function invalidCredential(): never {
  throw new MiftahError("OAUTH_CREDENTIAL_INVALID", "OAUTH_CREDENTIAL_INVALID: OAuth credential envelope is invalid");
}

function validExpiry(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateCredential(value: OAuthCredential): OAuthCredential {
  if (typeof value.accessToken !== "string" || value.accessToken.length === 0 || Buffer.byteLength(value.accessToken, "utf8") > maximumCredentialBytes) {
    invalidCredential();
  }
  if (
    value.refreshToken !== undefined &&
    (typeof value.refreshToken !== "string" || value.refreshToken.length === 0 || Buffer.byteLength(value.refreshToken, "utf8") > maximumCredentialBytes)
  ) {
    invalidCredential();
  }
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== "string" || !validExpiry(value.expiresAt))) {
    invalidCredential();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(serialized: string, redactor: SecretRedactor): StoredOAuthCredentialEnvelope {
  if (Buffer.byteLength(serialized, "utf8") > maximumSerializedCredentialBytes) invalidCredential();
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    invalidCredential();
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.bindingKey !== "string" ||
    !Object.hasOwn(value, "accessToken") ||
    Object.keys(value).some((key) => !credentialEnvelopeKeys.has(key)) ||
    (Object.hasOwn(value, "refreshToken") && typeof value.refreshToken !== "string") ||
    (Object.hasOwn(value, "expiresAt") && typeof value.expiresAt !== "string")
  ) {
    invalidCredential();
  }

  // Register any parsed values before a later binding or expiry check can emit an error.
  if (typeof value.accessToken === "string") redactor.add(value.accessToken);
  if (typeof value.refreshToken === "string") redactor.add(value.refreshToken);
  const credential = validateCredential({
    accessToken: value.accessToken as string,
    ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {})
  });
  return { version: 1, bindingKey: value.bindingKey, ...credential };
}

function serializeEnvelope(envelope: StoredOAuthCredentialEnvelope): string {
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, "utf8") > maximumSerializedCredentialBytes) invalidCredential();
  return serialized;
}

/** Real vault-backed store with exact tuple selection and no persistence fallback. */
export class PlatformOAuthCredentialStore implements OAuthCredentialStore {
  constructor(
    private readonly keyring: OAuthKeyringAdapter,
    private readonly redactor: SecretRedactor = new SecretRedactor()
  ) {}

  async load(binding: OAuthConnectionBinding): Promise<OAuthCredential | undefined> {
    const bindingKey = connectionCredentialKey(binding);
    const serialized = await this.vault(() => this.keyring.getPassword(keyringService, bindingKey));
    if (serialized === undefined) return undefined;
    const envelope = parseEnvelope(serialized, this.redactor);
    if (envelope.bindingKey !== bindingKey) invalidCredential();
    return {
      accessToken: envelope.accessToken,
      ...(envelope.refreshToken === undefined ? {} : { refreshToken: envelope.refreshToken }),
      ...(envelope.expiresAt === undefined ? {} : { expiresAt: envelope.expiresAt })
    };
  }

  async save(binding: OAuthConnectionBinding, credential: OAuthCredential): Promise<void> {
    const validated = validateCredential(credential);
    const bindingKey = connectionCredentialKey(binding);
    const envelope: StoredOAuthCredentialEnvelope = {
      version: 1,
      bindingKey,
      ...validated
    };
    const serialized = serializeEnvelope(envelope);
    this.registerSecrets(validated);
    await this.vault(() => this.keyring.setPassword(keyringService, bindingKey, serialized));
  }

  async delete(binding: OAuthConnectionBinding): Promise<void> {
    await this.vault(() => this.keyring.deletePassword(keyringService, connectionCredentialKey(binding)));
  }

  private registerSecrets(credential: OAuthCredential): void {
    this.redactor.add(credential.accessToken);
    if (credential.refreshToken !== undefined) this.redactor.add(credential.refreshToken);
  }

  private async vault<Value>(operation: () => Promise<Value>): Promise<Value> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MiftahError) throw error;
      throw new MiftahError(
        "OAUTH_SECURE_STORE_UNAVAILABLE",
        "OAUTH_SECURE_STORE_UNAVAILABLE: operating-system credential storage is unavailable"
      );
    }
  }
}

interface NativeKeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<unknown>;
}

interface NativeKeyringModule {
  AsyncEntry: new (service: string, account: string) => NativeKeyringEntry;
}

function isNativeKeyringModule(value: unknown): value is NativeKeyringModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "AsyncEntry" in value &&
    typeof value.AsyncEntry === "function"
  );
}

class NativeKeyringAdapter implements OAuthKeyringAdapter {
  constructor(private readonly keyring: NativeKeyringModule) {}

  async getPassword(service: string, account: string): Promise<string | undefined> {
    return new this.keyring.AsyncEntry(service, account).getPassword();
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    await new this.keyring.AsyncEntry(service, account).setPassword(password);
  }

  async deletePassword(service: string, account: string): Promise<void> {
    await new this.keyring.AsyncEntry(service, account).deletePassword();
  }
}

/**
 * Constructs the only production credential store. A missing native binding is an explicit
 * secure-store refusal; Miftah never substitutes a command, environment, file, or plugin store.
 */
export async function createPlatformOAuthCredentialStore(
  redactor: SecretRedactor = new SecretRedactor()
): Promise<PlatformOAuthCredentialStore> {
  let module: unknown;
  try {
    module = await import("@napi-rs/keyring");
  } catch {
    throw new MiftahError(
      "OAUTH_SECURE_STORE_UNAVAILABLE",
      "OAUTH_SECURE_STORE_UNAVAILABLE: operating-system credential storage is unavailable"
    );
  }
  if (!isNativeKeyringModule(module)) {
    throw new MiftahError(
      "OAUTH_SECURE_STORE_UNAVAILABLE",
      "OAUTH_SECURE_STORE_UNAVAILABLE: operating-system credential storage is unavailable"
    );
  }
  return new PlatformOAuthCredentialStore(new NativeKeyringAdapter(module), redactor);
}
