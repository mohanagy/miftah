import { describe, expect, it } from "vitest";
import { presetConfig } from "../src/config/presets.js";

describe("preset config", () => {
  it("generates a pinned, token-forwarding GitHub Docker preset with profile-specific env refs", () => {
    const config = presetConfig("github", "github");

    expect(config.upstream).toBeDefined();
    expect(config.upstream?.command).toBe("docker");
    expect(config.upstream?.args).toEqual([
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "ghcr.io/github/github-mcp-server:v1.5.0",
      "stdio",
      "--read-only",
      "--toolsets=repos,issues,pull_requests"
    ]);

    expect(config.defaultProfile).toBe("work");
    expect(config.profiles.work?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("${GITHUB_WORK_TOKEN}");
    expect(config.profiles.personal?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("${GITHUB_PERSONAL_TOKEN}");
    expect(config.profiles.work?.policy).toBe("readonly");
    expect(config.profiles.personal?.policy).toBe("readonly");
    expect(config.security).toMatchObject({
      allowProfileSwitchingFromMcp: true,
      requireProfileSwitchConfirmation: true,
      requireExplicitProfileForDestructive: true,
      requireExplicitSelectionForDestructive: true
    });

    const refs = [
      config.profiles.work?.env?.GITHUB_PERSONAL_ACCESS_TOKEN,
      config.profiles.personal?.env?.GITHUB_PERSONAL_ACCESS_TOKEN
    ];
    expect(refs.every((value) => typeof value === "string" && value.startsWith("${") && value.endsWith("}"))).toBe(true);
    for (const profile of Object.values(config.profiles)) {
      if (profile.policy) {
        expect(config.policies).toHaveProperty(profile.policy);
      }
    }
  });

  it("preserves the generic preset defaults", () => {
    const config = presetConfig("example");

    expect(config).toMatchObject({
      description: "example wrapped by Miftah",
      defaultProfile: "default",
      upstream: {
        transport: "stdio",
        command: "npx",
        args: ["--yes", "@modelcontextprotocol/server-everything@2026.7.4", "stdio"]
      },
      profiles: { default: { description: "Default account", env: {} } }
    });
    expect(config.security?.requireProfileSwitchConfirmation).toBeUndefined();
    expect(config.security?.requireExplicitSelectionForDestructive).toBeUndefined();
  });

  it("retains the public generic fallback for unknown preset names", () => {
    const config = presetConfig("example", "not-a-catalog-preset");

    expect(config.upstream?.args).toEqual(["--yes", "@modelcontextprotocol/server-everything@2026.7.4", "stdio"]);
  });

  it("uses the Sentry package with the shared preset defaults", () => {
    const config = presetConfig("sentry", "sentry");

    expect(config).toMatchObject({
      description: "sentry wrapped by Miftah",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "npx", args: ["--yes", "@sentry/mcp-server@0.36.0", "--skills=inspect"] },
      profiles: {
        default: {
          description: "Default account",
          env: { SENTRY_ACCESS_TOKEN: "${SENTRY_ACCESS_TOKEN}" },
          policy: "readonly"
        }
      },
      policies: { readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] } }
    });
    expect(config.security?.requireProfileSwitchConfirmation).toBeUndefined();
    expect(config.security?.requireExplicitSelectionForDestructive).toBeUndefined();
  });
});
