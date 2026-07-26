import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  planProfileRename,
  runProfileRename
} from "../src/setup/profile-rename-onboarding.js";
import { MiftahError } from "../src/utils/errors.js";

describe("durable profile rename onboarding", () => {
  it("renames the profile and every durable configuration reference atomically", () => {
    const input = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: {
        work: {
          description: "Work account",
          env: {
            API_KEY: "${WORK_API_KEY}",
            GSC_CONFIG_DIR: "/Users/example/.config/miftah/gsc/work"
          }
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

    const plan = planProfileRename(input, {
      configPath: "/tmp/miftah-profile-rename/analytics.json",
      profile: "work",
      newProfile: "studio"
    });

    expect(plan).toMatchObject({
      changed: true,
      profile: "work",
      newProfile: "studio",
      config: {
        defaultProfile: "studio",
        profiles: {
          studio: original.profiles.work,
          personal: original.profiles.personal
        },
        routing: { rules: [{ name: "work-directory", profile: "studio" }] },
        plugins: {
          allowlist: [{ bindings: { "work-tenant": "studio", "personal-tenant": "personal" } }]
        },
        security: { lockToProfile: "studio" }
      }
    });
    expect(plan.config.profiles).not.toHaveProperty("work");
    expect(plan.actions).toContain("Renamed profile 'work' to 'studio'.");
    expect(input).toEqual(original);
  });

  it("refuses an OAuth-bound profile instead of touching a vault-bound credential", () => {
    const input = {
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
    const original = structuredClone(input);

    expect(() => planProfileRename(input, {
      configPath: "/tmp/miftah-profile-rename/remote-analytics.json",
      profile: "work",
      newProfile: "studio"
    })).toThrowError(expect.objectContaining({ code: "PROFILE_RENAME_OAUTH_CONNECTION" }));
    expect(input).toEqual(original);
  });

  it("applies a rename through the guarded audit lifecycle without exposing credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-rename-success-"));
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
      const report = await runProfileRename({ configPath, profile: "work", newProfile: "studio" }, { audit });

      expect(report).toEqual({
        changed: true,
        profile: "work",
        newProfile: "studio",
        actions: ["Renamed profile 'work' to 'studio'."],
        write: true,
        backupPath: expect.any(String)
      });
      expect(audit.ensureWritable).toHaveBeenCalledTimes(1);
      expect(audit.intent).toHaveBeenCalledWith({ profile: "work", newProfile: "studio" });
      expect(audit.record).toHaveBeenCalledWith({ profile: "work", newProfile: "studio", status: "success" });
      const written = JSON.parse(await readFile(configPath, "utf8"));
      expect(written).toMatchObject({
        defaultProfile: "studio",
        profiles: {
          studio: { env: { API_KEY: "${WORK_API_KEY}" } },
          personal: { env: { API_KEY: "${PERSONAL_API_KEY}" } }
        }
      });
      expect(written.profiles).not.toHaveProperty("work");
      expect(JSON.stringify(report)).not.toContain("WORK_API_KEY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores the exact original configuration when final required audit recording fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-rename-audit-recovery-"));
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
      const failure = await runProfileRename({ configPath, profile: "work", newProfile: "studio" }, { audit }).then(
        () => {
          throw new Error("Expected profile rename to fail when final audit recording fails.");
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
      expect(audit.intent).toHaveBeenCalledWith({ profile: "work", newProfile: "studio" });
      expect(audit.record).toHaveBeenCalledWith({ profile: "work", newProfile: "studio", status: "success" });
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
