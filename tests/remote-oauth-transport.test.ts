import { afterEach, describe, expect, it } from "vitest";
import { OAuthConnectionLifecycle } from "../src/oauth/connection-lifecycle.js";
import { OAuthConnectionRegistry, type OAuthConnectionMetadataStore } from "../src/oauth/connection-registry.js";
import { createOAuthConnectionBinding, connectionCredentialKey } from "../src/oauth/connection-types.js";
import { RemoteOAuthClientProvider, type OAuthAuthorizationHandoff } from "../src/oauth/remote-oauth-client-provider.js";
import type { OAuthCredential, OAuthCredentialStore } from "../src/oauth/secure-credential-store.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";
import {
  startOAuthCompatibilityProbe,
  type OAuthCompatibilityProbe
} from "./helpers/fake-remote-upstream.js";

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
  readonly credentials = new Map<string, OAuthCredential>();

  async load(binding: Parameters<OAuthCredentialStore["load"]>[0]): Promise<OAuthCredential | undefined> {
    const credential = this.credentials.get(connectionCredentialKey(binding));
    return credential === undefined ? undefined : structuredClone(credential);
  }

  async save(binding: Parameters<OAuthCredentialStore["save"]>[0], credential: OAuthCredential): Promise<void> {
    this.credentials.set(connectionCredentialKey(binding), structuredClone(credential));
  }

  async delete(binding: Parameters<OAuthCredentialStore["delete"]>[0]): Promise<void> {
    this.credentials.delete(connectionCredentialKey(binding));
  }
}

class SimulatedBrowserHandoff implements OAuthAuthorizationHandoff {
  readonly redirectUrl = new URL("http://127.0.0.1:43179/oauth/callback");
  closeCount = 0;
  private closed = false;

  constructor(private readonly upstream: OAuthCompatibilityProbe) {}

  async authorize(
    authorizationUrl: URL,
    expected: { readonly state: string; readonly issuer: string }
  ): Promise<string> {
    const response = await this.upstream.fetch(authorizationUrl, { redirect: "manual" });
    const location = response.headers.get("location");
    if (location === null) throw new Error("fixture authorization did not redirect");
    const callback = new URL(location);
    expect(callback.searchParams.get("state")).toBe(expected.state);
    expect(callback.searchParams.get("iss")).toBe(expected.issuer);
    const code = callback.searchParams.get("code");
    if (code === null) throw new Error("fixture callback did not contain a code");
    return code;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeCount += 1;
  }
}

describe("profile-bound remote OAuth transport", () => {
  const upstreams: OAuthCompatibilityProbe[] = [];
  const managers: UpstreamProcessManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.close()));
    await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  });

  it.each([
    ["dynamic", "miftah-compatibility-client", 1],
    ["pre-registered:miftah-desktop", "miftah-desktop", 0],
    [
      "client-id-metadata:https://client.example.test/miftah.json",
      "https://client.example.test/miftah.json",
      0
    ]
  ] as const)(
    "completes authorization with %s registration and reconnects with the exact bearer",
    async (clientRegistration, expectedClientId, expectedRegistrationRequests) => {
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    upstreams.push(upstream);
    const binding = createOAuthConnectionBinding({
      configIdentity: "a".repeat(64),
      connectionRef: "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5",
      profile: "work",
      upstream: "default",
      resource: upstream.streamableHttpUrl,
      issuer: "https://mcp.example.test",
      clientRegistration,
      scopes: ["mcp:tools"]
    });
    const lifecycle = new OAuthConnectionLifecycle({
      registry: new OAuthConnectionRegistry(new MemoryMetadataStore()),
      store: new MemoryCredentialStore()
    });
    const handoff = new SimulatedBrowserHandoff(upstream);
    const provider = new RemoteOAuthClientProvider({
      binding,
      lifecycle,
      handoff,
      state: () => "fixture-state-value-that-is-long-enough"
    });
    const manager = new UpstreamProcessManager(
      { transport: "streamable-http", url: upstream.streamableHttpUrl },
      { work: {}, personal: {} },
      {
        remoteFetch: upstream.fetch,
        oauthProvider: async (profile, upstreamName) =>
          profile === "work" && upstreamName === "default" ? provider : undefined
      }
    );
    managers.push(manager);

    await expect(manager.listTools("work")).resolves.toEqual([
      expect.objectContaining({ name: "whoami" })
    ]);
    expect(upstream.unauthenticatedMcpRequests()).toBe(1);
    expect(upstream.authenticatedMcpRequests()).toBeGreaterThanOrEqual(2);
    expect(upstream.tokenExchanges()).toEqual([
      expect.objectContaining({
        clientId: expectedClientId,
        pkceVerified: true,
        resource: upstream.streamableHttpUrl
      })
    ]);
    expect(upstream.registrationRequests()).toHaveLength(expectedRegistrationRequests);
    expect(handoff.closeCount).toBe(1);
    const authenticatedBeforeWrongProfile = upstream.authenticatedMcpRequests();
    await expect(manager.listTools("personal")).rejects.toMatchObject({ code: "UPSTREAM_TOOL_LIST_FAILED" });
    expect(upstream.authenticatedMcpRequests()).toBe(authenticatedBeforeWrongProfile);
    expect(upstream.tokenExchanges()).toHaveLength(1);
    await manager.close();
    expect(handoff.closeCount).toBe(1);
    }
  );

  it("maps provider failures to a typed diagnostic without raw OAuth output", async () => {
    const manager = new UpstreamProcessManager(
      { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      { work: {} },
      {
        oauthProvider: async () => {
          throw new Error("fixture-provider-secret-and-raw-response");
        }
      }
    );
    managers.push(manager);

    let failure: unknown;
    try {
      await manager.get("work");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "OAUTH_AUTHORIZATION_FAILED" });
    expect((failure as Error).message).not.toContain("fixture-provider-secret-and-raw-response");
  });

  it("rejects a non-HTTP OAuth binding and closes its authorization handoff", async () => {
    const lifecycle = new OAuthConnectionLifecycle({
      registry: new OAuthConnectionRegistry(new MemoryMetadataStore()),
      store: new MemoryCredentialStore()
    });
    let closeCount = 0;
    const provider = new RemoteOAuthClientProvider({
      binding: createOAuthConnectionBinding({
        configIdentity: "a".repeat(64),
        connectionRef: "oauthconn:1d915a13-f8a5-45e0-8343-1e82e0939129",
        profile: "work",
        upstream: "default",
        resource: "https://mcp.example.test/mcp",
        issuer: "https://mcp.example.test",
        clientRegistration: "pre-registered:miftah-desktop",
        scopes: ["mcp:tools"]
      }),
      lifecycle,
      handoff: {
        redirectUrl: new URL("http://127.0.0.1:43179/oauth/callback"),
        authorize: async () => "fixture-code",
        close: async () => {
          closeCount += 1;
        }
      }
    });
    const manager = new UpstreamProcessManager(
      { transport: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"] },
      { work: {} },
      { oauthProvider: async () => provider }
    );
    managers.push(manager);

    await expect(manager.get("work")).rejects.toMatchObject({ code: "OAUTH_CONNECTION_INVALID" });
    expect(closeCount).toBe(1);
  });
});
