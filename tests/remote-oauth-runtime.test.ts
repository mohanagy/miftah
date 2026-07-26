import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OAuthAuthorizationHandoff } from "../src/oauth/remote-oauth-client-provider.js";
import { OAuthConnectionRegistry, type OAuthConnectionMetadataStore } from "../src/oauth/connection-registry.js";
import {
  connectionCredentialKey,
  createOAuthConfigIdentity,
  createOAuthConnectionBinding,
  parseOAuthConnectionRef
} from "../src/oauth/connection-types.js";
import {
  canonicalOAuthProfileRenameConfigPath,
  FileOAuthProfileRenameJournalStore,
  oauthProfileRenameJournalPath,
  type OAuthProfileRenameJournal
} from "../src/oauth/profile-rename-transaction.js";
import type { OAuthCredential, OAuthCredentialStore } from "../src/oauth/secure-credential-store.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { createRuntime, createRuntimeFromLoadedConfig } from "../src/runtime/create-runtime.js";
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

function bytesHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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

  it("finishes an interrupted native OAuth profile rename before refusing to use a stale loaded configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-runtime-profile-rename-recovery-"));
    directories.push(directory);
    const actualDirectory = join(directory, "actual");
    const aliasDirectory = join(directory, "alias");
    await mkdir(actualDirectory);
    await symlink(actualDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    const configPath = join(aliasDirectory, "miftah.json");
    const connectionRef = "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5";
    const sourceConfig = {
      version: "3" as const,
      name: "oauth-runtime-profile-rename",
      defaultProfile: "work",
      upstream: { transport: "streamable-http" as const, url: "https://mcp.example.test/mcp" },
      profiles: { work: {} },
      oauth: {
        connections: {
          [connectionRef]: {
            profile: "work",
            upstream: "default",
            resource: "https://mcp.example.test/mcp",
            issuer: "https://mcp.example.test",
            clientRegistration: "dynamic",
            scopes: ["mcp:tools"]
          }
        }
      }
    };
    const targetConfig = {
      ...sourceConfig,
      defaultProfile: "studio",
      profiles: { studio: {} },
      oauth: {
        connections: {
          [connectionRef]: { ...sourceConfig.oauth.connections[connectionRef], profile: "studio" }
        }
      }
    };
    const sourceBytes = Buffer.from(`${JSON.stringify(sourceConfig, null, 2)}\n`);
    const targetBytes = Buffer.from(`${JSON.stringify(targetConfig, null, 2)}\n`);
    await writeFile(configPath, targetBytes, { mode: 0o600 });

    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const configIdentity = createOAuthConfigIdentity(canonicalConfigPath);
    const from = createOAuthConnectionBinding({
      configIdentity,
      connectionRef: parseOAuthConnectionRef(connectionRef),
      profile: "work",
      upstream: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://mcp.example.test",
      clientRegistration: "dynamic",
      scopes: ["mcp:tools"]
    });
    const to = createOAuthConnectionBinding({ ...from, profile: "studio", resource: from.canonicalResource });
    const metadataStore = new MemoryMetadataStore();
    const credentialStore = new MemoryCredentialStore();
    const registry = new OAuthConnectionRegistry(metadataStore, () => "2030-01-02T03:04:05.000Z");
    await credentialStore.save(from, { accessToken: "fixture-runtime-recovery-token" });
    await credentialStore.save(to, { accessToken: "fixture-runtime-recovery-token" });
    await registry.create(from);
    const sourceBackupPath = join(dirname(canonicalConfigPath), ".miftah.json.miftah-oauth-profile-rename-source-runtime-recovery");
    await writeFile(sourceBackupPath, sourceBytes, { mode: 0o600 });
    const journal: OAuthProfileRenameJournal = {
      version: 1,
      configIdentity,
      sourceHash: bytesHash(sourceBytes),
      targetHash: bytesHash(targetBytes),
      auditRequired: false,
      sourceBackupPath,
      bindings: [{ from, to, originalCredentialPresent: true, originalMetadata: await registry.snapshot(from) }]
    };
    await new FileOAuthProfileRenameJournalStore().create(canonicalConfigPath, journal);

    await expect(createRuntime(configPath, undefined, {
      oauth: { metadataStore, credentialStore }
    })).rejects.toMatchObject({ code: "PROFILE_SELECTION_STALE" });
    await expect(credentialStore.load(from)).resolves.toBeUndefined();
    await expect(credentialStore.load(to)).resolves.toEqual({ accessToken: "fixture-runtime-recovery-token" });
    await expect(registry.snapshot(to)).resolves.toMatchObject({ binding: to });
    await expect(readFile(oauthProfileRenameJournalPath(configPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sourceBackupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const resumed = await createRuntimeFromLoadedConfig(configPath, targetConfig, undefined, {
      oauth: { metadataStore, credentialStore }
    });
    try {
      const oauth = resumed.oauth;
      expect(oauth).toBeDefined();
      await expect(oauth?.status("studio", "default")).resolves.toMatchObject({ credentialState: "disconnected" });
    } finally {
      await resumed.manager.close();
    }
  });

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

  it("persists the bounded profile identity state on its exact OAuth connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-identity-state-"));
    directories.push(directory);
    const configPath = join(directory, "miftah.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "3",
        name: "oauth-identity",
        defaultProfile: "work",
        upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
        profiles: { work: {}, personal: {} },
        oauth: {
          connections: {
            "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5": {
              profile: "work",
              upstream: "default",
              resource: "https://mcp.example.test/mcp",
              issuer: "https://mcp.example.test",
              clientRegistration: "dynamic",
              scopes: ["mcp:tools"]
            },
            "oauthconn:0df64944-d110-4b94-8cb0-b2d85b98a8da": {
              profile: "personal",
              upstream: "default",
              resource: "https://mcp.example.test/mcp",
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
    const runtime = await createRuntime(configPath, undefined, {
      oauth: { metadataStore, credentialStore: new MemoryCredentialStore() }
    });
    closeRuntime.push(() => runtime.manager.close());

    await runtime.oauth?.recordIdentityState("personal", "default", "verified");
    const unrelatedRecord = structuredClone(metadataStore.records[0]);
    await runtime.oauth?.recordIdentityState("work", "default", "changed");

    expect(metadataStore.records).toEqual([
      unrelatedRecord,
      expect.objectContaining({
        binding: expect.objectContaining({
          connectionRef: "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5",
          profile: "work",
          upstream: "default"
        }),
        identityState: "changed"
      })
    ]);
  });

  it("exposes only redacted configured state and disconnects the exact selected connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-application-state-"));
    directories.push(directory);
    const configPath = join(directory, "miftah.json");
    const reference = "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5";
    await writeFile(
      configPath,
      JSON.stringify({
        version: "3",
        name: "oauth-application-state",
        defaultProfile: "work",
        upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
        profiles: { work: {} },
        oauth: {
          connections: {
            [reference]: {
              profile: "work",
              upstream: "default",
              resource: "https://mcp.example.test/mcp",
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
    const runtime = await createRuntime(configPath, undefined, { oauth: { metadataStore, credentialStore } });
    closeRuntime.push(() => runtime.manager.close());

    expect(runtime.oauth?.connections()).toEqual([
      {
        connectionRef: reference,
        profile: "work",
        upstream: "default",
        resource: "https://mcp.example.test/mcp",
        issuer: "https://mcp.example.test",
        clientRegistration: "dynamic",
        scopes: ["mcp:tools"]
      }
    ]);
    expect(JSON.stringify(runtime.oauth?.connections())).not.toContain("configIdentity");
    await expect(runtime.oauth?.status("work", "default")).resolves.toMatchObject({
      connectionRef: reference,
      credentialState: "disconnected",
      identityState: "unverified"
    });
    await expect(runtime.oauth?.disconnect("work", "default")).resolves.toMatchObject({
      connectionRef: reference,
      credentialState: "disconnected"
    });
  });

  it("reconciles an expired persisted credential when reporting runtime status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-expired-status-"));
    directories.push(directory);
    const configPath = join(directory, "miftah.json");
    const reference = "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5";
    await writeFile(
      configPath,
      JSON.stringify({
        version: "3",
        name: "oauth-expired-status",
        defaultProfile: "work",
        upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
        profiles: { work: {} },
        oauth: {
          connections: {
            [reference]: {
              profile: "work",
              upstream: "default",
              resource: "https://mcp.example.test/mcp",
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
    metadataStore.records = [{
      binding: createOAuthConnectionBinding({
        configIdentity: createOAuthConfigIdentity(await realpath(configPath)),
        connectionRef: reference,
        profile: "work",
        upstream: "default",
        resource: "https://mcp.example.test/mcp",
        issuer: "https://mcp.example.test",
        clientRegistration: "dynamic",
        scopes: ["mcp:tools"]
      }),
      credentialState: "connected",
      identityState: "verified",
      expiresAt: "2026-07-22T01:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z"
    }];
    const runtime = await createRuntime(configPath, undefined, {
      oauth: {
        metadataStore,
        credentialStore: new MemoryCredentialStore(),
        now: () => new Date("2026-07-22T02:00:00.000Z")
      }
    });
    closeRuntime.push(() => runtime.manager.close());

    await expect(runtime.oauth?.status("work", "default")).resolves.toMatchObject({
      credentialState: "expired",
      expiresAt: "2026-07-22T01:00:00.000Z"
    });
  });

  it("records an unconfigured verifier as unsupported for its OAuth connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-unconfigured-identity-"));
    directories.push(directory);
    const configPath = join(directory, "miftah.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "3",
        name: "oauth-unconfigured-identity",
        defaultProfile: "work",
        upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
        profiles: { work: {} },
        oauth: {
          connections: {
            "oauthconn:475a8bf3-6d71-4af6-a5c1-c21831f08068": {
              profile: "work",
              upstream: "default",
              resource: "https://mcp.example.test/mcp",
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
    const runtime = await createRuntime(configPath, undefined, {
      oauth: { metadataStore, credentialStore: new MemoryCredentialStore() }
    });
    const wrapper = new MiftahServer(
      runtime.config,
      runtime.profileManager,
      runtime.manager,
      undefined,
      runtime.plugins,
      runtime.oauth,
      runtime.identities
    );
    closeRuntime.push(() => wrapper.close());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({ name: "miftah_verify_identity", arguments: {} });
    } finally {
      await client.close();
    }

    expect(metadataStore.records).toEqual([
      expect.objectContaining({ identityState: "unsupported" })
    ]);
  });
});
