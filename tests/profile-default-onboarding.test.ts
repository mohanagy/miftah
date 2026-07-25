import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { buildPresetConfig } from "../src/config/presets.js";
import { planDefaultProfileChange, runDefaultProfileChange } from "../src/setup/profile-default-onboarding.js";
import { MiftahError } from "../src/utils/errors.js";

describe("durable default-profile onboarding", () => {
  it("plans a default-profile change without altering existing provider account state", () => {
    const configPath = join(tmpdir(), "miftah-default-profile-plan", "gsc.json");
    const firstSecrets = join(tmpdir(), "miftah-default-profile-plan", "first-client-secrets.json");
    const secondSecrets = join(tmpdir(), "miftah-default-profile-plan", "second-client-secrets.json");
    const input = buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", description: "Work account", oauthClientSecretsFile: firstSecrets },
        { name: "google-personal", description: "Personal account", oauthClientSecretsFile: secondSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath });
    const originalProfiles = structuredClone(input.profiles);

    const plan = planDefaultProfileChange(input, { configPath, profile: "google-personal" });

    expect(plan).toMatchObject({
      changed: true,
      profile: "google-personal",
      config: { defaultProfile: "google-personal" },
      actions: ["Set durable default profile to 'google-personal'."]
    });
    expect(plan.config.profiles).toEqual(originalProfiles);
    expect(input.profiles).toEqual(originalProfiles);
  });

  it("rejects an unknown durable default without changing the existing profiles", () => {
    const input = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { work: {}, personal: {} }
    };
    const original = structuredClone(input);

    expect(() => planDefaultProfileChange(input, {
      configPath: join(tmpdir(), "miftah-default-profile-plan", "analytics.json"),
      profile: "missing"
    })).toThrowError(expect.objectContaining({ code: "PROFILE_NOT_FOUND" }));
    expect(input).toEqual(original);
  });

  it("writes a durable default change without returning configuration or provider-account data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-default-profile-public-report-"));
    const configPath = join(directory, "gsc.json");
    const firstSecrets = join(directory, "first-client-secrets.json");
    const secondSecrets = join(directory, "second-client-secrets.json");
    const config = buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", oauthClientSecretsFile: firstSecrets },
        { name: "google-personal", oauthClientSecretsFile: secondSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    try {
      const result = await runDefaultProfileChange({ configPath, profile: "google-personal" });

      expect(result).toMatchObject({
        changed: true,
        write: true,
        profile: "google-personal",
        actions: ["Set durable default profile to 'google-personal'."]
      });
      expect(result).not.toHaveProperty("config");
      expect(JSON.stringify(result)).not.toContain(firstSecrets);
      expect(JSON.stringify(result)).not.toContain(secondSecrets);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores the original configuration when the final required audit record fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-default-profile-audit-recovery-"));
    const configPath = join(directory, "gsc.json");
    const firstSecrets = join(directory, "first-client-secrets.json");
    const secondSecrets = join(directory, "second-client-secrets.json");
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
      const failure = await runDefaultProfileChange({
        configPath,
        profile: "google-personal"
      }, { audit }).then(
        () => {
          throw new Error("Expected durable default change to fail when the audit record cannot be written.");
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
      expect((await readdir(directory)).filter((entry) => entry.startsWith("gsc.json.miftah-backup-"))).toHaveLength(1);
      expect(audit.intent).toHaveBeenCalledWith({ profile: "google-personal" });
      expect(audit.record).toHaveBeenCalledWith({ profile: "google-personal", status: "success" });
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
