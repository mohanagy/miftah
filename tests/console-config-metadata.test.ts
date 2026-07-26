import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { consoleAuthenticationMetadata } from "../src/console/console-config-metadata.js";
import type { MiftahConfig } from "../src/config/types.js";

function privatePath(...segments: readonly string[]): string {
  return resolve("/private", ...segments);
}

describe("Console configuration metadata", () => {
  it("keeps a mixed adapter configuration out of both provider-owned and native OAuth states", () => {
    const config: MiftahConfig = {
      version: "3",
      name: "gsc",
      defaultProfile: "safe",
      upstream: {
        transport: "stdio",
        command: "uvx",
        args: ["mcp-search-console@0.3.2"]
      },
      profiles: {
        safe: { env: { GSC_CONFIG_DIR: "/private/safe" } },
        unsafe: { env: { PATH: "/untrusted/bin" } }
      }
    };

    expect(consoleAuthenticationMetadata(config)).toEqual({
      mode: "manual-only",
      credentialOwner: "manual-only",
      browserHandoff: "manual-only",
      tokenStore: "external",
      readinessTargets: [{ profile: "safe", upstream: "default" }]
    });
  });

  it("keeps a reviewed profile override visible when it supersedes an older base argument default", () => {
    const config: MiftahConfig = {
      version: "3",
      name: "gsc",
      defaultProfile: "work",
      upstream: {
        transport: "stdio",
        command: "uvx",
        args: ["mcp-search-console@0.3.1"]
      },
      profiles: {
        work: { args: ["mcp-search-console@0.3.2"] }
      }
    };

    expect(consoleAuthenticationMetadata(config)).toMatchObject({
      mode: "provider-adapter",
      readinessTargets: [{ profile: "work", upstream: "default" }]
    });
  });

  it("offers provider-owned account addition only for fully isolated existing account bindings", () => {
    const config: MiftahConfig = {
      version: "3",
      name: "gsc",
      defaultProfile: "work",
      upstream: {
        transport: "stdio",
        command: "uvx",
        args: ["mcp-search-console@0.3.2"]
      },
      profiles: {
        work: {
          env: {
            GSC_OAUTH_CLIENT_SECRETS_FILE: privatePath("work-client-secrets.json"),
            GSC_CONFIG_DIR: privatePath("miftah", "gsc", "work")
          }
        },
        personal: {
          env: {
            GSC_OAUTH_CLIENT_SECRETS_FILE: privatePath("personal-client-secrets.json"),
            GSC_CONFIG_DIR: privatePath("miftah", "gsc", "personal")
          }
        }
      }
    };

    expect(consoleAuthenticationMetadata(config)).toMatchObject({
      mode: "provider-adapter",
      accountAddition: {
        credentialFileLabel: "Google OAuth client-secrets file",
        credentialFilePlaceholder: "/Users/you/gsc-client-secrets.json"
      }
    });

    const sharedState = structuredClone(config);
    sharedState.profiles.personal!.env!.GSC_CONFIG_DIR = privatePath("miftah", "gsc", "work");
    expect(consoleAuthenticationMetadata(sharedState)).not.toHaveProperty("accountAddition");
  });

  it("offers static account addition only for one simple local environment binding", () => {
    const config: MiftahConfig = {
      version: "3",
      name: "internal-tools",
      defaultProfile: "production",
      upstream: {
        transport: "stdio",
        command: "internal-mcp",
        args: ["--stdio"]
      },
      profiles: {
        production: {
          env: { INTERNAL_API_TOKEN: "${INTERNAL_PRODUCTION_TOKEN}" },
          policy: "readonly"
        }
      }
    };

    expect(consoleAuthenticationMetadata(config)).toMatchObject({
      mode: "manual-only",
      environmentProfileAddition: { credentialEnvironment: "INTERNAL_API_TOKEN" }
    });
    expect(JSON.stringify(consoleAuthenticationMetadata(config))).not.toContain("INTERNAL_PRODUCTION_TOKEN");

    const unsafe = structuredClone(config);
    unsafe.profiles.production!.args = ["--tenant=production"];
    expect(consoleAuthenticationMetadata(unsafe)).not.toHaveProperty("environmentProfileAddition");
  });
});
