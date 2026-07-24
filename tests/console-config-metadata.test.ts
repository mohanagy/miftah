import { describe, expect, it } from "vitest";
import { consoleAuthenticationMetadata } from "../src/console/console-config-metadata.js";
import type { MiftahConfig } from "../src/config/types.js";

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
});
