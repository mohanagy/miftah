import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPresetConfig } from "../src/config/presets.js";
import {
  planEnvironmentProfileAddition,
  runEnvironmentProfileAddition
} from "../src/setup/environment-profile-onboarding.js";
import { environmentProfileConfig } from "./helpers/environment-profile-config.js";

describe("environment credential profile onboarding", () => {
  it("plans a distinct static-credential profile without copying a secret or changing the upstream", () => {
    const input = environmentProfileConfig("sentry");
    const original = structuredClone(input);

    const plan = planEnvironmentProfileAddition(input, {
      configPath: "/Users/example/.config/miftah/sentry.json",
      profile: "govalidate",
      description: "GoValidate Sentry account",
      credentialEnv: "STATIC_GOVALIDATE_ACCESS_TOKEN",
      makeDefault: true
    });

    expect(plan).toMatchObject({
      profile: "govalidate",
      config: {
        defaultProfile: "govalidate",
        upstream: input.upstream,
        profiles: {
          default: input.profiles.default,
          govalidate: {
            description: "GoValidate Sentry account",
            env: { STATIC_ACCESS_TOKEN: "${STATIC_GOVALIDATE_ACCESS_TOKEN}" },
            policy: "readonly"
          }
        },
        security: {
          requireProfileSwitchConfirmation: true,
          requireExplicitSelectionForDestructive: true
        }
      },
      actions: [
        "Created environment-backed account profile 'govalidate'.",
        "Set durable default profile to 'govalidate'."
      ]
    });
    expect(JSON.stringify(plan.actions)).not.toContain("STATIC_GOVALIDATE_ACCESS_TOKEN");
    expect(input).toEqual(original);
  });

  it("refuses a remote MCP because profile environment does not authenticate HTTP requests", () => {
    const input = buildPresetConfig("posthog", "streamable-http", {
      url: "https://mcp.example.test/mcp",
      credentialEnv: "POSTHOG_WORK_TOKEN",
      headerName: "Authorization",
      headerPrefix: "Bearer "
    });
    input.profiles.default = { env: { POSTHOG_TOKEN: "${POSTHOG_WORK_TOKEN}" } };
    const original = structuredClone(input);

    const failure = (() => {
      try {
        return planEnvironmentProfileAddition(input, {
          configPath: "/Users/example/.config/miftah/posthog.json",
          profile: "personal",
          credentialEnv: "POSTHOG_PERSONAL_TOKEN"
        });
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toMatchObject({ code: "ENVIRONMENT_PROFILE_ADDITION_UNSUPPORTED" });
    expect(input).toEqual(original);
  });

  it("refuses a new account that reuses an existing credential environment reference", () => {
    const input = environmentProfileConfig("sentry");
    const original = structuredClone(input);

    const failure = (() => {
      try {
        return planEnvironmentProfileAddition(input, {
          configPath: "/Users/example/.config/miftah/sentry.json",
          profile: "second-account",
          credentialEnv: "STATIC_DEFAULT_ACCESS_TOKEN"
        });
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toMatchObject({ code: "ENVIRONMENT_PROFILE_INPUT_INVALID" });
    expect(input).toEqual(original);
  });

  it("keeps a third independent account eligible after a second safe account exists", () => {
    const first = planEnvironmentProfileAddition(environmentProfileConfig("sentry"), {
      configPath: "/Users/example/.config/miftah/sentry.json",
      profile: "govalidate",
      credentialEnv: "STATIC_GOVALIDATE_ACCESS_TOKEN"
    });

    const third = planEnvironmentProfileAddition(first.config, {
      configPath: "/Users/example/.config/miftah/sentry.json",
      profile: "personal",
      credentialEnv: "STATIC_PERSONAL_ACCESS_TOKEN"
    });

    expect(third.config.profiles).toMatchObject({
      default: { env: { STATIC_ACCESS_TOKEN: "${STATIC_DEFAULT_ACCESS_TOKEN}" } },
      govalidate: { env: { STATIC_ACCESS_TOKEN: "${STATIC_GOVALIDATE_ACCESS_TOKEN}" } },
      personal: { env: { STATIC_ACCESS_TOKEN: "${STATIC_PERSONAL_ACCESS_TOKEN}" } }
    });
    expect(third.config.defaultProfile).toBe("default");
  });

  it("fails closed and restores the original configuration when final audit recording fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-environment-profile-audit-"));
    const configPath = join(directory, "sentry.json");
    const original = `${JSON.stringify(environmentProfileConfig("sentry"), null, 2)}\n`;
    await writeFile(configPath, original, { mode: 0o600 });
    const auditEvents: string[] = [];

    try {
      await expect(runEnvironmentProfileAddition({
        configPath,
        profile: "govalidate",
        credentialEnv: "STATIC_GOVALIDATE_ACCESS_TOKEN"
      }, {
        audit: {
          ensureWritable: async () => { auditEvents.push("writable"); },
          intent: async () => { auditEvents.push("intent"); },
          record: async () => {
            auditEvents.push("record");
            throw new Error("simulated final audit failure");
          }
        }
      })).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });

      expect(auditEvents).toEqual(["writable", "intent", "record"]);
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
