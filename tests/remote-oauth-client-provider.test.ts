import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it } from "vitest";
import { OAuthConnectionLifecycle } from "../src/oauth/connection-lifecycle.js";
import { OAuthConnectionRegistry, type OAuthConnectionMetadataStore } from "../src/oauth/connection-registry.js";
import { createOAuthConnectionBinding } from "../src/oauth/connection-types.js";
import {
  RemoteOAuthClientProvider,
  type OAuthAuthorizationHandoff
} from "../src/oauth/remote-oauth-client-provider.js";
import type { OAuthCredential, OAuthCredentialStore } from "../src/oauth/secure-credential-store.js";

const connectionRef = "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5";

class MemoryMetadataStore implements OAuthConnectionMetadataStore {
  records: Awaited<ReturnType<OAuthConnectionMetadataStore["load"]>> = [];

  async load() {
    return structuredClone(this.records);
  }

  async save(records: Awaited<ReturnType<OAuthConnectionMetadataStore["load"]>>): Promise<void> {
    this.records = structuredClone(records);
  }
}

class MemoryCredentialStore implements OAuthCredentialStore {
  credential?: OAuthCredential;

  async load(): Promise<OAuthCredential | undefined> {
    return this.credential === undefined ? undefined : structuredClone(this.credential);
  }

  async save(_binding: unknown, credential: OAuthCredential): Promise<void> {
    this.credential = structuredClone(credential);
  }

  async delete(): Promise<void> {
    this.credential = undefined;
  }
}

class DeferredHandoff implements OAuthAuthorizationHandoff {
  readonly redirectUrl = new URL("http://127.0.0.1:43179/oauth/callback");

  authorize(): Promise<string> {
    return Promise.resolve("fixture-code");
  }

  async close(): Promise<void> {}
}

function binding(overrides: { clientRegistration?: string } = {}) {
  return createOAuthConnectionBinding({
    configIdentity: "a".repeat(64),
    connectionRef,
    profile: "work",
    upstream: "default",
    resource: "https://mcp.example.test/mcp",
    issuer: "https://issuer.example.test",
    clientRegistration: overrides.clientRegistration ?? "pre-registered:miftah-desktop",
    scopes: ["mcp:tools"]
  });
}

function discovery(overrides: Partial<OAuthDiscoveryState> = {}): OAuthDiscoveryState {
  return {
    authorizationServerUrl: "https://issuer.example.test",
    resourceMetadataUrl: "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
    resourceMetadata: {
      resource: "https://mcp.example.test/mcp",
      authorization_servers: ["https://issuer.example.test"],
      scopes_supported: ["mcp:tools"]
    },
    authorizationServerMetadata: {
      issuer: "https://issuer.example.test",
      authorization_endpoint: "https://issuer.example.test/authorize",
      token_endpoint: "https://issuer.example.test/token",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true
    },
    ...overrides
  };
}

function service(now: () => Date = () => new Date()) {
  const store = new MemoryCredentialStore();
  const lifecycle = new OAuthConnectionLifecycle({
    registry: new OAuthConnectionRegistry(new MemoryMetadataStore()),
    store,
    now
  });
  return { lifecycle, store };
}

function provider() {
  const { lifecycle } = service();
  return new RemoteOAuthClientProvider({
    binding: binding(),
    lifecycle,
    handoff: new DeferredHandoff(),
    state: () => "fixture-state-value-that-is-long-enough"
  });
}

function providerForRegistration(clientRegistration: string) {
  const { lifecycle } = service();
  return new RemoteOAuthClientProvider({
    binding: binding({ clientRegistration }),
    lifecycle,
    handoff: new DeferredHandoff(),
    state: () => "fixture-state-value-that-is-long-enough"
  });
}

describe("remote OAuth client provider", () => {
  it("accepts only discovery metadata bound to the exact resource, issuer, PKCE, and issuer response", async () => {
    const exact = provider();
    await expect(exact.saveDiscoveryState(discovery())).resolves.toBeUndefined();
    await expect(
      exact.validateResourceURL("https://mcp.example.test/mcp", "https://mcp.example.test/mcp")
    ).resolves.toEqual(new URL("https://mcp.example.test/mcp"));

    const wrongResource = provider();
    await expect(
      wrongResource.saveDiscoveryState(
        discovery({
          resourceMetadata: {
            resource: "https://other.example.test/mcp",
            authorization_servers: ["https://issuer.example.test"]
          }
        })
      )
    ).rejects.toMatchObject({ code: "OAUTH_DISCOVERY_UNSUPPORTED" });

    const wrongIssuer = provider();
    await expect(
      wrongIssuer.saveDiscoveryState(discovery({ authorizationServerUrl: "https://other-issuer.example.test" }))
    ).rejects.toMatchObject({ code: "OAUTH_DISCOVERY_UNSUPPORTED" });

    const missingPkce = provider();
    await expect(
      missingPkce.saveDiscoveryState(
        discovery({
          authorizationServerMetadata: {
            ...discovery().authorizationServerMetadata!,
            code_challenge_methods_supported: []
          }
        })
      )
    ).rejects.toMatchObject({ code: "OAUTH_DISCOVERY_UNSUPPORTED" });

    const missingIssuerResponse = provider();
    const metadata: Record<string, unknown> = { ...discovery().authorizationServerMetadata! };
    delete metadata.authorization_response_iss_parameter_supported;
    await expect(
      missingIssuerResponse.saveDiscoveryState(
        discovery({ authorizationServerMetadata: metadata as OAuthDiscoveryState["authorizationServerMetadata"] })
      )
    ).rejects.toMatchObject({ code: "OAUTH_DISCOVERY_UNSUPPORTED" });
  });

  it("persists dynamic client registration with the credential for restart-safe refresh", async () => {
    const exactBinding = binding({ clientRegistration: "dynamic" });
    const { lifecycle } = service(() => new Date("2026-07-22T00:00:01.000Z"));
    const first = new RemoteOAuthClientProvider({
      binding: exactBinding,
      lifecycle,
      handoff: new DeferredHandoff(),
      now: () => new Date("2026-07-22T00:00:00.000Z")
    });
    first.saveClientInformation({
      client_id: "fixture-dynamic-client",
      client_secret: "fixture-dynamic-client-secret"
    });
    await first.saveTokens({
      access_token: "fixture-access-token",
      refresh_token: "fixture-refresh-token",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "mcp:tools"
    });

    const restarted = new RemoteOAuthClientProvider({
      binding: exactBinding,
      lifecycle,
      handoff: new DeferredHandoff(),
      now: () => new Date("2026-07-22T00:00:01.000Z")
    });
    await expect(restarted.tokens()).resolves.toMatchObject({ access_token: "fixture-access-token" });
    await expect(restarted.clientInformation()).resolves.toMatchObject({
      client_id: "fixture-dynamic-client",
      client_secret: "fixture-dynamic-client-secret"
    });
  });

  it("requires only the discovery capability selected by the client registration mode", async () => {
    const preRegistered = providerForRegistration("pre-registered:miftah-desktop");
    await expect(preRegistered.saveDiscoveryState(discovery())).resolves.toBeUndefined();

    const metadataUrl = "https://client.example.test/miftah.json";
    const metadataClient = providerForRegistration(`client-id-metadata:${metadataUrl}`);
    await expect(metadataClient.saveDiscoveryState(discovery())).rejects.toMatchObject({
      code: "OAUTH_DISCOVERY_UNSUPPORTED"
    });
    const metadata = {
      ...discovery().authorizationServerMetadata!,
      client_id_metadata_document_supported: true
    };
    await expect(
      metadataClient.saveDiscoveryState(discovery({ authorizationServerMetadata: metadata }))
    ).resolves.toBeUndefined();
    await expect(metadataClient.clientInformation()).resolves.toEqual({ client_id: metadataUrl });

    const dynamic = providerForRegistration("dynamic");
    await expect(dynamic.saveDiscoveryState(discovery())).rejects.toMatchObject({
      code: "OAUTH_DISCOVERY_UNSUPPORTED"
    });
    await expect(
      dynamic.saveDiscoveryState(
        discovery({
          authorizationServerMetadata: {
            ...discovery().authorizationServerMetadata!,
            registration_endpoint: "https://issuer.example.test/register"
          }
        })
      )
    ).resolves.toBeUndefined();
  });

  it("rejects duplicate authorization parameters and a missing PKCE challenge before browser handoff", async () => {
    const exact = provider();
    await exact.saveDiscoveryState(discovery());
    const authorizationUrl = new URL("https://issuer.example.test/authorize");
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("state", "fixture-state-value-that-is-long-enough");
    authorizationUrl.searchParams.set("redirect_uri", exact.redirectUrl.toString());
    authorizationUrl.searchParams.set("resource", "https://mcp.example.test/mcp");
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("scope", "mcp:tools");

    let missingChallenge: unknown;
    try {
      exact.redirectToAuthorization(authorizationUrl);
    } catch (error) {
      missingChallenge = error;
    }
    expect(missingChallenge).toMatchObject({ code: "OAUTH_AUTHORIZATION_FAILED" });

    authorizationUrl.searchParams.set("code_challenge", "a".repeat(43));
    authorizationUrl.searchParams.append("state", "fixture-state-value-that-is-long-enough");
    let duplicateState: unknown;
    try {
      exact.redirectToAuthorization(authorizationUrl);
    } catch (error) {
      duplicateState = error;
    }
    expect(duplicateState).toMatchObject({ code: "OAUTH_AUTHORIZATION_FAILED" });
  });
});
