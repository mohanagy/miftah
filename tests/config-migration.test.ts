import { access, chmod, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const migrationRace = vi.hoisted(() => ({
  configPath: undefined as string | undefined,
  concurrentBytes: undefined as Buffer | undefined,
  sourceBytesBeforeMove: undefined as Buffer | undefined,
  sourceMtimeBeforeMove: undefined as Date | undefined,
  failCandidateLink: false,
  failedCandidateLink: false,
  backupLinked: false,
  holdingPath: undefined as string | undefined,
  mutateHeldAfterPublish: undefined as Buffer | undefined,
  mutatedHeldAfterPublish: false,
  replacementTargetAfterPublish: undefined as Buffer | undefined,
  replacedPublishedTarget: false,
  triggered: false
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>): Promise<void> => {
      const [from, to] = args;
      const isSourceMove =
        typeof from === "string" &&
        from === migrationRace.configPath &&
        typeof to === "string" &&
        to.endsWith(".miftah-migrate-hold");
      if (isSourceMove && migrationRace.sourceBytesBeforeMove !== undefined) {
        await actual.writeFile(from, migrationRace.sourceBytesBeforeMove);
        if (migrationRace.sourceMtimeBeforeMove !== undefined) {
          await actual.utimes(from, migrationRace.sourceMtimeBeforeMove, migrationRace.sourceMtimeBeforeMove);
        }
      }
      await actual.rename(...args);
      if (isSourceMove) {
        migrationRace.holdingPath = to;
        if (migrationRace.concurrentBytes !== undefined) {
          await actual.writeFile(from, migrationRace.concurrentBytes, { flag: "wx" });
          migrationRace.triggered = true;
        }
      }
    },
    link: async (...args: Parameters<typeof actual.link>): Promise<void> => {
      const [existingPath, newPath] = args;
      if (
        typeof existingPath === "string" &&
        existingPath.endsWith("backup.miftah-migrate.tmp") &&
        typeof newPath === "string" &&
        newPath === `${migrationRace.configPath}.bak`
      ) {
        migrationRace.backupLinked = true;
      }
      if (
        migrationRace.failCandidateLink &&
        typeof existingPath === "string" &&
        existingPath.endsWith(".miftah-migrate.tmp") &&
        typeof newPath === "string" &&
        newPath === migrationRace.configPath
      ) {
        migrationRace.failedCandidateLink = true;
        const error = Object.assign(new Error("simulated atomic publish failure"), { code: "EPERM" });
        throw error;
      }
      await actual.link(...args);
      if (
        typeof existingPath === "string" &&
        existingPath.endsWith(".miftah-migrate.tmp") &&
        typeof newPath === "string" &&
        newPath === migrationRace.configPath &&
        migrationRace.mutateHeldAfterPublish !== undefined &&
        migrationRace.holdingPath !== undefined
      ) {
        await actual.writeFile(migrationRace.holdingPath, migrationRace.mutateHeldAfterPublish);
        migrationRace.mutatedHeldAfterPublish = true;
      }
      if (
        typeof existingPath === "string" &&
        existingPath.endsWith(".miftah-migrate.tmp") &&
        typeof newPath === "string" &&
        newPath === migrationRace.configPath &&
        migrationRace.replacementTargetAfterPublish !== undefined
      ) {
        await actual.unlink(newPath);
        await actual.writeFile(newPath, migrationRace.replacementTargetAfterPublish, { flag: "wx" });
        migrationRace.replacedPublishedTarget = true;
      }
    }
  };
});
import {
  applyConfigMigration,
  readConfigMigrationSource,
  runMigrateConfigCommand
} from "../src/cli/migrate-config.js";
import { planConfigMigration } from "../src/config/migrate-config.js";
import { loadConfig } from "../src/config/load-config.js";
import { validateConfig } from "../src/config/validate-config.js";

describe("config migration planning", () => {
  it("upgrades a v1 compatibility declaration to canonical v2 without exposing a raw diff", () => {
    const plan = planConfigMigration({
      version: "1",
      name: "legacy-wrapper",
      defaultProfile: "default",
      upstream: { transport: "http", url: "https://mcp.example.test" },
      profiles: { default: {} },
      security: { allowPlaintextSecrets: true, redactSecrets: true },
      audit: { redact: true }
    });

    expect(plan).toMatchObject({
      fromVersion: "1",
      toVersion: "2",
      changed: true,
      actions: expect.arrayContaining([
        expect.stringContaining("streamable-http"),
        expect.stringContaining("secrets.allowPlaintextSecrets"),
        expect.stringContaining("redaction")
      ])
    });
    expect(validateConfig(plan.config)).toMatchObject({
      version: "2",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test" },
      secrets: { allowPlaintextSecrets: true }
    });
    expect(plan.config).not.toHaveProperty("security.allowPlaintextSecrets");
    expect(plan.config).not.toHaveProperty("security.redactSecrets");
    expect(plan.config).not.toHaveProperty("audit.redact");
  });

  it("fails closed when legacy and canonical plaintext-secret settings disagree", () => {
    let error: unknown;
    try {
      planConfigMigration({
        version: "1",
        name: "conflicting-wrapper",
        defaultProfile: "default",
        upstream: { transport: "stdio", command: "node" },
        profiles: { default: {} },
        security: { allowPlaintextSecrets: true },
        secrets: { allowPlaintextSecrets: false }
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "CONFIG_MIGRATION_CONFLICT" });
  });

  it("fails closed instead of replacing a malformed canonical secrets value", () => {
    let error: unknown;
    try {
      planConfigMigration({
        version: "1",
        name: "malformed-secrets-wrapper",
        defaultProfile: "default",
        upstream: { transport: "stdio", command: "node" },
        profiles: { default: {} },
        security: { allowPlaintextSecrets: true },
        secrets: "unexpected"
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "CONFIG_MIGRATION_CONFLICT" });
  });

  it("does not retain mutable nested JSON values from the v1 input", () => {
    const input = {
      version: "1",
      name: "isolated-migration-input",
      defaultProfile: "default",
      upstreams: {
        remote: { transport: "http", url: "https://mcp.example.test" }
      },
      profiles: {
        default: {
          identity: {
            expected: { organization: "example" },
            probe: { tool: "identity", resultFormat: "json" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write"]
          }
        }
      }
    };

    const plan = planConfigMigration(input);
    const migrated = plan.config as {
      profiles: { default: { identity: { requiredForRisk: string[] } } };
      upstreams: { remote: { transport: string } };
    };
    migrated.profiles.default.identity.requiredForRisk.push("destructive");

    expect(input).toMatchObject({
      version: "1",
      profiles: { default: { identity: { requiredForRisk: ["write"] } } },
      upstreams: { remote: { transport: "http" } }
    });
    expect(migrated).toMatchObject({ upstreams: { remote: { transport: "streamable-http" } } });
  });

  it("retains supported security settings while moving the legacy plaintext-secret opt-in", () => {
    const plan = planConfigMigration({
      version: "1",
      name: "retained-security-setting",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node" },
      profiles: { default: {} },
      security: { allowPlaintextSecrets: true, allowProfileSwitchingFromMcp: true }
    });

    expect(plan.config).toMatchObject({
      security: { allowProfileSwitchingFromMcp: true },
      secrets: { allowPlaintextSecrets: true }
    });
  });

  it("rejects input versions outside the explicit v1-to-v2 migration path", () => {
    expect(() => planConfigMigration({ version: "3" })).toThrow(
      /UNSUPPORTED_CONFIG_VERSION: migrate-config supports version 1 input and version 2 output only/u
    );
  });

  it("rejects non-object migration input before attempting compatibility conversion", () => {
    expect(() => planConfigMigration(null)).toThrow(/CONFIG_SCHEMA_INVALID: config migration requires a JSON object/u);
  });
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  migrationRace.configPath = undefined;
  migrationRace.concurrentBytes = undefined;
  migrationRace.sourceBytesBeforeMove = undefined;
  migrationRace.sourceMtimeBeforeMove = undefined;
  migrationRace.failCandidateLink = false;
  migrationRace.failedCandidateLink = false;
  migrationRace.backupLinked = false;
  migrationRace.holdingPath = undefined;
  migrationRace.mutateHeldAfterPublish = undefined;
  migrationRace.mutatedHeldAfterPublish = false;
  migrationRace.replacementTargetAfterPublish = undefined;
  migrationRace.replacedPublishedTarget = false;
  migrationRace.triggered = false;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function legacyConfig() {
  return {
    version: "1",
    name: "legacy-wrapper",
    defaultProfile: "default",
    upstream: { transport: "http", url: "https://mcp.example.test" },
    profiles: { default: { env: { TOKEN: "migration-secret-sentinel" } } },
    security: { allowPlaintextSecrets: false, redactSecrets: true },
    audit: { redact: true }
  };
}

describe("migrate-config command", () => {
  it("keeps a dry run side-effect free and writes only a safe plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    await writeFile(configPath, original, "utf8");

    const report = await runMigrateConfigCommand({ configPath });

    expect(report).toMatchObject({
      fromVersion: "1",
      toVersion: "2",
      changed: true,
      write: false,
      backupCreated: false
    });
    expect(JSON.stringify(report)).not.toContain("migration-secret-sentinel");
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates an exact backup and preserves file mode before non-overwriting publication of a validated migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    await writeFile(configPath, original, "utf8");
    if (process.platform !== "win32") await chmod(configPath, 0o640);

    const report = await runMigrateConfigCommand({ configPath, write: true });

    expect(report).toMatchObject({ changed: true, write: true, backupCreated: true });
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(original);
    const migrated = JSON.parse(await readFile(configPath, "utf8"));
    expect(validateConfig(migrated)).toMatchObject({ version: "2" });
    expect(migrated).not.toHaveProperty("security.allowPlaintextSecrets");
    expect(migrated).not.toHaveProperty("audit.redact");
    if (process.platform !== "win32") expect((await stat(configPath)).mode & 0o777).toBe(0o640);
    expect((await readdir(directory)).some((entry) => entry.startsWith(".miftah.json.miftah-migrate-"))).toBe(false);
  });

  it("publishes the byte-exact backup from the private transaction directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    await writeFile(configPath, original, "utf8");
    migrationRace.configPath = configPath;

    await runMigrateConfigCommand({ configPath, write: true });

    expect(migrationRace.backupLinked).toBe(true);
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(original);
  });

  it("refuses an existing backup without changing the source configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    await writeFile(configPath, original, "utf8");
    await writeFile(`${configPath}.bak`, "existing backup", "utf8");

    await expect(runMigrateConfigCommand({ configPath, write: true })).rejects.toMatchObject({
      code: "CONFIG_MIGRATION_BACKUP_EXISTS"
    });
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe("existing backup");
  });

  it("does not write or create a backup for an already canonical v2 configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify({
      version: "2",
      name: "canonical-wrapper",
      defaultProfile: "default",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test" },
      profiles: { default: {} },
      secrets: { allowPlaintextSecrets: false }
    }, null, 2)}\n`;
    await writeFile(configPath, original, "utf8");

    await expect(runMigrateConfigCommand({ configPath, write: true })).resolves.toMatchObject({
      fromVersion: "2",
      toVersion: "2",
      changed: false,
      write: false,
      backupCreated: false
    });
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("refuses to migrate a symlinked source before creating a backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const targetPath = join(directory, "target.json");
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    await writeFile(targetPath, original, "utf8");
    await symlink(targetPath, configPath);

    await expect(runMigrateConfigCommand({ configPath, write: true })).rejects.toMatchObject({
      code: "CONFIG_MIGRATION_WRITE_FAILED"
    });
    expect(await readFile(targetPath, "utf8")).toBe(original);
    await expect(access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a source that changed after the migration snapshot instead of overwriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    const replacement = `${JSON.stringify({
      version: "1",
      name: "concurrent-editor-config",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node" },
      profiles: { default: {} }
    }, null, 2)}\n`;
    await writeFile(configPath, original, "utf8");
    const source = await readConfigMigrationSource(configPath);
    const plan = planConfigMigration(legacyConfig());
    await writeFile(configPath, replacement, "utf8");

    await expect(applyConfigMigration(configPath, source, plan)).rejects.toMatchObject({
      code: "CONFIG_MIGRATION_WRITE_FAILED"
    });
    expect(await readFile(configPath, "utf8")).toBe(replacement);
    await expect(access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a config created after the source is held aside instead of overwriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    const concurrent = Buffer.from(`${JSON.stringify({
      version: "1",
      name: "concurrent-editor-config",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node" },
      profiles: { default: {} }
    }, null, 2)}\n`, "utf8");
    await writeFile(configPath, original, "utf8");
    const source = await readConfigMigrationSource(configPath);
    const plan = planConfigMigration(legacyConfig());
    migrationRace.configPath = configPath;
    migrationRace.concurrentBytes = concurrent;

    await expect(applyConfigMigration(configPath, source, plan)).rejects.toMatchObject({
      code: "CONFIG_MIGRATION_WRITE_FAILED"
    });

    expect(migrationRace.triggered).toBe(true);
    expect(await readFile(configPath)).toEqual(concurrent);
    expect(await readFile(`${configPath}.bak`)).toEqual(Buffer.from(original, "utf8"));
    const entries = await readdir(directory);
    const recoveryDirectories = entries.filter((entry) => entry.startsWith(".miftah.json.miftah-migrate-"));
    expect(recoveryDirectories).toHaveLength(1);
    const recoveryDirectory = recoveryDirectories[0];
    if (recoveryDirectory === undefined) throw new Error("Expected one retained migration transaction directory");
    const recoveryEntries = await readdir(join(directory, recoveryDirectory));
    if (process.platform !== "win32") expect((await stat(join(directory, recoveryDirectory))).mode & 0o077).toBe(0);
    expect(await readFile(join(directory, recoveryDirectory, "source.miftah-migrate-hold"))).toEqual(
      Buffer.from(original, "utf8")
    );
    expect(recoveryEntries).not.toContain("candidate.miftah-migrate.tmp");
  });

  it("rejects a same-size edit whose mtime was restored before the source move", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    const fixedTime = new Date("2024-01-01T00:00:00.000Z");
    const concurrent = Buffer.from(original.replace("legacy-wrapper", "edited-wrapper"), "utf8");
    expect(concurrent).toHaveLength(Buffer.byteLength(original));
    await writeFile(configPath, original, "utf8");
    await utimes(configPath, fixedTime, fixedTime);
    const source = await readConfigMigrationSource(configPath);
    const plan = planConfigMigration(legacyConfig());
    migrationRace.configPath = configPath;
    migrationRace.sourceBytesBeforeMove = concurrent;
    migrationRace.sourceMtimeBeforeMove = fixedTime;

    await expect(applyConfigMigration(configPath, source, plan)).rejects.toMatchObject({
      code: "CONFIG_MIGRATION_WRITE_FAILED"
    });

    expect(await readFile(configPath)).toEqual(concurrent);
    await expect(access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(directory)).some((entry) => entry.startsWith(".miftah.json.miftah-migrate-"))).toBe(false);
  });

  it("restores the original source if non-overwriting candidate publication fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    await writeFile(configPath, original, "utf8");
    const source = await readConfigMigrationSource(configPath);
    const plan = planConfigMigration(legacyConfig());
    migrationRace.configPath = configPath;
    migrationRace.failCandidateLink = true;

    await expect(applyConfigMigration(configPath, source, plan)).rejects.toMatchObject({
      code: "CONFIG_MIGRATION_WRITE_FAILED"
    });

    expect(migrationRace.failedCandidateLink).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(original);
    expect((await readdir(directory)).some((entry) => entry.startsWith(".miftah.json.miftah-migrate-"))).toBe(false);
  });

  it("reports a committed migration honestly when a held source changes after publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    const concurrent = Buffer.from(`${JSON.stringify({ changedBy: "concurrent-editor" })}\n`, "utf8");
    await writeFile(configPath, original, "utf8");
    const source = await readConfigMigrationSource(configPath);
    const plan = planConfigMigration(legacyConfig());
    migrationRace.configPath = configPath;
    migrationRace.mutateHeldAfterPublish = concurrent;

    await expect(applyConfigMigration(configPath, source, plan)).rejects.toThrow("migrated configuration was installed");

    expect(migrationRace.mutatedHeldAfterPublish).toBe(true);
    expect(validateConfig(JSON.parse(await readFile(configPath, "utf8")))).toMatchObject({ version: "2" });
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(original);
    const entries = await readdir(directory);
    const recoveryDirectories = entries.filter((entry) => entry.startsWith(".miftah.json.miftah-migrate-"));
    expect(recoveryDirectories).toHaveLength(1);
    const recoveryDirectory = recoveryDirectories[0];
    if (recoveryDirectory === undefined) throw new Error("Expected one retained migration transaction directory");
    expect(await readFile(join(directory, recoveryDirectory, "source.miftah-migrate-hold"))).toEqual(concurrent);
  });

  it("retains the held source when a concurrent target replaces the published candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(legacyConfig(), null, 2)}\n`;
    const concurrent = Buffer.from(`${JSON.stringify({ changedBy: "concurrent-target" })}\n`, "utf8");
    await writeFile(configPath, original, "utf8");
    const source = await readConfigMigrationSource(configPath);
    const plan = planConfigMigration(legacyConfig());
    migrationRace.configPath = configPath;
    migrationRace.replacementTargetAfterPublish = concurrent;

    await expect(applyConfigMigration(configPath, source, plan)).rejects.toMatchObject({
      code: "CONFIG_MIGRATION_WRITE_FAILED"
    });

    expect(migrationRace.replacedPublishedTarget).toBe(true);
    expect(await readFile(configPath)).toEqual(concurrent);
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(original);
    const entries = await readdir(directory);
    const recoveryDirectories = entries.filter((entry) => entry.startsWith(".miftah.json.miftah-migrate-"));
    expect(recoveryDirectories).toHaveLength(1);
    const recoveryDirectory = recoveryDirectories[0];
    if (recoveryDirectory === undefined) throw new Error("Expected one retained migration transaction directory");
    expect(await readFile(join(directory, recoveryDirectory, "source.miftah-migrate-hold"), "utf8")).toBe(original);
  });

  it("rejects malformed UTF-8 before it can create a non-byte-exact backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-config-migration-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const bytes = Buffer.concat([
      Buffer.from('{"version":"1","name":"legacy-', "utf8"),
      Buffer.from([0xff]),
      Buffer.from('","defaultProfile":"default","upstream":{"transport":"stdio","command":"node"},"profiles":{"default":{}}}\n', "utf8")
    ]);
    await writeFile(configPath, bytes);

    await expect(runMigrateConfigCommand({ configPath, write: true })).rejects.toMatchObject({
      code: "CONFIG_INVALID_JSON"
    });
    expect(await readFile(configPath)).toEqual(bytes);
    await expect(access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("released configuration compatibility fixtures", () => {
  it("loads every supported released-format fixture without rewriting its original bytes", async () => {
    const root = fileURLToPath(new URL("./fixtures/config-compat/", import.meta.url));
    const versionDirectories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^v[0-9]+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    expect(versionDirectories).toEqual(["v1", "v2"]);
    for (const versionDirectory of versionDirectories) {
      const version = versionDirectory.slice(1);
      const directory = join(root, versionDirectory);
      const fixtures = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
      expect(fixtures).not.toEqual([]);
      for (const fixture of fixtures) {
        const path = join(directory, fixture);
        const before = await readFile(path, "utf8");
        await expect(loadConfig(path)).resolves.toMatchObject({ version });
        expect(await readFile(path, "utf8")).toBe(before);
      }
    }
  });
});
