import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OAuthAuthorizationHandoff } from "../src/oauth/remote-oauth-client-provider.js";
import type { OAuthConnectionMetadataStore } from "../src/oauth/connection-registry.js";
import { connectionCredentialKey } from "../src/oauth/connection-types.js";
import type { OAuthCredential, OAuthCredentialStore } from "../src/oauth/secure-credential-store.js";
import { createRuntime } from "../src/runtime/create-runtime.js";
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
    const value = this.credentials.get(connectionCredentialKey(binding));
    return value === undefined ? undefined : structuredClone(value);
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

  constructor(
    private readonly upstream: OAuthCompatibilityProbe,
    private readonly onAuthorize: () => void = () => undefined
  ) {}

  async authorize(
    authorizationUrl: URL,
    expected: { readonly state: string; readonly issuer: string }
  ): Promise<string> {
    this.onAuthorize();
    const response = await this.upstream.fetch(authorizationUrl, { redirect: "manual" });
    const callback = new URL(response.headers.get("location") ?? "invalid:");
    expect(callback.searchParams.get("state")).toBe(expected.state);
    expect(callback.searchParams.get("iss")).toBe(expected.issuer);
    const code = callback.searchParams.get("code");
    if (code === null) throw new Error("fixture callback did not contain a code");
    return code;
  }

  async close(): Promise<void> {}
}

describe("remote OAuth runtime wiring", () => {
  const upstreams: OAuthCompatibilityProbe[] = [];
  const directories: string[] = [];
  const closeRuntime: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeRuntime.splice(0).map((close) => close()));
    await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it.each(["oauth", "oidc"] as const)(
    "constructs the exact OAuth engine with %s discovery and reaches the protected upstream",
    async (discoveryKind) => {
    const upstream = await startOAuthCompatibilityProbe({
      publicBaseUrl: "https://mcp.example.test",
      discoveryKind
    });
    upstreams.push(upstream);
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-runtime-"));
    directories.push(directory);
    const configPath = join(directory, "miftah.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "3",
        name: "oauth-runtime",
        defaultProfile: "work",
        upstream: { transport: "streamable-http", url: upstream.streamableHttpUrl },
        profiles: { work: {} },
        oauth: {
          connections: {
            "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5": {
              profile: "work",
              upstream: "default",
              resource: upstream.streamableHttpUrl,
              issuer: "https://mcp.example.test",
              clientRegistration: "dynamic",
              scopes: ["mcp:tools"]
            }
          }
        }
      }),
      "utf8"
    );

    const runtime = await createRuntime(configPath, undefined, {
      oauth: {
        metadataStore: new MemoryMetadataStore(),
        credentialStore: new MemoryCredentialStore(),
        fetch: upstream.fetch,
        createHandoff: async () => new SimulatedBrowserHandoff(upstream)
      }
    });
    closeRuntime.push(() => runtime.manager.close());

    await expect(runtime.manager.listTools("work")).resolves.toEqual([
      expect.objectContaining({ name: "whoami" })
    ]);
    expect(upstream.authenticatedMcpRequests()).toBeGreaterThanOrEqual(2);
    }
  );

  it("refreshes and reconnects after process restart without another browser authorization", async () => {
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    upstreams.push(upstream);
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-restart-"));
    directories.push(directory);
    const configPath = join(directory, "miftah.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "3",
        name: "oauth-restart",
        defaultProfile: "work",
        upstream: { transport: "streamable-http", url: upstream.streamableHttpUrl },
        profiles: { work: {} },
        oauth: {
          connections: {
            "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5": {
              profile: "work",
              upstream: "default",
              resource: upstream.streamableHttpUrl,
              issuer: "https://mcp.example.test",
              clientRegistration: "dynamic",
              scopes: ["mcp:tools"]
            }
          }
        }
      }),
      "utf8"
    );
    const metadataStore = new MemoryMetadataStore();
    const credentialStore = new MemoryCredentialStore();
    let browserAuthorizations = 0;
    const create = (now: string) => createRuntime(configPath, undefined, {
      oauth: {
        metadataStore,
        credentialStore,
        fetch: upstream.fetch,
        now: () => new Date(now),
        createHandoff: async () => new SimulatedBrowserHandoff(upstream, () => {
          browserAuthorizations += 1;
        })
      }
    });

    const initial = await create("2026-07-22T00:00:00.000Z");
    await expect(initial.manager.listTools("work")).resolves.toHaveLength(1);
    await initial.manager.close();

    const restarted = await create("2026-07-22T02:00:00.000Z");
    closeRuntime.push(() => restarted.manager.close());
    await expect(restarted.manager.listTools("work")).resolves.toHaveLength(1);

    expect(browserAuthorizations).toBe(1);
    expect(upstream.tokenExchanges().map((exchange) => exchange.grantType)).toEqual([
      "authorization_code",
      "refresh_token"
    ]);
  });
});
