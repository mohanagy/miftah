import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { buildPresetConfig } from "../src/config/presets.js";
import { planProviderAccountAddition, runProviderAccountAddition } from "../src/setup/provider-account-onboarding.js";
import { MiftahError } from "../src/utils/errors.js";

describe("provider-owned account onboarding", () => {
  it("plans a third isolated GSC account from a trusted existing adapter configuration", async () => {
    const configPath = join(tmpdir(), "miftah-provider-account-plan", "gsc.json");
    const firstSecrets = join(tmpdir(), "miftah-provider-account-plan", "first-client-secrets.json");
    const secondSecrets = join(tmpdir(), "miftah-provider-account-plan", "second-client-secrets.json");
    const thirdSecrets = join(tmpdir(), "miftah-provider-account-plan", "third-client-secrets.json");
    const input = buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", description: "Work Google account", oauthClientSecretsFile: firstSecrets },
        { name: "google-personal", description: "Personal Google account", oauthClientSecretsFile: secondSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath });
    const original = structuredClone(input);

    const plan = await planProviderAccountAddition(input, {
      configPath,
      profile: "google-third",
      description: "Third Google account",
      credentialFile: thirdSecrets,
      makeDefault: true
    });

    expect(plan).toMatchObject({
      adapter: "Google Search Console",
      profile: "google-third",
      config: {
        defaultProfile: "google-third",
        profiles: {
          "google-work": { description: "Work Google account" },
          "google-personal": { description: "Personal Google account" },
          "google-third": {
            description: "Third Google account",
            env: { GSC_OAUTH_CLIENT_SECRETS_FILE: thirdSecrets },
            policy: "readonly"
          }
        }
      }
    });
    const stateDirectories = Object.values(plan.config.profiles)
      .map((profile) => profile.env?.GSC_CONFIG_DIR);
    expect(stateDirectories).toHaveLength(3);
    expect(new Set(stateDirectories).size).toBe(3);
    expect(plan.actions).toEqual([
      "Created provider-owned account profile 'google-third'.",
      "Set durable default profile to 'google-third'."
    ]);
    expect(JSON.stringify(plan.actions)).not.toContain(thirdSecrets);
    expect(input).toEqual(original);
  });

  it("reports unsafe provider profile input without misdescribing it as credential input", () => {
    const configPath = join(tmpdir(), "miftah-provider-account-profile-input", "gsc.json");
    const credentialFile = join(tmpdir(), "miftah-provider-account-profile-input", "client-secrets.json");
    const input = buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [{ name: "google-work", oauthClientSecretsFile: credentialFile }],
      defaultProfile: "google-work"
    }, { configurationPath: configPath });
    const original = structuredClone(input);

    const failure = (() => {
      try {
        return planProviderAccountAddition(input, {
          configPath,
          profile: "../outside",
          credentialFile
        });
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toMatchObject({
      code: "PROVIDER_ACCOUNT_INPUT_INVALID",
      message: "PROVIDER_ACCOUNT_INPUT_INVALID: choose a safe profile name"
    });
    expect(input).toEqual(original);
  });

  it("writes its fail-closed lifecycle record relative to the selected configuration, never the caller working directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-provider-account-audit-"));
    const configPath = join(directory, "gsc.json");
    const auditFileName = "provider-account-audit.jsonl";
    const accidentalWorkingDirectoryAudit = resolve(process.cwd(), auditFileName);
    const firstSecrets = join(directory, "first-client-secrets.json");
    const secondSecrets = join(directory, "second-client-secrets.json");
    const thirdSecrets = join(directory, "third-client-secrets.json");
    const preset = buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", oauthClientSecretsFile: firstSecrets },
        { name: "google-personal", oauthClientSecretsFile: secondSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath });
    const config = {
      ...preset,
      audit: { ...preset.audit!, path: auditFileName }
    };
    await rm(accidentalWorkingDirectoryAudit, { force: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    try {
      await runProviderAccountAddition({
        configPath,
        profile: "google-third",
        credentialFile: thirdSecrets
      });

      const audit = await readFile(join(directory, auditFileName), "utf8");
      expect(audit).toContain("config/provider-profile-add");
      expect(audit).not.toContain(thirdSecrets);
      await expect(access(accidentalWorkingDirectoryAudit)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(accidentalWorkingDirectoryAudit, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores the original configuration when the final required audit record fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-provider-account-audit-recovery-"));
    const configPath = join(directory, "gsc.json");
    const firstSecrets = join(directory, "first-client-secrets.json");
    const secondSecrets = join(directory, "second-client-secrets.json");
    const thirdSecrets = join(directory, "third-client-secrets.json");
    const originalConfig = buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", oauthClientSecretsFile: firstSecrets },
        { name: "google-personal", oauthClientSecretsFile: secondSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath });
    const original = `\n${JSON.stringify(originalConfig, null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });
    const audit = {
      ensureWritable: vi.fn().mockResolvedValue(undefined),
      intent: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockRejectedValue(
        new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: forced final lifecycle failure")
      )
    };

    try {
      const failure = await runProviderAccountAddition({
        configPath,
        profile: "google-third",
        credentialFile: thirdSecrets
      }, { audit }).then(
        () => {
          throw new Error("Expected provider-owned account addition to fail when the audit record cannot be written.");
        },
        (error: unknown) => error
      );

      expect(failure).toMatchObject({
        code: "AUDIT_WRITE_FAILED",
        message: expect.stringContaining("configuration was restored")
      });
      if (!(failure instanceof MiftahError)) throw failure;
      const backupPaths = failure.details?.backupPaths;
      expect(backupPaths).toHaveLength(1);
      if (!Array.isArray(backupPaths) || !backupPaths.every((path): path is string => typeof path === "string")) {
        throw new Error("Expected audit recovery failure details to retain the original configuration backup path.");
      }
      expect(await readFile(backupPaths[0]!, "utf8")).toBe(original);
      const backups = (await readdir(directory))
        .filter((entry) => entry.startsWith("gsc.json.miftah-backup-"));
      expect(backups).toHaveLength(1);

      expect(audit.intent).toHaveBeenCalledWith({ profile: "google-third" });
      expect(audit.record).toHaveBeenCalledWith({ profile: "google-third", status: "success" });
      const restored = await readFile(configPath, "utf8");
      expect(restored).toBe(original);
      const resulting = JSON.parse(restored) as { profiles: Record<string, unknown> };
      expect(resulting.profiles).not.toHaveProperty("google-third");
      expect(resulting).toEqual(originalConfig);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects provider-account addition for a configuration outside a reviewed adapter without changing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-provider-account-unsupported-"));
    const configPath = join(directory, "generic.json");
    const original = `${JSON.stringify(buildPresetConfig("generic", "generic"), null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });

    try {
      await expect(runProviderAccountAddition({
        configPath,
        profile: "other-account",
        credentialFile: join(directory, "client-secrets.json")
      })).rejects.toMatchObject({ code: "PROVIDER_ACCOUNT_ADDITION_UNSUPPORTED" });

      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-literal provider credential paths without changing the selected configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-provider-account-input-"));
    const configPath = join(directory, "gsc.json");
    const existingSecrets = join(directory, "existing-client-secrets.json");
    const originalConfig = buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [{ name: "google-work", oauthClientSecretsFile: existingSecrets }],
      defaultProfile: "google-work"
    }, { configurationPath: configPath });
    const original = `${JSON.stringify(originalConfig, null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });

    try {
      for (const credentialFile of ["relative-client-secrets.json", "${HOME}/client-secrets.json"]) {
        await expect(runProviderAccountAddition({
          configPath,
          profile: "google-personal",
          credentialFile
        })).rejects.toMatchObject({ code: "PROVIDER_ACCOUNT_INPUT_INVALID" });

        expect(await readFile(configPath, "utf8")).toBe(original);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
