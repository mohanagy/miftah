import {
  discoverOAuthServerInfo,
  refreshAuthorization,
  type OAuthDiscoveryState
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthCredentialRefresher } from "./connection-lifecycle.js";
import type { OAuthConnectionBinding } from "./connection-types.js";
import type { OAuthCredential } from "./secure-credential-store.js";
import {
  assertRemoteOAuthDiscovery,
  remoteOAuthClientInformation
} from "./remote-oauth-client-provider.js";
import { MiftahError } from "../utils/errors.js";
import { OAuthMetadataFetchGuard } from "./oauth-metadata-fetch-guard.js";

const maximumTokenLifetimeSeconds = 365 * 24 * 60 * 60;

export interface RemoteOAuthCredentialRefresherOptions {
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly issuerResponseSupported?: (issuer: string) => boolean;
}

function reauthenticationRequired(): never {
  throw new MiftahError("OAUTH_REAUTH_REQUIRED", "OAUTH_REAUTH_REQUIRED: OAuth connection requires reauthentication");
}

function currentTime(now: () => Date): number {
  const date = now();
  const value = date instanceof Date ? date.getTime() : Number.NaN;
  if (!Number.isFinite(value)) reauthenticationRequired();
  return value;
}

function refreshedCredential(
  binding: OAuthConnectionBinding,
  previous: OAuthCredential,
  tokens: OAuthTokens,
  now: () => Date
): OAuthCredential {
  if (tokens.token_type.toLowerCase() !== "bearer" || tokens.access_token.length === 0) reauthenticationRequired();
  const grantedScopes = tokens.scope?.split(/\s+/u).filter((scope) => scope.length > 0) ?? [];
  if (grantedScopes.some((scope) => !binding.scopes.includes(scope))) reauthenticationRequired();
  let expiresAt: string | undefined;
  if (tokens.expires_in !== undefined) {
    if (!Number.isFinite(tokens.expires_in) || tokens.expires_in < 0 || tokens.expires_in > maximumTokenLifetimeSeconds) {
      reauthenticationRequired();
    }
    expiresAt = new Date(currentTime(now) + Math.floor(tokens.expires_in * 1_000)).toISOString();
  }
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token === undefined && previous.refreshToken !== undefined
      ? { refreshToken: previous.refreshToken }
      : tokens.refresh_token === undefined
        ? {}
        : { refreshToken: tokens.refresh_token }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(previous.clientId === undefined ? {} : { clientId: previous.clientId }),
    ...(previous.clientSecret === undefined ? {} : { clientSecret: previous.clientSecret })
  };
}

/** Refreshes one exact connection after revalidating its resource and authorization server metadata. */
export class RemoteOAuthCredentialRefresher implements OAuthCredentialRefresher {
  private readonly now: () => Date;
  private readonly fetch: FetchLike;
  private readonly issuerResponseSupported: (issuer: string) => boolean;

  constructor(private readonly options: RemoteOAuthCredentialRefresherOptions = {}) {
    this.now = options.now ?? (() => new Date());
    if (options.issuerResponseSupported === undefined) {
      const guard = new OAuthMetadataFetchGuard(options.fetch);
      this.fetch = guard.fetch;
      this.issuerResponseSupported = (issuer) => guard.issuerResponseSupported(issuer);
    } else {
      this.fetch = options.fetch ?? globalThis.fetch;
      this.issuerResponseSupported = options.issuerResponseSupported;
    }
  }

  async refresh(
    binding: OAuthConnectionBinding,
    credential: OAuthCredential,
    signal: AbortSignal
  ): Promise<OAuthCredential> {
    if (signal.aborted || credential.refreshToken === undefined) reauthenticationRequired();
    const fetchFn: FetchLike = async (input, init) => {
      if (signal.aborted) reauthenticationRequired();
      return this.fetch(input, { ...init, signal });
    };
    const server = await discoverOAuthServerInfo(binding.canonicalResource, { fetchFn });
    if (signal.aborted) reauthenticationRequired();
    const discovery: OAuthDiscoveryState = {
      authorizationServerUrl: server.authorizationServerUrl,
      resourceMetadata: server.resourceMetadata,
      authorizationServerMetadata: server.authorizationServerMetadata
    };
    assertRemoteOAuthDiscovery(binding, discovery, this.issuerResponseSupported);
    const tokens = await refreshAuthorization(binding.issuer, {
      metadata: server.authorizationServerMetadata,
      clientInformation: remoteOAuthClientInformation(binding, credential),
      refreshToken: credential.refreshToken,
      resource: new URL(binding.canonicalResource),
      fetchFn
    });
    if (signal.aborted) reauthenticationRequired();
    return refreshedCredential(binding, credential, tokens, this.now);
  }
}
