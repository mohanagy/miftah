import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPresetConfig } from "../src/config/presets.js";
import {
  planProfileDescriptionChange,
  runProfileDescriptionChange,
  type ProfileDescriptionChangeRequest
} from "../src/setup/profile-description-onboarding.js";
import { MiftahError } from "../src/utils/errors.js";

describe("durable profile-description onboarding", () => {
  it("plans a description change without altering OAuth or other profile state", () => {
    const configPath = join(tmpdir(), "miftah-profile-description-plan", "gsc.json");
    const firstSecrets = join(tmpdir(), "miftah-profile-description-plan", "first-client-secrets.json");
    const secondSecrets = join(tmpdir(), "miftah-profile-description-plan", "second-client-secrets.json");
    const input = buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", description: "Work account", oauthClientSecretsFile: firstSecrets },
        { name: "google-personal", description: "Personal account", oauthClientSecretsFile: secondSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath });
    const original = structuredClone(input);

    const plan = planProfileDescriptionChange(input, {
      configPath,
      profile: "google-personal",
      description: "Personal Search Console"
    });

    expect(plan).toMatchObject({
      changed: true,
      profile: "google-personal",
      config: {
        defaultProfile: "google-work",
        profiles: {
          "google-personal": { description: "Personal Search Console" }
        }
      },
      actions: ["Set profile description for 'google-personal'."]
    });
    const originalOAuth = "oauth" in original ? original.oauth : undefined;
    const plannedOAuth = "oauth" in plan.config ? plan.config.oauth : undefined;
    expect(plannedOAuth).toEqual(originalOAuth);
    expect(plan.config.profiles["google-work"]).toEqual(original.profiles["google-work"]);
    expect(input).toEqual(original);
  });

  it("explicitly clears only the selected profile description", () => {
    const input = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: {
        work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal account", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    };
    const original = structuredClone(input);

    const plan = planProfileDescriptionChange(input, {
      configPath: join(tmpdir(), "miftah-profile-description-clear", "analytics.json"),
      profile: "personal",
      clearDescription: true
    });

    expect(plan).toMatchObject({
      changed: true,
      profile: "personal",
      cleared: true,
      config: {
        defaultProfile: "work",
        profiles: {
          work: original.profiles.work,
          personal: { env: { API_KEY: "${PERSONAL_API_KEY}" } }
        }
      },
      actions: ["Cleared profile description for 'personal'."]
    });
    expect(plan.config.profiles.personal).not.toHaveProperty("description");
    expect(input).toEqual(original);
  });

  it("rejects ambiguous, unsafe, and missing profile description changes without mutating input", () => {
    const input = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { work: { description: "Work account" } }
    };
    const original = structuredClone(input);
    const configPath = join(tmpdir(), "miftah-profile-description-input", "analytics.json");

    const invalidOptions: readonly ProfileDescriptionChangeRequest[] = [
      { configPath, profile: "work" },
      { configPath, profile: "work", description: "Work", clearDescription: true as const },
      { configPath, profile: "work", description: " Work " },
      { configPath, profile: "work", description: "Work\naccount" },
      { configPath, profile: "missing", description: "Missing" }
    ];
    for (const options of invalidOptions) {
      expect(() => planProfileDescriptionChange(input, options)).toThrowError(
        expect.objectContaining({
          code: options.profile === "missing" ? "PROFILE_NOT_FOUND" : "PROFILE_DESCRIPTION_INPUT_INVALID"
        })
      );
      expect(input).toEqual(original);
    }
  });

  it("does not write or audit when the requested description is already current", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-description-noop-"));
    const configPath = join(directory, "analytics.json");
    const original = `\n${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { work: { description: "Work account" } }
    }, null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });
    const audit = {
      ensureWritable: vi.fn().mockResolvedValue(undefined),
      intent: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined)
    };

    try {
      await expect(runProfileDescriptionChange({
        configPath,
        profile: "work",
        description: "Work account"
      }, { audit })).resolves.toEqual({
        changed: false,
        profile: "work",
        cleared: false,
        actions: ["Profile description for 'work' is already current."],
        write: false
      });
      expect(await readFile(configPath, "utf8")).toBe(original);
      expect(audit.ensureWritable).not.toHaveBeenCalled();
      expect(audit.intent).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores the exact original configuration when final required audit recording fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-description-audit-recovery-"));
    const configPath = join(directory, "analytics.json");
    const original = `\n${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } } }
    }, null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });
    const audit = {
      ensureWritable: vi.fn().mockResolvedValue(undefined),
      intent: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockRejectedValue(
        new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: forced final lifecycle failure")
      )
    };

    try {
      const failure = await runProfileDescriptionChange({
        configPath,
        profile: "work",
        description: "Primary work account"
      }, { audit }).then(
        () => {
          throw new Error("Expected profile description change to fail when final audit recording fails.");
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
      expect((await readdir(directory)).filter((entry) => entry.startsWith("analytics.json.miftah-backup-"))).toHaveLength(1);
      expect(audit.intent).toHaveBeenCalledWith({ profile: "work", cleared: false });
      expect(audit.record).toHaveBeenCalledWith({ profile: "work", cleared: false, status: "success" });
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
