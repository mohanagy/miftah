import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileOAuthConnectionMetadataStore,
  OAuthConnectionRegistry,
  type OAuthConnectionMetadataStore,
  type OAuthConnectionRecord
} from "../src/oauth/connection-registry.js";
import { createOAuthConfigIdentity, createOAuthConnectionBinding, parseOAuthConnectionRef } from "../src/oauth/connection-types.js";

const ref = "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

function binding(overrides: Record<string, unknown> = {}) {
  return createOAuthConnectionBinding({
    configIdentity: createOAuthConfigIdentity("/tmp/miftah.json"),
    connectionRef: parseOAuthConnectionRef(ref),
    profile: "work",
    upstream: "analytics",
    resource: "https://mcp.example.test/mcp",
    issuer: "https://issuer.example.test",
    clientRegistration: "pre-registered:desktop",
    scopes: ["mcp:tools"],
    ...overrides
  });
}

class MemoryMetadataStore implements OAuthConnectionMetadataStore {
  records: OAuthConnectionRecord[] = [];

  async load(): Promise<readonly OAuthConnectionRecord[]> {
    return [...structuredClone(this.records)];
  }

  async save(records: readonly OAuthConnectionRecord[]): Promise<void> {
    this.records = [...structuredClone(records)];
  }
}

describe("OAuth connection registry", () => {
  it("persists safe lifecycle and identity state independently of credential validity", async () => {
    const store = new MemoryMetadataStore();
    const registry = new OAuthConnectionRegistry(store, () => "2030-01-02T03:04:05.000Z");
    const expected = binding();

    await registry.create(expected);
    await registry.setCredentialState(expected.connectionRef, expected, "expiring", "2030-01-03T03:04:05.000Z");
    await registry.setIdentityState(expected.connectionRef, expected, "verified");

    await expect(registry.get(expected.connectionRef, expected)).resolves.toEqual({
      binding: expected,
      credentialState: "expiring",
      identityState: "verified",
      expiresAt: "2030-01-03T03:04:05.000Z",
      updatedAt: "2030-01-02T03:04:05.000Z"
    });
    expect(JSON.stringify(store.records)).not.toMatch(/accessToken|refreshToken|secret|token-value/u);
  });

  it("fails closed if a reference is looked up under another binding", async () => {
    const store = new MemoryMetadataStore();
    const registry = new OAuthConnectionRegistry(store);
    const expected = binding();
    await registry.create(expected);

    await expect(registry.get(expected.connectionRef, binding({ profile: "personal" }))).rejects.toMatchObject({
      code: "OAUTH_CONNECTION_BINDING_MISMATCH"
    });
    await expect(registry.get("oauthconn:1d915a13-f8a5-45e0-8343-1e82e0939129", expected)).rejects.toMatchObject({
      code: "OAUTH_CONNECTION_NOT_FOUND"
    });
  });

  it("refuses a second connection for the same profile/upstream target and retains records across registry instances", async () => {
    const store = new MemoryMetadataStore();
    const first = binding();
    const duplicateTarget = binding({ connectionRef: "oauthconn:1d915a13-f8a5-45e0-8343-1e82e0939129" });
    const initial = new OAuthConnectionRegistry(store);
    await initial.create(first);

    await expect(initial.create(duplicateTarget)).rejects.toMatchObject({ code: "OAUTH_CONNECTION_INVALID" });
    const resumed = new OAuthConnectionRegistry(store);
    await expect(resumed.get(first.connectionRef, first)).resolves.toMatchObject({
      credentialState: "disconnected",
      identityState: "unverified"
    });
  });

  it("persists only safe metadata in a restrictive local registry file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-registry-"));
    directories.push(directory);
    const path = join(directory, "connections.json");
    const bindingRecord = binding();
    const registry = new OAuthConnectionRegistry(new FileOAuthConnectionMetadataStore(path));

    await registry.create(bindingRecord);
    const saved = await readFile(path, "utf8");
    expect(JSON.parse(saved)).toEqual({
      version: 1,
      records: [
        expect.objectContaining({
          binding: expect.objectContaining({ connectionRef: bindingRecord.connectionRef }),
          credentialState: "disconnected",
          identityState: "unverified"
        })
      ]
    });
    expect(saved).not.toMatch(/accessToken|refreshToken|password|credential-value/u);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(new OAuthConnectionRegistry(new FileOAuthConnectionMetadataStore(path)).get(bindingRecord.connectionRef, bindingRecord)).resolves.toMatchObject({
      binding: bindingRecord
    });
  });

  it("does not lose a connection when independent file-backed registries create records concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-registry-concurrent-"));
    directories.push(directory);
    const path = join(directory, "connections.json");
    const first = binding();
    const second = binding({
      connectionRef: "oauthconn:1d915a13-f8a5-45e0-8343-1e82e0939129",
      profile: "personal",
      upstream: "billing"
    });

    await Promise.all([
      new OAuthConnectionRegistry(new FileOAuthConnectionMetadataStore(path)).create(first),
      new OAuthConnectionRegistry(new FileOAuthConnectionMetadataStore(path)).create(second)
    ]);

    const records = await new FileOAuthConnectionMetadataStore(path).load();
    expect(records.map((record) => record.binding.connectionRef).sort()).toEqual([first.connectionRef, second.connectionRef].sort());
  });

  it("does not inherit a stale filesystem lock artifact after another process exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-registry-stale-lock-"));
    directories.push(directory);
    const path = join(directory, "connections.json");
    await mkdir(join(directory, ".connections.json.lock"), { mode: 0o700 });

    await expect(new OAuthConnectionRegistry(new FileOAuthConnectionMetadataStore(path)).create(binding())).resolves.toMatchObject({
      credentialState: "disconnected"
    });
  });
});
