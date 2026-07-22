import { describe, expect, it } from "vitest";
import { createOAuthConfigIdentity, createOAuthConnectionBinding, parseOAuthConnectionRef } from "../src/oauth/connection-types.js";
import {
  createPlatformOAuthCredentialStore,
  PlatformOAuthCredentialStore,
  type OAuthKeyringAdapter
} from "../src/oauth/secure-credential-store.js";
import { SecretRedactor } from "../src/secrets/redact.js";

const binding = (overrides: Record<string, unknown> = {}) =>
  createOAuthConnectionBinding({
    configIdentity: createOAuthConfigIdentity("/tmp/miftah.json"),
    connectionRef: parseOAuthConnectionRef("oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5"),
    profile: "work",
    upstream: "default",
    resource: "https://mcp.example.test/mcp",
    issuer: "https://issuer.example.test",
    clientRegistration: "pre-registered:desktop",
    scopes: ["mcp:tools"],
    ...overrides
  });

class MemoryKeyringAdapter implements OAuthKeyringAdapter {
  readonly entries = new Map<string, string>();
  failure?: Error;

  async getPassword(service: string, account: string): Promise<string | undefined> {
    if (this.failure) throw this.failure;
    return this.entries.get(`${service}:${account}`);
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.entries.set(`${service}:${account}`, password);
  }

  async deletePassword(service: string, account: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.entries.delete(`${service}:${account}`);
  }
}

describe("OAuth secure credential store", () => {
  it("constructs the production store from the native OS-keyring binding", async () => {
    await expect(createPlatformOAuthCredentialStore()).resolves.toBeInstanceOf(PlatformOAuthCredentialStore);
  });

  it("stores tokens only under an opaque exact-binding key and registers them for redaction", async () => {
    const adapter = new MemoryKeyringAdapter();
    const redactor = new SecretRedactor();
    const store = new PlatformOAuthCredentialStore(adapter, redactor);
    const accessToken = "fixture-access-token-never-log";
    const refreshToken = "fixture-refresh-token-never-log";

    await store.save(binding(), {
      accessToken,
      refreshToken,
      expiresAt: "2030-01-02T03:04:05.000Z"
    });

    expect([...adapter.entries]).toHaveLength(1);
    const entry = [...adapter.entries][0];
    if (!entry) throw new Error("Expected a credential entry.");
    const [address, serialized] = entry;
    expect(address).toMatch(/^miftah\.oauth\.v1:v1-[A-Za-z0-9_-]{43}$/u);
    expect(address).not.toContain("work");
    expect(address).not.toContain("mcp.example.test");
    expect(serialized).toContain(accessToken);
    expect(redactor.redactText(`access=${accessToken}; refresh=${refreshToken}`)).toBe("access=[REDACTED]; refresh=[REDACTED]");
    await expect(store.load(binding())).resolves.toEqual({ accessToken, refreshToken, expiresAt: "2030-01-02T03:04:05.000Z" });
    await expect(store.load(binding({ profile: "personal" }))).resolves.toBeUndefined();
  });

  it("fails closed on a mismatched vault envelope after registering any parsed tokens for redaction", async () => {
    const adapter = new MemoryKeyringAdapter();
    const redactor = new SecretRedactor();
    const store = new PlatformOAuthCredentialStore(adapter, redactor);
    const accessToken = "fixture-tampered-access-token";
    await store.save(binding(), { accessToken });
    const [address] = adapter.entries.keys();
    if (!address) throw new Error("Expected a credential entry.");
    adapter.entries.set(
      address,
      JSON.stringify({ version: 1, bindingKey: "v1-other-binding", accessToken })
    );

    await expect(store.load(binding())).rejects.toMatchObject({ code: "OAUTH_CREDENTIAL_INVALID" });
    expect(redactor.redactText(`access=${accessToken}`)).toBe("access=[REDACTED]");
  });

  it.each([
    ["non-string refresh token", { refreshToken: 7 }],
    ["non-string expiry", { expiresAt: null }],
    ["unexpected field", { clientSecret: "fixture-unexpected-secret" }]
  ])("fails closed on a vault envelope with a %s", async (_description, tampering) => {
    const adapter = new MemoryKeyringAdapter();
    const store = new PlatformOAuthCredentialStore(adapter, new SecretRedactor());
    await store.save(binding(), { accessToken: "fixture-access-token" });
    const [address] = adapter.entries.keys();
    if (!address) throw new Error("Expected a credential entry.");
    const original = JSON.parse(adapter.entries.get(address) ?? "null") as Record<string, unknown>;
    adapter.entries.set(address, JSON.stringify({ ...original, ...tampering }));

    await expect(store.load(binding())).rejects.toMatchObject({ code: "OAUTH_CREDENTIAL_INVALID" });
  });

  it("never falls back when the operating-system vault is unavailable", async () => {
    const adapter = new MemoryKeyringAdapter();
    adapter.failure = new Error("unavailable secret backend with fixture-access-token");
    const store = new PlatformOAuthCredentialStore(adapter, new SecretRedactor());
    let failure: unknown;

    try {
      await store.save(binding(), { accessToken: "fixture-access-token" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "OAUTH_SECURE_STORE_UNAVAILABLE" });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("fixture-access-token");
    await expect(store.load(binding())).rejects.toMatchObject({ code: "OAUTH_SECURE_STORE_UNAVAILABLE" });
  });

  it("refuses an oversized serialized vault envelope before writing it", async () => {
    const adapter = new MemoryKeyringAdapter();
    const store = new PlatformOAuthCredentialStore(adapter, new SecretRedactor());
    const accessToken = String.fromCharCode(0).repeat(12_000);

    await expect(store.save(binding(), { accessToken })).rejects.toMatchObject({ code: "OAUTH_CREDENTIAL_INVALID" });
    expect(adapter.entries).toHaveLength(0);
  });

  it("removes the exact credential on disconnect without affecting another binding", async () => {
    const adapter = new MemoryKeyringAdapter();
    const store = new PlatformOAuthCredentialStore(adapter, new SecretRedactor());
    const work = binding();
    const personal = binding({ profile: "personal" });
    await store.save(work, { accessToken: "work-token" });
    await store.save(personal, { accessToken: "personal-token" });

    await store.delete(work);

    await expect(store.load(work)).resolves.toBeUndefined();
    await expect(store.load(personal)).resolves.toEqual({ accessToken: "personal-token" });
  });
});
