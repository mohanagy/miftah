import { discoverOAuthServerInfo } from "@modelcontextprotocol/client";
import type { OAuthDiscoveryState, FetchLike } from "@modelcontextprotocol/client";
import { createOAuthConnectionBinding, type OAuthConnectionRef } from "./connection-types.js";
import { assertRemoteOAuthDiscovery } from "./remote-oauth-client-provider.js";
import { OAuthMetadataFetchGuard } from "./oauth-metadata-fetch-guard.js";
import { canonicalizeOAuthResource } from "./canonical-resource.js";
import { MiftahError } from "../utils/errors.js";

const discoveryConfigIdentity = "0".repeat(64);

export interface DiscoverNativeOAuthConnectionRequest {
  /** Exact target selected by the user before discovery begins. */
  readonly resource: string;
  /** These identifiers are bound to the eventual config; they are never inferred from metadata. */
  readonly profile: string;
  readonly upstream: string;
  readonly connectionRef: OAuthConnectionRef;
}

/** Non-secret result that a caller may show for review before publishing a configuration. */
export interface DiscoveredNativeOAuthConnection {
  readonly resource: string;
  readonly issuer: string;
  readonly clientRegistration: "dynamic";
  /** Server-advertised scopes. A later UI must make the authorization impact visible before connect. */
  readonly advertisedScopes: readonly string[];
}

export interface NativeOAuthDiscoveryDependencies {
  /** Test seam and bounded-transport integration point; production uses the global fetch implementation. */
  readonly fetch?: FetchLike;
}

function discoveryUnsupported(): never {
  throw new MiftahError(
    "OAUTH_DISCOVERY_UNSUPPORTED",
    "OAUTH_DISCOVERY_UNSUPPORTED: the remote MCP endpoint does not expose a supported standards-based OAuth configuration"
  );
}

function dynamicRegistrationUnsupported(): never {
  throw new MiftahError(
    "OAUTH_CLIENT_REGISTRATION_UNSUPPORTED",
    "OAUTH_CLIENT_REGISTRATION_UNSUPPORTED: the remote MCP endpoint does not support dynamic client registration; use advanced OAuth setup with provider-supplied registration details"
  );
}

/**
 * Discovers one native OAuth binding before any config, browser handoff, client registration, or credential is created.
 *
 * The endpoint is the trust anchor. Resource metadata must name exactly one authorization server so Miftah never
 * chooses an issuer on the user's behalf. Only dynamic registration is eligible for this endpoint-first flow;
 * pre-registered and client-metadata modes necessarily require provider input and remain the advanced path.
 */
export async function discoverNativeOAuthConnection(
  request: DiscoverNativeOAuthConnectionRequest,
  dependencies: NativeOAuthDiscoveryDependencies = {}
): Promise<DiscoveredNativeOAuthConnection> {
  const canonicalResource = canonicalizeOAuthResource(request.resource);
  const guard = new OAuthMetadataFetchGuard(dependencies.fetch);
  let server: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    server = await discoverOAuthServerInfo(canonicalResource, { fetchFn: guard.fetch });
  } catch {
    discoveryUnsupported();
  }

  const authorizationServers = server.resourceMetadata?.authorization_servers;
  if (
    authorizationServers === undefined ||
    authorizationServers.length !== 1 ||
    authorizationServers[0] !== server.authorizationServerUrl
  ) {
    discoveryUnsupported();
  }
  if (server.authorizationServerMetadata?.registration_endpoint === undefined) {
    dynamicRegistrationUnsupported();
  }

  const binding = createOAuthConnectionBinding({
    configIdentity: discoveryConfigIdentity,
    connectionRef: request.connectionRef,
    profile: request.profile,
    upstream: request.upstream,
    resource: canonicalResource,
    issuer: server.authorizationServerUrl,
    clientRegistration: "dynamic",
    scopes: server.resourceMetadata?.scopes_supported ?? []
  });
  const state: OAuthDiscoveryState = {
    authorizationServerUrl: server.authorizationServerUrl,
    resourceMetadata: server.resourceMetadata,
    authorizationServerMetadata: server.authorizationServerMetadata
  };
  try {
    assertRemoteOAuthDiscovery(binding, state, (issuer) => guard.issuerResponseSupported(issuer));
  } catch (error) {
    if (error instanceof MiftahError) throw error;
    discoveryUnsupported();
  }

  return {
    resource: binding.canonicalResource,
    issuer: binding.issuer,
    clientRegistration: "dynamic",
    advertisedScopes: [...binding.scopes]
  };
}
