import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  planProfileRemoval,
  runProfileRemoval
} from "../src/setup/profile-removal-onboarding.js";
import { MiftahError } from "../src/utils/errors.js";

describe("durable profile removal onboarding", () => {
  it("reassigns every durable non-OAuth reference before removing one profile", () => {
    const configPath = join(tmpdir(), "miftah-profile-removal-plan", "analytics.json");
    const input = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: {
        work: {
          description: "Work account",
          env: { API_KEY: "${WORK_API_KEY}" }
        },
        personal: {
          description: "Personal account",
          env: { API_KEY: "${PERSONAL_API_KEY}" }
        }
      },
      routing: {
        rules: [{ name: "work-directory", when: { cwd: "/work" }, profile: "work" }]
      },
      plugins: {
        allowlist: [{
          id: "tenant-router",
          kind: "routing-matcher",
          path: "./tenant-router.mjs",
          bindings: { "work-tenant": "work", "personal-tenant": "personal" }
        }]
      },
      security: { lockToProfile: "work" }
    };
    const original = structuredClone(input);

    const plan = planProfileRemoval(input, {
      configPath,
      profile: "work",
      replacementProfile: "personal"
    });

    expect(plan).toMatchObject({
      changed: true,
      profile: "work",
      replacementProfile: "personal",
      config: {
        defaultProfile: "personal",
        profiles: { personal: original.profiles.personal },
        routing: { rules: [{ name: "work-directory", profile: "personal" }] },
        plugins: {
          allowlist: [{ bindings: { "work-tenant": "personal", "personal-tenant": "personal" } }]
        },
        security: { lockToProfile: "personal" }
      }
    });
    expect(plan.config.profiles).not.toHaveProperty("work");
    expect(plan.actions).toContain("Removed profile 'work'.");
    expect(input).toEqual(original);
  });

  it("requires a distinct existing replacement whenever removal would leave a durable reference", () => {
    const input = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { work: {}, personal: {} }
    };
    const original = structuredClone(input);
    const configPath = join(tmpdir(), "miftah-profile-removal-replacement", "analytics.json");

    for (const options of [
      { configPath, profile: "work" },
      { configPath, profile: "work", replacementProfile: "work" },
      { configPath, profile: "work", replacementProfile: "missing" }
    ]) {
      expect(() => planProfileRemoval(input, options)).toThrowError(
        expect.objectContaining({
          code: options.replacementProfile === undefined ? "PROFILE_REPLACEMENT_REQUIRED" : "PROFILE_REPLACEMENT_INVALID"
        })
      );
      expect(input).toEqual(original);
    }
  });

  it("allows an unreferenced nondefault profile to be removed without an unnecessary replacement", () => {
    const input = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: {
        work: { env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    };
    const original = structuredClone(input);

    const plan = planProfileRemoval(input, {
      configPath: join(tmpdir(), "miftah-profile-removal-unreferenced", "analytics.json"),
      profile: "personal"
    });

    expect(plan).toMatchObject({
      changed: true,
      profile: "personal",
      replacementProfile: undefined,
      config: { defaultProfile: "work", profiles: { work: original.profiles.work } },
      actions: ["Removed profile 'personal'."]
    });
    expect(plan.config.profiles).not.toHaveProperty("personal");
    expect(input).toEqual(original);
  });

  it("refuses to remove the last configured profile or a profile with a native OAuth binding", () => {
    const configPath = join(tmpdir(), "miftah-profile-removal-fail-closed", "analytics.json");
    const onlyProfile = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { work: {} }
    };
    expect(() => planProfileRemoval(onlyProfile, { configPath, profile: "work" })).toThrowError(
      expect.objectContaining({ code: "PROFILE_LAST_PROFILE" })
    );

    const oauthBoundProfile = {
      version: "3",
      name: "remote-analytics",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: "https://mcp.example.com/mcp" },
      profiles: { work: {}, personal: {} },
      oauth: {
        connections: {
          "oauthconn:11111111-1111-4111-8111-111111111111": {
            profile: "work",
            upstream: "default",
            resource: "https://mcp.example.com/mcp",
            issuer: "https://auth.example.com",
            clientRegistration: "dynamic",
            scopes: ["openid"]
          }
        }
      }
    };
    const original = structuredClone(oauthBoundProfile);
    expect(() => planProfileRemoval(oauthBoundProfile, {
      configPath,
      profile: "work",
      replacementProfile: "personal"
    })).toThrowError(expect.objectContaining({ code: "PROFILE_REMOVAL_OAUTH_CONNECTION" }));
    expect(oauthBoundProfile).toEqual(original);
  });

  it("applies an unreferenced removal and records the successful audit lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-removal-success-"));
    const configPath = join(directory, "analytics.json");
    await writeFile(configPath, `${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: {
        work: { env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    }, null, 2)}\n`, { mode: 0o600 });
    const audit = {
      ensureWritable: vi.fn().mockResolvedValue(undefined),
      intent: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined)
    };

    try {
      const report = await runProfileRemoval({ configPath, profile: "personal" }, { audit });

      expect(report).toEqual({
        changed: true,
        profile: "personal",
        actions: ["Removed profile 'personal'."],
        write: true,
        backupPath: expect.any(String)
      });
      expect(audit.ensureWritable).toHaveBeenCalledTimes(1);
      expect(audit.intent).toHaveBeenCalledWith({ profile: "personal" });
      expect(audit.record).toHaveBeenCalledWith({ profile: "personal", status: "success" });
      const written = JSON.parse(await readFile(configPath, "utf8"));
      expect(written).toMatchObject({
        defaultProfile: "work",
        profiles: { work: { env: { API_KEY: "${WORK_API_KEY}" } } }
      });
      expect(written.profiles).not.toHaveProperty("personal");
      expect(JSON.stringify(report)).not.toContain("PERSONAL_API_KEY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores the exact original configuration when final required audit recording fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-removal-audit-recovery-"));
    const configPath = join(directory, "analytics.json");
    const original = `\n${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: {
        work: { env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
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
      const failure = await runProfileRemoval({ configPath, profile: "personal" }, { audit }).then(
        () => {
          throw new Error("Expected profile removal to fail when final audit recording fails.");
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
      expect(audit.intent).toHaveBeenCalledWith({ profile: "personal" });
      expect(audit.record).toHaveBeenCalledWith({ profile: "personal", status: "success" });
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
