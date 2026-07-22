import {
  type OAuthClientProvider,
  type OAuthDiscoveryState
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomBytes } from "node:crypto";
import { canonicalizeOAuthResource } from "./canonical-resource.js";
import type { OAuthConnectionLifecycle } from "./connection-lifecycle.js";
import type { OAuthConnectionBinding } from "./connection-types.js";
import type { OAuthCredential } from "./secure-credential-store.js";
import { MiftahError } from "../utils/errors.js";
import { isSafeOAuthHttpsUrl } from "./url-safety.js";

const maximumTokenLifetimeSeconds = 365 * 24 * 60 * 60;

/** Browser/callback boundary used by the SDK provider without exposing authorization data. */
export interface OAuthAuthorizationHandoff {
  readonly redirectUrl: URL;
  authorize(
    authorizationUrl: URL,
    expected: { readonly state: string; readonly issuer: string }
  ): Promise<string>;
  close(): Promise<void>;
}

export interface RemoteOAuthClientProviderOptions {
  readonly binding: OAuthConnectionBinding;
  readonly lifecycle: OAuthConnectionLifecycle;
  readonly handoff: OAuthAuthorizationHandoff;
  readonly now?: () => Date;
  readonly state?: () => string;
  readonly issuerResponseSupported?: (issuer: string) => boolean;
}

type ClientRegistration =
  | { readonly kind: "pre-registered"; readonly clientId: string }
  | { readonly kind: "client-id-metadata"; readonly url: string }
  | { readonly kind: "dynamic" };

function discoveryUnsupported(): never {
  throw new MiftahError(
    "OAUTH_DISCOVERY_UNSUPPORTED",
    "OAUTH_DISCOVERY_UNSUPPORTED: OAuth discovery did not match the configured connection"
  );
}

function registrationUnsupported(): never {
  throw new MiftahError(
    "OAUTH_CLIENT_REGISTRATION_UNSUPPORTED",
    "OAUTH_CLIENT_REGISTRATION_UNSUPPORTED: OAuth client registration is not supported for this connection"
  );
}

function authorizationFailed(): never {
  throw new MiftahError(
    "OAUTH_AUTHORIZATION_FAILED",
    "OAUTH_AUTHORIZATION_FAILED: OAuth authorization could not be completed"
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseRegistration(value: string): ClientRegistration {
  if (value === "dynamic") return { kind: "dynamic" };
  if (value.startsWith("pre-registered:")) {
    const clientId = value.slice("pre-registered:".length);
    if (clientId.length === 0 || clientId.length > 512 || hasControlCharacter(clientId)) {
      registrationUnsupported();
    }
    return { kind: "pre-registered", clientId };
  }
  if (value.startsWith("client-id-metadata:")) {
    const url = value.slice("client-id-metadata:".length);
    if (!isSafeOAuthHttpsUrl(url, { requirePath: true, allowSearch: false })) registrationUnsupported();
    return { kind: "client-id-metadata", url };
  }
  registrationUnsupported();
}

/** Validates SDK discovery output against the exact non-secret connection tuple. */
export function assertRemoteOAuthDiscovery(
  binding: OAuthConnectionBinding,
  state: OAuthDiscoveryState,
  issuerResponseSupported: (issuer: string) => boolean = () => false
): void {
  const registration = parseRegistration(binding.clientRegistration);
  const resourceMetadata = state.resourceMetadata;
  const metadata = state.authorizationServerMetadata;
  const extraMetadata = metadata as (typeof metadata & Record<string, unknown>) | undefined;
  if (
    state.authorizationServerUrl !== binding.issuer ||
    resourceMetadata === undefined ||
    resourceMetadata.resource !== binding.canonicalResource ||
    !resourceMetadata.authorization_servers?.includes(binding.issuer) ||
    metadata === undefined ||
    metadata.issuer !== binding.issuer ||
    !metadata.response_types_supported.includes("code") ||
    !metadata.code_challenge_methods_supported?.includes("S256") ||
    (extraMetadata?.authorization_response_iss_parameter_supported !== true &&
      !issuerResponseSupported(binding.issuer)) ||
    !isSafeOAuthHttpsUrl(metadata.authorization_endpoint) ||
    !isSafeOAuthHttpsUrl(metadata.token_endpoint) ||
    (state.resourceMetadataUrl !== undefined && !isSafeOAuthHttpsUrl(state.resourceMetadataUrl)) ||
    (registration.kind === "dynamic" &&
      (metadata.registration_endpoint === undefined || !isSafeOAuthHttpsUrl(metadata.registration_endpoint))) ||
    (registration.kind === "client-id-metadata" && metadata.client_id_metadata_document_supported !== true)
  ) {
    discoveryUnsupported();
  }
}

/** Resolves only the client registration already bound to this exact connection. */
export function remoteOAuthClientInformation(
  binding: OAuthConnectionBinding,
  credential?: OAuthCredential
): OAuthClientInformationMixed {
  const registration = parseRegistration(binding.clientRegistration);
  if (registration.kind === "pre-registered") return { client_id: registration.clientId };
  if (registration.kind === "client-id-metadata") return { client_id: registration.url };
  if (credential?.clientId === undefined) registrationUnsupported();
  return {
    client_id: credential.clientId,
    ...(credential.clientSecret === undefined ? {} : { client_secret: credential.clientSecret })
  };
}

function cloneClientInformation(value: OAuthClientInformationMixed): OAuthClientInformationMixed {
  return structuredClone(value);
}

function scopes(value: string | null | undefined): readonly string[] {
  return value?.split(/\s+/u).filter((scope) => scope.length > 0) ?? [];
}

function singleParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function exactScopes(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((scope, index) => scope === expected[index]);
}

/**
 * Adapts one exact Miftah OAuth binding to the MCP SDK. Discovery, registration, tokens, and
 * browser state are instance-scoped, so a provider can never select another active profile.
 */
export class RemoteOAuthClientProvider implements OAuthClientProvider {
  readonly redirectUrl: URL;
  private readonly registration: ClientRegistration;
  private readonly transactionState: string;
  private readonly now: () => Date;
  private savedClient?: OAuthClientInformationMixed;
  private savedVerifier?: string;
  private savedDiscovery?: OAuthDiscoveryState;
  private authorization?: Promise<string>;

  constructor(private readonly options: RemoteOAuthClientProviderOptions) {
    this.registration = parseRegistration(options.binding.clientRegistration);
    this.redirectUrl = new URL(options.handoff.redirectUrl);
    if (
      this.redirectUrl.protocol !== "http:" ||
      this.redirectUrl.hostname !== "127.0.0.1" ||
      this.redirectUrl.username.length > 0 ||
      this.redirectUrl.password.length > 0 ||
      this.redirectUrl.search.length > 0 ||
      this.redirectUrl.hash.length > 0
    ) {
      authorizationFailed();
    }
    this.transactionState = options.state?.() ?? randomBytes(32).toString("base64url");
    if (this.transactionState.length < 32 || this.transactionState.length > 256) authorizationFailed();
    this.now = options.now ?? (() => new Date());
  }

  get clientMetadataUrl(): string | undefined {
    return this.registration.kind === "client-id-metadata" ? this.registration.url : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Miftah",
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: this.options.binding.scopes.join(" ")
    };
  }

  state(): string {
    return this.transactionState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.savedClient !== undefined) return cloneClientInformation(this.savedClient);
    if (this.registration.kind === "pre-registered") {
      return { client_id: this.registration.clientId };
    }
    if (this.registration.kind === "client-id-metadata") {
      return { client_id: this.registration.url };
    }
    return undefined;
  }

  saveClientInformation(value: OAuthClientInformationMixed): void {
    if (this.registration.kind !== "dynamic" && value.client_id !== this.clientMetadataUrl) {
      registrationUnsupported();
    }
    if (typeof value.client_id !== "string" || value.client_id.length === 0 || value.client_id.length > 2_048) {
      registrationUnsupported();
    }
    this.savedClient = cloneClientInformation(value);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    let credential: OAuthCredential;
    try {
      credential = await this.options.lifecycle.credential(this.options.binding);
    } catch (error) {
      if (error instanceof MiftahError && (error.code === "OAUTH_REAUTH_REQUIRED" || error.code === "OAUTH_CONNECTION_NOT_FOUND")) {
        return undefined;
      }
      throw error;
    }
    if (credential.clientId !== undefined) {
      this.savedClient = {
        client_id: credential.clientId,
        ...(credential.clientSecret === undefined ? {} : { client_secret: credential.clientSecret })
      };
    }
    const expiresIn = credential.expiresAt === undefined
      ? undefined
      : Math.max(0, Math.ceil((Date.parse(credential.expiresAt) - this.currentTime()) / 1_000));
    const grantedScopes = credential.scopes ?? this.options.binding.scopes;
    return {
      access_token: credential.accessToken,
      token_type: "Bearer",
      ...(credential.refreshToken === undefined ? {} : { refresh_token: credential.refreshToken }),
      ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
      ...(grantedScopes.length === 0 ? {} : { scope: grantedScopes.join(" ") })
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (tokens.token_type.toLowerCase() !== "bearer" || tokens.access_token.length === 0) authorizationFailed();
    const grantedScopes = tokens.scope === undefined ? this.options.binding.scopes : scopes(tokens.scope);
    if (
      new Set(grantedScopes).size !== grantedScopes.length ||
      grantedScopes.some((scope) => !this.options.binding.scopes.includes(scope))
    ) authorizationFailed();
    let expiresAt: string | undefined;
    if (tokens.expires_in !== undefined) {
      if (!Number.isFinite(tokens.expires_in) || tokens.expires_in < 0 || tokens.expires_in > maximumTokenLifetimeSeconds) {
        authorizationFailed();
      }
      expiresAt = new Date(this.currentTime() + Math.floor(tokens.expires_in * 1_000)).toISOString();
    }
    const clientInformation = await this.clientInformation();
    if (this.registration.kind === "dynamic" && clientInformation === undefined) registrationUnsupported();
    await this.options.lifecycle.connect(this.options.binding, {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      scopes: [...grantedScopes],
      ...(this.registration.kind !== "dynamic" || clientInformation === undefined
        ? {}
        : {
            clientId: clientInformation.client_id,
            ...(clientInformation.client_secret === undefined ? {} : { clientSecret: clientInformation.client_secret })
          })
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const metadata = this.savedDiscovery?.authorizationServerMetadata;
    if (metadata === undefined) discoveryUnsupported();
    const expectedAuthorizationEndpoint = new URL(metadata.authorization_endpoint).toString();
    const actualEndpoint = new URL(authorizationUrl);
    actualEndpoint.search = "";
    actualEndpoint.hash = "";
    const codeChallenge = singleParameter(authorizationUrl, "code_challenge");
    if (
      actualEndpoint.toString() !== expectedAuthorizationEndpoint ||
      singleParameter(authorizationUrl, "response_type") !== "code" ||
      singleParameter(authorizationUrl, "state") !== this.transactionState ||
      singleParameter(authorizationUrl, "redirect_uri") !== this.redirectUrl.toString() ||
      singleParameter(authorizationUrl, "resource") !== this.options.binding.canonicalResource ||
      singleParameter(authorizationUrl, "code_challenge_method") !== "S256" ||
      codeChallenge === undefined ||
      !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge) ||
      !exactScopes(scopes(singleParameter(authorizationUrl, "scope")), this.options.binding.scopes)
    ) {
      authorizationFailed();
    }
    if (this.authorization !== undefined) authorizationFailed();
    this.authorization = this.options.handoff.authorize(new URL(authorizationUrl), {
      state: this.transactionState,
      issuer: this.options.binding.issuer
    });
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (typeof codeVerifier !== "string" || codeVerifier.length < 43 || codeVerifier.length > 128) authorizationFailed();
    this.savedVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.savedVerifier === undefined) authorizationFailed();
    return this.savedVerifier;
  }

  async waitForAuthorizationCode(): Promise<string> {
    if (this.authorization === undefined) authorizationFailed();
    const code = await this.authorization;
    if (typeof code !== "string" || code.length === 0 || code.length > 4_096) authorizationFailed();
    return code;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    assertRemoteOAuthDiscovery(
      this.options.binding,
      state,
      this.options.issuerResponseSupported
    );
    this.savedDiscovery = structuredClone(state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.savedDiscovery === undefined ? undefined : structuredClone(this.savedDiscovery);
  }

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL> {
    let canonicalServer: string;
    try {
      canonicalServer = canonicalizeOAuthResource(String(serverUrl));
    } catch {
      discoveryUnsupported();
    }
    if (
      canonicalServer !== this.options.binding.canonicalResource ||
      resource === undefined ||
      resource !== this.options.binding.canonicalResource
    ) {
      discoveryUnsupported();
    }
    return new URL(this.options.binding.canonicalResource);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") this.savedClient = undefined;
    if (scope === "all" || scope === "verifier") this.savedVerifier = undefined;
    if (scope === "all" || scope === "discovery") this.savedDiscovery = undefined;
    if (scope === "all" || scope === "tokens") {
      try {
        await this.options.lifecycle.disconnect(this.options.binding);
      } catch (error) {
        if (!(error instanceof MiftahError) || error.code !== "OAUTH_CONNECTION_NOT_FOUND") throw error;
      }
    }
  }

  close(): Promise<void> {
    return this.options.handoff.close();
  }

  private currentTime(): number {
    const date = this.now();
    const value = date instanceof Date ? date.getTime() : Number.NaN;
    if (!Number.isFinite(value)) authorizationFailed();
    return value;
  }
}
