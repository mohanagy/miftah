import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { OAuthConnectionLifecycle, type OAuthCredentialRefresher } from "../src/oauth/connection-lifecycle.js";
import type { OAuthConnectionLifecycleAuditEvent, OAuthConnectionLifecycleAuditSink } from "../src/oauth/audit.js";
import { OAuthConnectionRegistry, type OAuthConnectionMetadataStore, type OAuthConnectionRecord } from "../src/oauth/connection-registry.js";
import {
  createOAuthConfigIdentity,
  createOAuthConnectionBinding,
  parseOAuthConnectionRef,
  type OAuthConnectionBinding
} from "../src/oauth/connection-types.js";
import { PlatformOAuthCredentialStore, type OAuthKeyringAdapter } from "../src/oauth/secure-credential-store.js";
import { SecretRedactor } from "../src/secrets/redact.js";
import { MiftahError } from "../src/utils/errors.js";

const now = "2030-01-02T03:04:05.000Z";

function binding(overrides: Record<string, unknown> = {}) {
  return createOAuthConnectionBinding({
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
}

class MemoryMetadataStore implements OAuthConnectionMetadataStore {
  records: OAuthConnectionRecord[] = [];
  saveCount = 0;
  failOnSave?: number;
  failWhenSaving?: (records: readonly OAuthConnectionRecord[]) => boolean;

  async load(): Promise<readonly OAuthConnectionRecord[]> {
    return [...structuredClone(this.records)];
  }
  async save(records: readonly OAuthConnectionRecord[]): Promise<void> {
    this.saveCount += 1;
    if (this.failOnSave === this.saveCount || this.failWhenSaving?.(records) === true) {
      throw new Error("metadata persistence failed");
    }
    this.records = [...structuredClone(records)];
  }
}

class MemoryKeyringAdapter implements OAuthKeyringAdapter {
  readonly entries = new Map<string, string>();
  failDeletes = false;

  async getPassword(service: string, account: string): Promise<string | undefined> {
    return this.entries.get(`${service}:${account}`);
  }
  async setPassword(service: string, account: string, password: string): Promise<void> {
    this.entries.set(`${service}:${account}`, password);
  }
  async deletePassword(service: string, account: string): Promise<void> {
    if (this.failDeletes) throw new Error("keyring credential deletion failed");
    this.entries.delete(`${service}:${account}`);
  }
}

class MemoryLifecycleAuditSink implements OAuthConnectionLifecycleAuditSink {
  readonly events: OAuthConnectionLifecycleAuditEvent[] = [];

  async record(event: OAuthConnectionLifecycleAuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

class FailingLifecycleAuditSink implements OAuthConnectionLifecycleAuditSink {
  async record(): Promise<void> {
    throw new Error("fixture-access-token audit backend failure");
  }
}

function lifecycle(
  refresher?: OAuthCredentialRefresher,
  timeoutMs = 50,
  audit?: OAuthConnectionLifecycleAuditSink,
  metadataStore = new MemoryMetadataStore(),
  keyring = new MemoryKeyringAdapter()
) {
  const registry = new OAuthConnectionRegistry(metadataStore, () => now);
  const store = new PlatformOAuthCredentialStore(keyring, new SecretRedactor());
  return {
    registry,
    store,
    metadataStore,
    keyring,
    lifecycle: new OAuthConnectionLifecycle({ registry, store, refresher, audit, now: () => new Date(now), refreshTimeoutMs: timeoutMs })
  };
}

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("OAuth connection lifecycle", () => {
  it("emits redacted lifecycle and identity audit events", async () => {
    const audit = new MemoryLifecycleAuditSink();
    const { lifecycle: service } = lifecycle(undefined, 50, audit);
    const expected = binding();

    await service.connect(expected, { accessToken: "fixture-access-token", refreshToken: "fixture-refresh-token" });
    await service.setIdentityState(expected, "verified");
    await service.disconnect(expected);

    expect(audit.events).toEqual([
      expect.objectContaining({
        action: "connect",
        profile: "work",
        upstream: "default",
        credentialState: "connected",
        identityState: "unverified",
        status: "success"
      }),
      expect.objectContaining({
        action: "identity",
        profile: "work",
        upstream: "default",
        credentialState: "connected",
        identityState: "verified",
        status: "success"
      }),
      expect.objectContaining({
        action: "disconnect",
        profile: "work",
        upstream: "default",
        credentialState: "disconnected",
        identityState: "verified",
        status: "success"
      })
    ]);
    expect(JSON.stringify(audit.events)).not.toContain("fixture-access-token");
    expect(JSON.stringify(audit.events)).not.toContain("fixture-refresh-token");
    expect(JSON.stringify(audit.events)).not.toContain(expected.connectionRef);
    expect(JSON.stringify(audit.events)).not.toContain(expected.canonicalResource);
    expect(JSON.stringify(audit.events)).not.toContain(expected.issuer);
  });

  it("treats lifecycle audit observation as non-blocking after a credential state commits", async () => {
    const { lifecycle: service } = lifecycle(undefined, 50, new FailingLifecycleAuditSink());
    const expected = binding();

    await expect(service.connect(expected, { accessToken: "fixture-access-token" })).resolves.toMatchObject({
      credentialState: "connected"
    });
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "connected" });
  });

  it("coalesces exact-binding refreshes and keeps a verified identity state distinct from credentials", async () => {
    let calls = 0;
    const refresher: OAuthCredentialRefresher = {
      async refresh(_binding, credential) {
        calls += 1;
        expect(credential.accessToken).toBe("expired-access-token");
        await delay(5);
        return { accessToken: "rotated-access-token", refreshToken: "rotated-refresh-token", expiresAt: "2030-01-02T04:04:05.000Z" };
      }
    };
    const { lifecycle: service } = lifecycle(refresher);
    const expected = binding();
    await service.connect(expected, {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: "2030-01-02T03:04:04.000Z"
    });
    await service.setIdentityState(expected, "verified");

    const [first, second] = await Promise.all([service.credential(expected), service.credential(expected)]);

    expect(first).toEqual(second);
    expect(first.accessToken).toBe("rotated-access-token");
    expect(calls).toBe(1);
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "connected", identityState: "verified" });
  });

  it("cancels one refresh consumer without cancelling a still-interested consumer", async () => {
    let observedAbort = false;
    const started = deferred<void>();
    const release = deferred<void>();
    const refresher: OAuthCredentialRefresher = {
      async refresh(_binding, _credential, signal) {
        started.resolve();
        signal.addEventListener("abort", () => {
          observedAbort = true;
        });
        await release.promise;
        return { accessToken: "rotated-access-token" };
      }
    };
    const { lifecycle: service } = lifecycle(refresher);
    const expected = binding();
    await service.connect(expected, { accessToken: "expired-access-token", refreshToken: "refresh-token", expiresAt: "2030-01-02T03:04:04.000Z" });
    const active = service.credential(expected);
    await started.promise;
    const controller = new AbortController();
    const cancelled = service.credential(expected, { signal: controller.signal });
    await delay(0);
    controller.abort();
    release.resolve();

    await expect(cancelled).rejects.toMatchObject({ code: "OAUTH_REFRESH_CANCELLED" });
    await expect(active).resolves.toEqual({ accessToken: "rotated-access-token", refreshToken: "refresh-token" });
    expect(observedAbort).toBe(false);
  });

  it("retains refresh, registration, and scope state when a successful refresh omits replacements", async () => {
    const refresher: OAuthCredentialRefresher = {
      async refresh() {
        return { accessToken: "rotated-access-token", expiresAt: "2030-01-02T04:04:05.000Z" };
      }
    };
    const { lifecycle: service, store } = lifecycle(refresher);
    const expected = binding();
    await service.connect(expected, {
      accessToken: "expired-access-token",
      refreshToken: "original-refresh-token",
      expiresAt: "2030-01-02T03:04:04.000Z",
      scopes: ["mcp:tools"],
      clientId: "fixture-client-id",
      clientSecret: "fixture-client-secret"
    });

    await expect(service.credential(expected)).resolves.toMatchObject({ accessToken: "rotated-access-token" });
    await expect(store.load(expected)).resolves.toEqual({
      accessToken: "rotated-access-token",
      refreshToken: "original-refresh-token",
      expiresAt: "2030-01-02T04:04:05.000Z",
      scopes: ["mcp:tools"],
      clientId: "fixture-client-id",
      clientSecret: "fixture-client-secret"
    });
  });

  it("maps a timed-out refresh to a redacted reauthentication state", async () => {
    const refresher: OAuthCredentialRefresher = {
      async refresh(_binding, _credential, signal) {
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("fixture-access-token backend timeout"))));
        return { accessToken: "unreachable" };
      }
    };
    const { lifecycle: service } = lifecycle(refresher, 5);
    const expected = binding();
    await service.connect(expected, { accessToken: "expired-access-token", refreshToken: "refresh-token", expiresAt: "2030-01-02T03:04:04.000Z" });
    let failure: unknown;
    try {
      await service.credential(expected);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "OAUTH_REFRESH_TIMEOUT" });
    expect((failure as Error).message).not.toContain("fixture-access-token");
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "reauth-required" });
  });

  it("marks a missing credential as requiring reauthentication and disconnects only its exact binding", async () => {
    const { lifecycle: service } = lifecycle();
    const work = binding();
    const personal = binding({
      connectionRef: "oauthconn:1d915a13-f8a5-45e0-8343-1e82e0939129",
      profile: "personal"
    });
    await service.register(work);
    await expect(service.credential(work)).rejects.toMatchObject({ code: "OAUTH_REAUTH_REQUIRED" });
    await service.connect(personal, { accessToken: "personal-access-token" });
    await service.disconnect(personal);

    await expect(service.status(work)).resolves.toMatchObject({ credentialState: "reauth-required" });
    await expect(service.status(personal)).resolves.toMatchObject({ credentialState: "disconnected" });
  });

  it("does not wait for a refresher that ignores abort and removes only the failed binding's credential", async () => {
    const neverSettles = new Promise<never>(() => undefined);
    const refresher: OAuthCredentialRefresher = {
      async refresh() {
        return neverSettles;
      }
    };
    const { lifecycle: service, store } = lifecycle(refresher, 5);
    const failed = binding();
    const unaffected = binding({
      connectionRef: "oauthconn:1d915a13-f8a5-45e0-8343-1e82e0939129",
      profile: "personal"
    });
    await service.connect(failed, { accessToken: "failed-access-token", refreshToken: "failed-refresh-token", expiresAt: "2030-01-02T03:04:04.000Z" });
    await service.connect(unaffected, { accessToken: "personal-access-token" });

    await expect(service.credential(failed)).rejects.toMatchObject({ code: "OAUTH_REFRESH_TIMEOUT" });
    await expect(service.status(failed)).resolves.toMatchObject({ credentialState: "reauth-required" });
    await expect(store.load(failed)).resolves.toBeUndefined();
    await expect(store.load(unaffected)).resolves.toEqual({ accessToken: "personal-access-token" });
  });

  it("sanitizes a refresher failure and clears the exact stale credential", async () => {
    const refresher: OAuthCredentialRefresher = {
      async refresh() {
        throw new MiftahError("UPSTREAM_START_FAILED", "fixture-refresh-token provider failure", { token: "fixture-refresh-token" });
      }
    };
    const { lifecycle: service, store } = lifecycle(refresher);
    const expected = binding();
    await service.connect(expected, { accessToken: "fixture-access-token", refreshToken: "fixture-refresh-token", expiresAt: "2030-01-02T03:04:04.000Z" });

    let failure: unknown;
    try {
      await service.credential(expected);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "OAUTH_REAUTH_REQUIRED" });
    expect((failure as Error).message).not.toContain("fixture-refresh-token");
    await expect(store.load(expected)).resolves.toBeUndefined();
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "reauth-required" });
  });

  it("clears an exact vault credential when connect cannot persist its metadata", async () => {
    const metadataStore = new MemoryMetadataStore();
    metadataStore.failOnSave = 2;
    const { lifecycle: service, store } = lifecycle(undefined, 50, undefined, metadataStore);
    const expected = binding();

    await expect(service.connect(expected, { accessToken: "fixture-access-token" })).rejects.toMatchObject({
      code: "OAUTH_CONNECTION_INVALID"
    });
    await expect(store.load(expected)).resolves.toBeUndefined();

    metadataStore.failOnSave = undefined;
    await expect(service.credential(expected)).rejects.toMatchObject({ code: "OAUTH_REAUTH_REQUIRED" });
  });

  it("does not revive an orphaned vault credential after failed connect compensation", async () => {
    const metadataStore = new MemoryMetadataStore();
    metadataStore.failOnSave = 2;
    const keyring = new MemoryKeyringAdapter();
    keyring.failDeletes = true;
    const { lifecycle: service, store } = lifecycle(undefined, 50, undefined, metadataStore, keyring);
    const expected = binding();

    await expect(service.connect(expected, { accessToken: "orphaned-access-token" })).rejects.toMatchObject({
      code: "OAUTH_SECURE_STORE_UNAVAILABLE"
    });
    await expect(store.load(expected)).resolves.toEqual({ accessToken: "orphaned-access-token" });

    metadataStore.failOnSave = undefined;
    await expect(service.credential(expected)).rejects.toMatchObject({ code: "OAUTH_REAUTH_REQUIRED" });
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "disconnected" });
  });

  it("does not promote an orphaned refreshed credential after its final metadata commit fails", async () => {
    const refreshedExpiry = "2030-01-02T04:04:05.000Z";
    const refresher: OAuthCredentialRefresher = {
      async refresh() {
        return { accessToken: "orphaned-refreshed-access-token", expiresAt: refreshedExpiry };
      }
    };
    const metadataStore = new MemoryMetadataStore();
    const keyring = new MemoryKeyringAdapter();
    keyring.failDeletes = true;
    const { lifecycle: service, store } = lifecycle(refresher, 50, undefined, metadataStore, keyring);
    const expected = binding();
    await service.connect(expected, {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: "2030-01-02T03:04:04.000Z"
    });
    metadataStore.failWhenSaving = (records) =>
      records.some(
        (record) => record.binding.connectionRef === expected.connectionRef && record.credentialState === "connected" && record.expiresAt === refreshedExpiry
      );

    await expect(service.credential(expected)).rejects.toMatchObject({ code: "OAUTH_SECURE_STORE_UNAVAILABLE" });
    await expect(store.load(expected)).resolves.toEqual({
      accessToken: "orphaned-refreshed-access-token",
      refreshToken: "refresh-token",
      expiresAt: refreshedExpiry
    });

    metadataStore.failWhenSaving = undefined;
    await expect(service.credential(expected)).rejects.toMatchObject({ code: "OAUTH_REAUTH_REQUIRED" });
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "reauth-required" });
  });

  it("does not revive a credential when disconnect cannot delete its vault entry", async () => {
    const keyring = new MemoryKeyringAdapter();
    keyring.failDeletes = true;
    const { lifecycle: service, store } = lifecycle(undefined, 50, undefined, undefined, keyring);
    const expected = binding();
    await service.connect(expected, { accessToken: "orphaned-disconnect-access-token" });

    await expect(service.disconnect(expected)).rejects.toMatchObject({ code: "OAUTH_SECURE_STORE_UNAVAILABLE" });
    await expect(store.load(expected)).resolves.toEqual({ accessToken: "orphaned-disconnect-access-token" });
    await expect(service.credential(expected)).rejects.toMatchObject({ code: "OAUTH_REAUTH_REQUIRED" });
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "disconnected" });
  });

  it("does not let an already queued refresh revive a disconnected connection", async () => {
    let refreshes = 0;
    const refresher: OAuthCredentialRefresher = {
      async refresh() {
        refreshes += 1;
        return { accessToken: "unexpected-refreshed-access-token" };
      }
    };
    const { lifecycle: service, store } = lifecycle(refresher);
    const expected = binding();
    await service.register(expected);
    await store.save(expected, {
      accessToken: "orphaned-expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: "2030-01-02T03:04:04.000Z"
    });
    const refresh = (
      service as unknown as {
        refresh(binding: OAuthConnectionBinding, generation: number, controller: AbortController): Promise<unknown>;
      }
    ).refresh.bind(service);

    await expect(refresh(expected, 0, new AbortController())).rejects.toMatchObject({ code: "OAUTH_REFRESH_CANCELLED" });
    expect(refreshes).toBe(0);
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "disconnected" });
  });

  it("records reauthentication before a failed terminal vault cleanup", async () => {
    const refresher: OAuthCredentialRefresher = {
      async refresh() {
        throw new Error("refresh authorization was rejected");
      }
    };
    const keyring = new MemoryKeyringAdapter();
    keyring.failDeletes = true;
    const { lifecycle: service } = lifecycle(refresher, 50, undefined, undefined, keyring);
    const expected = binding();
    await service.connect(expected, {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: "2030-01-02T03:04:04.000Z"
    });

    await expect(service.credential(expected)).rejects.toMatchObject({ code: "OAUTH_SECURE_STORE_UNAVAILABLE" });
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "reauth-required" });
  });

  it("clears an exact refreshed vault credential when refreshed metadata cannot persist", async () => {
    const refresher: OAuthCredentialRefresher = {
      async refresh() {
        return { accessToken: "rotated-access-token", refreshToken: "rotated-refresh-token" };
      }
    };
    const metadataStore = new MemoryMetadataStore();
    const { lifecycle: service, store } = lifecycle(refresher, 50, undefined, metadataStore);
    const expected = binding();
    await service.connect(expected, {
      accessToken: "expired-access-token",
      refreshToken: "original-refresh-token",
      expiresAt: "2030-01-02T03:04:04.000Z"
    });
    metadataStore.failWhenSaving = (records) =>
      records.some(
        (record) =>
          record.binding.connectionRef === expected.connectionRef &&
          record.credentialState === "connected" &&
          record.expiresAt === undefined
      );

    await expect(service.credential(expected)).rejects.toMatchObject({ code: "OAUTH_CONNECTION_INVALID" });
    await expect(store.load(expected)).resolves.toBeUndefined();
  });

  it("does not let a late refresh undo an explicit disconnect", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const refresher: OAuthCredentialRefresher = {
      async refresh() {
        started.resolve();
        await release.promise;
        return { accessToken: "late-rotated-token" };
      }
    };
    const { lifecycle: service, store } = lifecycle(refresher);
    const expected = binding();
    await service.connect(expected, { accessToken: "expired-access-token", refreshToken: "refresh-token", expiresAt: "2030-01-02T03:04:04.000Z" });
    const refresh = service.credential(expected);
    await started.promise;
    const disconnect = service.disconnect(expected);
    release.resolve();

    await expect(refresh).rejects.toMatchObject({ code: "OAUTH_REFRESH_CANCELLED" });
    await disconnect;
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "disconnected" });
    await expect(store.load(expected)).resolves.toBeUndefined();
  });

  it("does not let a queued credential request resurrect a disconnected connection", async () => {
    let refreshes = 0;
    const refresher: OAuthCredentialRefresher = {
      async refresh() {
        refreshes += 1;
        return { accessToken: "unexpected-rotated-token" };
      }
    };
    const { lifecycle: service, store } = lifecycle(refresher);
    const expected = binding();
    await service.connect(expected, {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: "2030-01-02T03:04:04.000Z"
    });

    const staleCredential = service.credential(expected);
    const disconnected = service.disconnect(expected);

    await expect(staleCredential).rejects.toMatchObject({ code: "OAUTH_REFRESH_CANCELLED" });
    await disconnected;
    expect(refreshes).toBe(0);
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "disconnected" });
    await expect(store.load(expected)).resolves.toBeUndefined();
  });

  it("does not let a queued credential request overwrite a replacement connection", async () => {
    let refreshes = 0;
    const refresher: OAuthCredentialRefresher = {
      async refresh() {
        refreshes += 1;
        return { accessToken: "unexpected-rotated-token" };
      }
    };
    const { lifecycle: service, store } = lifecycle(refresher);
    const expected = binding();
    await service.connect(expected, {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: "2030-01-02T03:04:04.000Z"
    });

    const staleCredential = service.credential(expected);
    const replacement = service.connect(expected, { accessToken: "replacement-access-token" });

    await expect(staleCredential).rejects.toMatchObject({ code: "OAUTH_REFRESH_CANCELLED" });
    await replacement;
    expect(refreshes).toBe(0);
    await expect(store.load(expected)).resolves.toEqual({ accessToken: "replacement-access-token" });
    await expect(service.status(expected)).resolves.toMatchObject({ credentialState: "connected" });
  });

  it("serializes refresh lifecycle transactions across independent connection lifecycles", async () => {
    const firstStarted = deferred<void>();
    const firstRelease = deferred<void>();
    const secondRelease = deferred<void>();
    let firstRefreshes = 0;
    let secondRefreshes = 0;
    const metadata = new MemoryMetadataStore();
    const registry = new OAuthConnectionRegistry(metadata, () => now);
    const store = new PlatformOAuthCredentialStore(new MemoryKeyringAdapter(), new SecretRedactor());
    const first = new OAuthConnectionLifecycle({
      registry,
      store,
      now: () => new Date(now),
      refresher: {
        async refresh() {
          firstRefreshes += 1;
          firstStarted.resolve();
          await firstRelease.promise;
          return { accessToken: "winner-access-token", refreshToken: "winner-refresh-token" };
        }
      }
    });
    const second = new OAuthConnectionLifecycle({
      registry: new OAuthConnectionRegistry(metadata, () => now),
      store,
      now: () => new Date(now),
      refresher: {
        async refresh() {
          secondRefreshes += 1;
          await secondRelease.promise;
          throw new Error("fixture-refresh-token loser failure");
        }
      }
    });
    const expected = binding();
    await first.connect(expected, {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: "2030-01-02T03:04:04.000Z"
    });

    const winner = first.credential(expected);
    await firstStarted.promise;
    const follower = second.credential(expected);
    await delay(0);
    firstRelease.resolve();

    await expect(winner).resolves.toEqual({ accessToken: "winner-access-token", refreshToken: "winner-refresh-token" });
    secondRelease.resolve();
    await expect(follower).resolves.toEqual({ accessToken: "winner-access-token", refreshToken: "winner-refresh-token" });
    expect(firstRefreshes).toBe(1);
    expect(secondRefreshes).toBe(0);
    await expect(store.load(expected)).resolves.toEqual({
      accessToken: "winner-access-token",
      refreshToken: "winner-refresh-token"
    });
    await expect(second.status(expected)).resolves.toMatchObject({ credentialState: "connected" });
  });
});
