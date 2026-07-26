import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthConnectionRegistry } from "../src/oauth/connection-registry.js";
import {
  createOAuthConfigIdentity,
  createOAuthConnectionBinding,
  parseOAuthConnectionRef
} from "../src/oauth/connection-types.js";
import {
  canonicalOAuthProfileRenameConfigPath,
  FileOAuthProfileRenameJournalStore,
  oauthProfileRenameJournalPath,
  recoverOAuthProfileRename,
  runOAuthProfileRenameTransaction,
  type OAuthProfileRenameJournal
} from "../src/oauth/profile-rename-transaction.js";
import { readConfigMigrationSource } from "../src/cli/migrate-config.js";
import { planProfileRename, runProfileRename } from "../src/setup/profile-rename-onboarding.js";
import { MiftahError } from "../src/utils/errors.js";
import {
  MemoryProfileRenameCredentialStore as MemoryCredentialStore,
  MemoryProfileRenameMetadataStore as MemoryMetadataStore
} from "./helpers/profile-rename-oauth-dependencies.js";

const directories: string[] = [];
const connectionRef = "oauthconn:11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function binding(configPath: string, profile: string, reference = connectionRef) {
  return createOAuthConnectionBinding({
    configIdentity: createOAuthConfigIdentity(configPath),
    connectionRef: parseOAuthConnectionRef(reference),
    profile,
    upstream: "default",
    resource: "https://mcp.example.com/mcp",
    issuer: "https://auth.example.com",
    clientRegistration: "dynamic",
    scopes: ["openid"]
  });
}

async function writeOAuthConfig(configPath: string): Promise<void> {
  await writeFile(configPath, `${JSON.stringify({
    version: "3",
    name: "remote-analytics",
    defaultProfile: "work",
    upstream: { transport: "streamable-http", url: "https://mcp.example.com/mcp" },
    profiles: { work: {}, personal: {} },
    oauth: {
      connections: {
        [connectionRef]: {
          profile: "work",
          upstream: "default",
          resource: "https://mcp.example.com/mcp",
          issuer: "https://auth.example.com",
          clientRegistration: "dynamic",
          scopes: ["openid"]
        }
      }
    }
  }, null, 2)}\n`, { mode: 0o600 });
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("native OAuth profile rename transaction", () => {
  it("rejects an unrecoverable journal binding count before touching config, vault, or durable state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-too-many-bindings-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const originalBytes = await readFile(configPath);
    const source = await readConfigMigrationSource(configPath);
    const candidate = planProfileRename(JSON.parse(originalBytes.toString("utf8")), {
      configPath,
      profile: "work",
      newProfile: "studio"
    }).config;
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const credentials = new MemoryCredentialStore();
    const registry = new OAuthConnectionRegistry(new MemoryMetadataStore(), () => "2030-01-02T03:04:05.000Z");
    const create = vi.fn(async () => undefined);
    const journalStore = { load: async () => undefined, create, remove: async () => undefined };
    const bindings = Array.from({ length: 129 }, () => {
      const reference = `oauthconn:${randomUUID()}`;
      return {
        from: binding(canonicalConfigPath, "work", reference),
        to: binding(canonicalConfigPath, "studio", reference)
      };
    });

    await expect(runOAuthProfileRenameTransaction(
      { configPath, source, candidate, bindings },
      { credentialStore: credentials, registry, journalStore }
    )).rejects.toMatchObject({ code: "OAUTH_CONNECTION_INVALID" });

    expect(create).not.toHaveBeenCalled();
    expect(credentials.entries).toEqual(new Map());
    await expect(readFile(configPath)).resolves.toEqual(originalBytes);
  });

  it("does not persist a journal whose valid bindings exceed the recovery byte limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-oversized-journal-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const oversizedScopes = Array.from({ length: 64 }, () => "x".repeat(256));
    const journal: OAuthProfileRenameJournal = {
      version: 1,
      configIdentity: createOAuthConfigIdentity(canonicalConfigPath),
      sourceHash: hash(Buffer.from("source")),
      targetHash: hash(Buffer.from("target")),
      auditRequired: false,
      sourceBackupPath: join(dirname(canonicalConfigPath), ".remote-analytics.json.miftah-oauth-profile-rename-source-oversized"),
      bindings: Array.from({ length: 128 }, () => {
        const reference = `oauthconn:${randomUUID()}`;
        const from = { ...binding(canonicalConfigPath, "work", reference), scopes: oversizedScopes };
        const to = { ...binding(canonicalConfigPath, "studio", reference), scopes: oversizedScopes };
        return { from, to, originalCredentialPresent: false };
      })
    };
    const store = new FileOAuthProfileRenameJournalStore();

    await expect(store.create(canonicalConfigPath, journal)).rejects.toMatchObject({ code: "OAUTH_CONNECTION_INVALID" });
    await expect(readFile(oauthProfileRenameJournalPath(canonicalConfigPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate source credential bindings before touching config, vault, or durable state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-duplicate-binding-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const originalBytes = await readFile(configPath);
    const source = await readConfigMigrationSource(configPath);
    const candidate = planProfileRename(JSON.parse(originalBytes.toString("utf8")), {
      configPath,
      profile: "work",
      newProfile: "studio"
    }).config;
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const credentials = new MemoryCredentialStore();
    const registry = new OAuthConnectionRegistry(new MemoryMetadataStore(), () => "2030-01-02T03:04:05.000Z");
    const create = vi.fn(async () => undefined);
    const journalStore = { load: async () => undefined, create, remove: async () => undefined };
    const pair = {
      from: binding(canonicalConfigPath, "work"),
      to: binding(canonicalConfigPath, "studio")
    };

    await expect(runOAuthProfileRenameTransaction(
      { configPath, source, candidate, bindings: [pair, pair] },
      { credentialStore: credentials, registry, journalStore }
    )).rejects.toMatchObject({ code: "OAUTH_CONNECTION_INVALID" });

    expect(create).not.toHaveBeenCalled();
    expect(credentials.entries).toEqual(new Map());
    await expect(readFile(configPath)).resolves.toEqual(originalBytes);
  });

  it("rejects mixed source and target profile pairs before touching config, vault, or durable state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-mixed-profiles-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const originalBytes = await readFile(configPath);
    const source = await readConfigMigrationSource(configPath);
    const candidate = planProfileRename(JSON.parse(originalBytes.toString("utf8")), {
      configPath,
      profile: "work",
      newProfile: "studio"
    }).config;
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const credentials = new MemoryCredentialStore();
    const registry = new OAuthConnectionRegistry(new MemoryMetadataStore(), () => "2030-01-02T03:04:05.000Z");
    const create = vi.fn(async () => undefined);
    const journalStore = { load: async () => undefined, create, remove: async () => undefined };
    const workPair = {
      from: binding(canonicalConfigPath, "work"),
      to: binding(canonicalConfigPath, "studio")
    };
    const personalReference = `oauthconn:${randomUUID()}`;
    const personalPair = {
      from: binding(canonicalConfigPath, "personal", personalReference),
      to: binding(canonicalConfigPath, "studio", personalReference)
    };

    await expect(runOAuthProfileRenameTransaction(
      { configPath, source, candidate, bindings: [workPair, personalPair] },
      { credentialStore: credentials, registry, journalStore }
    )).rejects.toMatchObject({ code: "OAUTH_CONNECTION_INVALID" });

    expect(create).not.toHaveBeenCalled();
    expect(credentials.entries).toEqual(new Map());
    await expect(readFile(configPath)).resolves.toEqual(originalBytes);
  });

  it("moves the exact vault key and non-secret metadata only with the guarded config rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const credentials = new MemoryCredentialStore();
    const metadata = new MemoryMetadataStore();
    const registry = new OAuthConnectionRegistry(metadata, () => "2030-01-02T03:04:05.000Z");
    const oldBinding = binding(canonicalConfigPath, "work");
    const newBinding = binding(canonicalConfigPath, "studio");
    await credentials.save(oldBinding, { accessToken: "fixture-access-token", refreshToken: "fixture-refresh-token" });
    await registry.create(oldBinding);
    await registry.setCredentialState(oldBinding.connectionRef, oldBinding, "connected");
    await registry.setIdentityState(oldBinding.connectionRef, oldBinding, "verified");
    const audit = {
      ensureWritable: vi.fn().mockResolvedValue(undefined),
      intent: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined)
    };

    const report = await runProfileRename(
      { configPath, profile: "work", newProfile: "studio" },
      { audit, oauth: { credentialStore: credentials, registry } }
    );

    expect(report).toMatchObject({ changed: true, profile: "work", newProfile: "studio", write: true });
    expect(JSON.stringify(report)).not.toContain("fixture-access-token");
    await expect(credentials.load(oldBinding)).resolves.toBeUndefined();
    await expect(credentials.load(newBinding)).resolves.toEqual({
      accessToken: "fixture-access-token",
      refreshToken: "fixture-refresh-token"
    });
    await expect(registry.get(newBinding.connectionRef, newBinding)).resolves.toMatchObject({
      credentialState: "connected",
      identityState: "verified"
    });
    await expect(readFile(oauthProfileRenameJournalPath(canonicalConfigPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(audit.intent).toHaveBeenCalledWith({ profile: "work", newProfile: "studio" });
    expect(audit.record).toHaveBeenCalledWith({ profile: "work", newProfile: "studio", status: "success" });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("fixture-refresh-token");
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.oauth.connections[connectionRef].profile).toBe("studio");
  });

  it("fails closed when a recorded metadata binding disappears during forward migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-missing-metadata-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const credentials = new MemoryCredentialStore();
    const metadata = new MemoryMetadataStore();
    const registry = new OAuthConnectionRegistry(metadata, () => "2030-01-02T03:04:05.000Z");
    const oldBinding = binding(canonicalConfigPath, "work");
    const newBinding = binding(canonicalConfigPath, "studio");
    await credentials.save(oldBinding, { accessToken: "fixture-access-token" });
    await registry.create(oldBinding);
    vi.spyOn(registry, "migrateProfileBinding").mockResolvedValue(undefined);

    await expect(runProfileRename(
      { configPath, profile: "work", newProfile: "studio" },
      { oauth: { credentialStore: credentials, registry } }
    )).rejects.toMatchObject({ code: "OAUTH_PROFILE_RENAME_RECOVERY_REQUIRED" });

    await expect(credentials.load(oldBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });
    await expect(credentials.load(newBinding)).resolves.toBeUndefined();
    await expect(registry.get(oldBinding.connectionRef, oldBinding)).resolves.toMatchObject({ binding: oldBinding });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      profiles: { work: {}, personal: {} },
      oauth: { connections: { [connectionRef]: { profile: "work" } } }
    });
  });

  it("rolls back config, vault, and metadata when old-vault retirement fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-rollback-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const credentials = new MemoryCredentialStore();
    credentials.deleteFailure = (binding) => binding.profile === "work"
      ? new Error("forced old-vault deletion failure")
      : undefined;
    const metadata = new MemoryMetadataStore();
    const registry = new OAuthConnectionRegistry(metadata, () => "2030-01-02T03:04:05.000Z");
    const oldBinding = binding(canonicalConfigPath, "work");
    const newBinding = binding(canonicalConfigPath, "studio");
    await credentials.save(oldBinding, { accessToken: "fixture-access-token" });
    await registry.create(oldBinding);
    await registry.setIdentityState(oldBinding.connectionRef, oldBinding, "verified");
    const audit = {
      ensureWritable: vi.fn().mockResolvedValue(undefined),
      intent: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined)
    };

    await expect(runProfileRename(
      { configPath, profile: "work", newProfile: "studio" },
      { audit, oauth: { credentialStore: credentials, registry } }
    )).rejects.toThrow("forced old-vault deletion failure");

    await expect(credentials.load(oldBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });
    await expect(credentials.load(newBinding)).resolves.toBeUndefined();
    await expect(registry.get(oldBinding.connectionRef, oldBinding)).resolves.toMatchObject({ identityState: "verified" });
    await expect(readFile(oauthProfileRenameJournalPath(canonicalConfigPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const restored = JSON.parse(await readFile(configPath, "utf8"));
    expect(restored.profiles).toHaveProperty("work");
    expect(restored.profiles).not.toHaveProperty("studio");
    expect(restored.oauth.connections[connectionRef].profile).toBe("work");
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("restores config, vault, and metadata when required audit finalization fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-audit-rollback-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const credentials = new MemoryCredentialStore();
    const metadata = new MemoryMetadataStore();
    const registry = new OAuthConnectionRegistry(metadata, () => "2030-01-02T03:04:05.000Z");
    const oldBinding = binding(canonicalConfigPath, "work");
    const newBinding = binding(canonicalConfigPath, "studio");
    await credentials.save(oldBinding, { accessToken: "fixture-access-token", refreshToken: "fixture-refresh-token" });
    await registry.create(oldBinding);
    await registry.setIdentityState(oldBinding.connectionRef, oldBinding, "verified");
    const originalMetadata = await registry.snapshot(oldBinding);
    const audit = {
      ensureWritable: vi.fn().mockResolvedValue(undefined),
      intent: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockRejectedValue(new MiftahError("AUDIT_WRITE_FAILED", "fixture audit finalization failure"))
    };

    await expect(runProfileRename(
      { configPath, profile: "work", newProfile: "studio" },
      { audit, oauth: { credentialStore: credentials, registry } }
    )).rejects.toMatchObject({
      code: "AUDIT_WRITE_FAILED",
      message: expect.stringContaining("configuration and OAuth connection state were restored")
    });

    await expect(credentials.load(oldBinding)).resolves.toEqual({
      accessToken: "fixture-access-token",
      refreshToken: "fixture-refresh-token"
    });
    await expect(credentials.load(newBinding)).resolves.toBeUndefined();
    await expect(registry.get(oldBinding.connectionRef, oldBinding)).resolves.toEqual(originalMetadata);
    const restored = JSON.parse(await readFile(configPath, "utf8"));
    expect(restored.oauth.connections[connectionRef].profile).toBe("work");
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("fails closed when journal creation also leaves its private source backup uncleared", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-journal-cleanup-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const credentials = new MemoryCredentialStore();
    const registry = new OAuthConnectionRegistry(new MemoryMetadataStore(), () => "2030-01-02T03:04:05.000Z");
    const audit = { ensureWritable: vi.fn(async () => undefined), intent: vi.fn(async () => undefined), record: vi.fn(async () => undefined) };
    const journalStore = {
      load: async () => undefined,
      create: async (_path: string, journal: OAuthProfileRenameJournal) => {
        await rm(journal.sourceBackupPath, { force: true });
        await mkdir(journal.sourceBackupPath);
        throw new Error("forced journal creation failure");
      },
      remove: async () => undefined
    };

    await expect(runProfileRename(
      { configPath, profile: "work", newProfile: "studio" },
      { audit, oauth: { credentialStore: credentials, registry, journalStore } }
    )).rejects.toMatchObject({ code: "OAUTH_PROFILE_RENAME_RECOVERY_REQUIRED" });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      profiles: { work: {}, personal: {} }
    });
  });

  it("retains the verified source backup when durable journal removal fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-journal-removal-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const originalBytes = await readFile(configPath);
    const credentials = new MemoryCredentialStore();
    const registry = new OAuthConnectionRegistry(new MemoryMetadataStore(), () => "2030-01-02T03:04:05.000Z");
    const oldBinding = binding(canonicalConfigPath, "work");
    await credentials.save(oldBinding, { accessToken: "fixture-access-token" });
    await registry.create(oldBinding);
    const durableJournalStore = new FileOAuthProfileRenameJournalStore();
    let failRemoval = true;
    let sourceBackupPresentWhenJournalRemovalBegan = false;
    const journalStore = {
      load: durableJournalStore.load.bind(durableJournalStore),
      create: durableJournalStore.create.bind(durableJournalStore),
      remove: async (path: string) => {
        if (failRemoval) {
          failRemoval = false;
          const journal = await durableJournalStore.load(path);
          sourceBackupPresentWhenJournalRemovalBegan = journal !== undefined && await readFile(journal.sourceBackupPath)
            .then(() => true)
            .catch(() => false);
          throw new Error("forced journal removal failure");
        }
        await durableJournalStore.remove(path);
      }
    };
    const audit = {
      ensureWritable: vi.fn().mockResolvedValue(undefined),
      intent: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined)
    };

    await expect(runProfileRename(
      { configPath, profile: "work", newProfile: "studio" },
      { audit, oauth: { credentialStore: credentials, registry, journalStore } }
    )).rejects.toMatchObject({ code: "OAUTH_PROFILE_RENAME_RECOVERY_REQUIRED" });

    expect(sourceBackupPresentWhenJournalRemovalBegan).toBe(true);
    const journal = await durableJournalStore.load(canonicalConfigPath);
    expect(journal).toBeDefined();
    await expect(readFile(journal?.sourceBackupPath ?? "")).resolves.toEqual(originalBytes);

    await expect(recoverOAuthProfileRename(
      configPath,
      { credentialStore: credentials, registry, journalStore },
      { finalizeAudit: async () => { throw new Error("forced recovered audit failure"); } }
    )).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    await expect(credentials.load(oldBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      profiles: { work: {}, personal: {} }
    });
  });

  it("finishes a crash-interrupted target configuration from the durable non-secret journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-recovery-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const originalBytes = await readFile(configPath);
    const plan = planProfileRename(JSON.parse(originalBytes.toString("utf8")), {
      configPath,
      profile: "work",
      newProfile: "studio"
    });
    const targetBytes = Buffer.from(`${JSON.stringify(plan.config, null, 2)}\n`);
    const oldBinding = binding(canonicalConfigPath, "work");
    const newBinding = binding(canonicalConfigPath, "studio");
    const credentials = new MemoryCredentialStore();
    const metadata = new MemoryMetadataStore();
    const registry = new OAuthConnectionRegistry(metadata, () => "2030-01-02T03:04:05.000Z");
    await credentials.save(oldBinding, { accessToken: "fixture-access-token" });
    await credentials.save(newBinding, { accessToken: "fixture-access-token" });
    await registry.create(oldBinding);
    await registry.setIdentityState(oldBinding.connectionRef, oldBinding, "verified");
    const sourceBackupPath = join(dirname(canonicalConfigPath), ".remote-analytics.json.miftah-oauth-profile-rename-source-fixture");
    await writeFile(sourceBackupPath, originalBytes, { mode: 0o600 });
    await writeFile(configPath, targetBytes, { mode: 0o600 });
    const journal: OAuthProfileRenameJournal = {
      version: 1,
      configIdentity: createOAuthConfigIdentity(canonicalConfigPath),
      sourceHash: hash(originalBytes),
      targetHash: hash(targetBytes),
      auditRequired: false,
      sourceBackupPath,
      bindings: [{
        from: oldBinding,
        to: newBinding,
        originalCredentialPresent: true,
        originalMetadata: await registry.snapshot(oldBinding)
      }]
    };
    await new FileOAuthProfileRenameJournalStore().create(canonicalConfigPath, journal);

    await expect(recoverOAuthProfileRename(configPath, { credentialStore: credentials, registry })).resolves.toBe(true);

    await expect(credentials.load(oldBinding)).resolves.toBeUndefined();
    await expect(credentials.load(newBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });
    await expect(registry.get(newBinding.connectionRef, newBinding)).resolves.toMatchObject({ identityState: "verified" });
    await expect(readFile(oauthProfileRenameJournalPath(canonicalConfigPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sourceBackupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed instead of following a symbolic-link source backup during recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-symlink-backup-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const originalBytes = await readFile(configPath);
    const plan = planProfileRename(JSON.parse(originalBytes.toString("utf8")), {
      configPath,
      profile: "work",
      newProfile: "studio"
    });
    const targetBytes = Buffer.from(`${JSON.stringify(plan.config, null, 2)}\n`);
    const oldBinding = binding(canonicalConfigPath, "work");
    const newBinding = binding(canonicalConfigPath, "studio");
    const credentials = new MemoryCredentialStore();
    const registry = new OAuthConnectionRegistry(new MemoryMetadataStore(), () => "2030-01-02T03:04:05.000Z");
    await credentials.save(oldBinding, { accessToken: "fixture-access-token" });
    await credentials.save(newBinding, { accessToken: "fixture-access-token" });
    await registry.create(oldBinding);
    const actualSourceBackupPath = join(directory, "actual-source-backup.json");
    const sourceBackupPath = join(dirname(canonicalConfigPath), ".remote-analytics.json.miftah-oauth-profile-rename-source-symlink");
    await writeFile(actualSourceBackupPath, originalBytes, { mode: 0o600 });
    await symlink(actualSourceBackupPath, sourceBackupPath, "file");
    await writeFile(configPath, targetBytes, { mode: 0o600 });
    const journal: OAuthProfileRenameJournal = {
      version: 1,
      configIdentity: createOAuthConfigIdentity(canonicalConfigPath),
      sourceHash: hash(originalBytes),
      targetHash: hash(targetBytes),
      auditRequired: false,
      sourceBackupPath,
      bindings: [{
        from: oldBinding,
        to: newBinding,
        originalCredentialPresent: true,
        originalMetadata: await registry.snapshot(oldBinding)
      }]
    };
    await new FileOAuthProfileRenameJournalStore().create(canonicalConfigPath, journal);

    await expect(recoverOAuthProfileRename(configPath, { credentialStore: credentials, registry }))
      .rejects.toMatchObject({ code: "OAUTH_PROFILE_RENAME_RECOVERY_REQUIRED" });

    expect((await lstat(sourceBackupPath)).isSymbolicLink()).toBe(true);
    await expect(credentials.load(oldBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });
    await expect(credentials.load(newBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });
  });

  it("retains a forward recovery until its required audit finalization can be performed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-audit-recovery-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const originalBytes = await readFile(configPath);
    const plan = planProfileRename(JSON.parse(originalBytes.toString("utf8")), {
      configPath,
      profile: "work",
      newProfile: "studio"
    });
    const targetBytes = Buffer.from(`${JSON.stringify(plan.config, null, 2)}\n`);
    const oldBinding = binding(canonicalConfigPath, "work");
    const newBinding = binding(canonicalConfigPath, "studio");
    const credentials = new MemoryCredentialStore();
    const registry = new OAuthConnectionRegistry(new MemoryMetadataStore(), () => "2030-01-02T03:04:05.000Z");
    await credentials.save(oldBinding, { accessToken: "fixture-access-token" });
    await credentials.save(newBinding, { accessToken: "fixture-access-token" });
    await registry.create(oldBinding);
    const sourceBackupPath = join(dirname(canonicalConfigPath), ".remote-analytics.json.miftah-oauth-profile-rename-source-audit-recovery");
    await writeFile(sourceBackupPath, originalBytes, { mode: 0o600 });
    await writeFile(configPath, targetBytes, { mode: 0o600 });
    const journal: OAuthProfileRenameJournal = {
      version: 1,
      configIdentity: createOAuthConfigIdentity(canonicalConfigPath),
      sourceHash: hash(originalBytes),
      targetHash: hash(targetBytes),
      auditRequired: true,
      sourceBackupPath,
      bindings: [{
        from: oldBinding,
        to: newBinding,
        originalCredentialPresent: true,
        originalMetadata: await registry.snapshot(oldBinding)
      }]
    };
    await new FileOAuthProfileRenameJournalStore().create(canonicalConfigPath, journal);

    await expect(recoverOAuthProfileRename(configPath, { credentialStore: credentials, registry }))
      .rejects.toMatchObject({ code: "OAUTH_PROFILE_RENAME_RECOVERY_REQUIRED" });

    await expect(readFile(oauthProfileRenameJournalPath(canonicalConfigPath), "utf8")).resolves.toContain('"auditRequired":true');
    await expect(credentials.load(oldBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });
    await expect(credentials.load(newBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });

    const finalizeAudit = vi.fn().mockResolvedValue(undefined);
    await expect(recoverOAuthProfileRename(
      configPath,
      { credentialStore: credentials, registry },
      { finalizeAudit }
    )).resolves.toBe(true);
    expect(finalizeAudit).toHaveBeenCalledWith({ profile: "work", newProfile: "studio" });
    await expect(credentials.load(oldBinding)).resolves.toBeUndefined();
    await expect(credentials.load(newBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });
    await expect(readFile(oauthProfileRenameJournalPath(canonicalConfigPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back a forward recovery when its required audit finalization fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-audit-recovery-rollback-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const originalBytes = await readFile(configPath);
    const plan = planProfileRename(JSON.parse(originalBytes.toString("utf8")), {
      configPath,
      profile: "work",
      newProfile: "studio"
    });
    const targetBytes = Buffer.from(`${JSON.stringify(plan.config, null, 2)}\n`);
    const oldBinding = binding(canonicalConfigPath, "work");
    const newBinding = binding(canonicalConfigPath, "studio");
    const credentials = new MemoryCredentialStore();
    const registry = new OAuthConnectionRegistry(new MemoryMetadataStore(), () => "2030-01-02T03:04:05.000Z");
    await credentials.save(oldBinding, { accessToken: "fixture-access-token" });
    await credentials.save(newBinding, { accessToken: "fixture-access-token" });
    await registry.create(oldBinding);
    const sourceBackupPath = join(dirname(canonicalConfigPath), ".remote-analytics.json.miftah-oauth-profile-rename-source-audit-recovery-rollback");
    await writeFile(sourceBackupPath, originalBytes, { mode: 0o600 });
    await writeFile(configPath, targetBytes, { mode: 0o600 });
    const journal: OAuthProfileRenameJournal = {
      version: 1,
      configIdentity: createOAuthConfigIdentity(canonicalConfigPath),
      sourceHash: hash(originalBytes),
      targetHash: hash(targetBytes),
      auditRequired: true,
      sourceBackupPath,
      bindings: [{
        from: oldBinding,
        to: newBinding,
        originalCredentialPresent: true,
        originalMetadata: await registry.snapshot(oldBinding)
      }]
    };
    await new FileOAuthProfileRenameJournalStore().create(canonicalConfigPath, journal);

    await expect(recoverOAuthProfileRename(
      configPath,
      { credentialStore: credentials, registry },
      { finalizeAudit: async () => { throw new Error("forced recovered audit failure"); } }
    )).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });

    await expect(credentials.load(oldBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });
    await expect(credentials.load(newBinding)).resolves.toBeUndefined();
    await expect(registry.get(oldBinding.connectionRef, oldBinding)).resolves.toMatchObject({ binding: oldBinding });
    await expect(readFile(configPath)).resolves.toEqual(originalBytes);
    await expect(readFile(oauthProfileRenameJournalPath(canonicalConfigPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed rather than touching a journal binding from another configuration identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-foreign-binding-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const originalBytes = await readFile(configPath);
    const plan = planProfileRename(JSON.parse(originalBytes.toString("utf8")), {
      configPath,
      profile: "work",
      newProfile: "studio"
    });
    const targetBytes = Buffer.from(`${JSON.stringify(plan.config, null, 2)}\n`);
    const foreignConfigPath = join(directory, "other-config.json");
    const foreignOldBinding = binding(foreignConfigPath, "work");
    const foreignNewBinding = binding(foreignConfigPath, "studio");
    const credentials = new MemoryCredentialStore();
    const registry = new OAuthConnectionRegistry(new MemoryMetadataStore(), () => "2030-01-02T03:04:05.000Z");
    await credentials.save(foreignOldBinding, { accessToken: "foreign-fixture-access-token" });
    await credentials.save(foreignNewBinding, { accessToken: "foreign-fixture-access-token" });
    await registry.create(foreignOldBinding);
    const sourceBackupPath = join(dirname(canonicalConfigPath), ".remote-analytics.json.miftah-oauth-profile-rename-source-foreign-binding");
    await writeFile(sourceBackupPath, originalBytes, { mode: 0o600 });
    await writeFile(configPath, targetBytes, { mode: 0o600 });
    const journal: OAuthProfileRenameJournal = {
      version: 1,
      configIdentity: createOAuthConfigIdentity(canonicalConfigPath),
      sourceHash: hash(originalBytes),
      targetHash: hash(targetBytes),
      auditRequired: false,
      sourceBackupPath,
      bindings: [{
        from: foreignOldBinding,
        to: foreignNewBinding,
        originalCredentialPresent: true,
        originalMetadata: await registry.snapshot(foreignOldBinding)
      }]
    };
    await new FileOAuthProfileRenameJournalStore().create(canonicalConfigPath, journal);

    await expect(recoverOAuthProfileRename(configPath, { credentialStore: credentials, registry }))
      .rejects.toMatchObject({ code: "OAUTH_PROFILE_RENAME_RECOVERY_REQUIRED" });

    await expect(credentials.load(foreignOldBinding)).resolves.toEqual({ accessToken: "foreign-fixture-access-token" });
    await expect(credentials.load(foreignNewBinding)).resolves.toEqual({ accessToken: "foreign-fixture-access-token" });
  });

  it("reverses a crash-interrupted source configuration without losing the original metadata snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-source-recovery-"));
    directories.push(directory);
    const configPath = join(directory, "remote-analytics.json");
    await writeOAuthConfig(configPath);
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const originalBytes = await readFile(configPath);
    const plan = planProfileRename(JSON.parse(originalBytes.toString("utf8")), {
      configPath,
      profile: "work",
      newProfile: "studio"
    });
    const oldBinding = binding(canonicalConfigPath, "work");
    const newBinding = binding(canonicalConfigPath, "studio");
    const credentials = new MemoryCredentialStore();
    const metadata = new MemoryMetadataStore();
    const registry = new OAuthConnectionRegistry(metadata, () => "2030-01-02T03:04:05.000Z");
    await credentials.save(oldBinding, { accessToken: "fixture-access-token" });
    await credentials.save(newBinding, { accessToken: "fixture-access-token" });
    await registry.create(oldBinding);
    await registry.setCredentialState(oldBinding.connectionRef, oldBinding, "expiring", "2030-01-03T03:04:05.000Z");
    await registry.setIdentityState(oldBinding.connectionRef, oldBinding, "verified");
    const originalMetadata = await registry.snapshot(oldBinding);
    await registry.migrateProfileBinding(oldBinding, newBinding);
    const sourceBackupPath = join(dirname(canonicalConfigPath), ".remote-analytics.json.miftah-oauth-profile-rename-source-fixture");
    await writeFile(sourceBackupPath, originalBytes, { mode: 0o600 });
    const targetBytes = Buffer.from(`${JSON.stringify(plan.config, null, 2)}\n`);
    const journal: OAuthProfileRenameJournal = {
      version: 1,
      configIdentity: createOAuthConfigIdentity(canonicalConfigPath),
      sourceHash: hash(originalBytes),
      targetHash: hash(targetBytes),
      auditRequired: false,
      sourceBackupPath,
      bindings: [{
        from: oldBinding,
        to: newBinding,
        originalCredentialPresent: true,
        originalMetadata
      }]
    };
    await new FileOAuthProfileRenameJournalStore().create(canonicalConfigPath, journal);

    await expect(recoverOAuthProfileRename(configPath, { credentialStore: credentials, registry })).resolves.toBe(true);

    await expect(credentials.load(oldBinding)).resolves.toEqual({ accessToken: "fixture-access-token" });
    await expect(credentials.load(newBinding)).resolves.toBeUndefined();
    await expect(registry.get(oldBinding.connectionRef, oldBinding)).resolves.toEqual(originalMetadata);
    await expect(readFile(oauthProfileRenameJournalPath(canonicalConfigPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
