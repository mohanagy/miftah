import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { createRuntime } from "../src/runtime/create-runtime.js";
import { MiftahError } from "../src/utils/errors.js";

const connectionRef = "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5";
const directories: string[] = [];

function oauthConnection(overrides: Record<string, unknown> = {}) {
  return {
    profile: "work",
    upstream: "default",
    resource: "https://mcp.example.test/mcp",
    issuer: "https://issuer.example.test",
    clientRegistration: "pre-registered:desktop",
    scopes: ["mcp:tools"],
    ...overrides
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    version: "3",
    name: "oauth-wrapper",
    defaultProfile: "work",
    upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
    profiles: { work: {} },
    oauth: { connections: { [connectionRef]: oauthConnection() } },
    ...overrides
  };
}

function validationFailure(input: unknown): MiftahError {
  try {
    validateConfig(input);
  } catch (error) {
    if (error instanceof MiftahError) return error;
  }
  throw new Error("Expected configuration validation to fail");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OAuth v3 connection configuration", () => {
  it("accepts only opaque, non-secret connection bindings for canonical Streamable HTTP resources", () => {
    expect(validateConfig(config())).toMatchObject({
      version: "3",
      oauth: {
        connections: {
          [connectionRef]: {
            profile: "work",
            upstream: "default",
            resource: "https://mcp.example.test/mcp",
            issuer: "https://issuer.example.test",
            clientRegistration: "pre-registered:desktop",
            scopes: ["mcp:tools"]
          }
        }
      }
    });
  });

  it.each(["1", "2"] as const)("rejects OAuth bindings in config version %s", (version) => {
    const error = validationFailure(config({ version }));
    expect(error.code).toBe("UNSUPPORTED_CONFIG_OPTION");
    expect(error.message).toContain("oauth");
    expect(error.message).not.toContain("access-token");
  });

  it.each([
    ["upstream header", { upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp", headers: { authorization: "Bearer static" } } }],
    ["profile header", { profiles: { work: { headers: { Authorization: "Bearer static" } } } }]
  ])("rejects a native OAuth binding with a static Authorization source from the %s", (_label, override) => {
    const error = validationFailure(config(override));
    expect(error.message).toContain("oauth.connections");
    expect(error.message).toContain("Authorization");
    expect(error.message).not.toContain("Bearer static");
    expect(error.details?.diagnostics).toContainEqual(
      expect.objectContaining({ path: `oauth.connections.${connectionRef}` })
    );
  });

  it("rejects a named-upstream override Authorization source and an OAuth binding to an alias", () => {
    const named = config({
      upstream: undefined,
      upstreams: { primary: { transport: "streamable-http", url: "https://mcp.example.test/mcp" } },
      profiles: { work: { upstreams: { primary: { headers: { aUtHoRiZaTiOn: "Bearer static" } } } } },
      oauth: { connections: { [connectionRef]: oauthConnection({ upstream: "primary" }) } }
    });
    const namedError = validationFailure(named);
    expect(namedError.message).toContain("oauth.connections");
    expect(namedError.message).not.toContain("Bearer static");

    const aliasError = validationFailure(
      config({
        upstream: { transport: "streamable-http", url: "https://MCP.example.test:443/mcp" }
      })
    );
    expect(aliasError.message).toContain("oauth.connections");
    expect(aliasError.message).not.toContain("MCP.example.test");
  });

  it("rejects tokens, duplicate targets, and non-Streamable-HTTP connections", () => {
    const secretError = validationFailure(
      config({ oauth: { connections: { [connectionRef]: { ...oauthConnection(), accessToken: "fixture-token" } } } })
    );
    expect(secretError.message).toContain("oauth.connections");
    expect(secretError.message).not.toContain("fixture-token");

    const duplicateError = validationFailure(
      config({
        oauth: {
          connections: {
            [connectionRef]: oauthConnection(),
            "oauthconn:1d915a13-f8a5-45e0-8343-1e82e0939129": oauthConnection()
          }
        }
      })
    );
    expect(duplicateError.message).toContain("oauth.connections");

    const transportError = validationFailure(
      config({ upstream: { transport: "sse", url: "https://mcp.example.test/mcp" } })
    );
    expect(transportError.message).toContain("oauth.connections");
  });

  it("diagnoses missing OAuth targets and a noncanonical selected upstream resource", () => {
    const missingProfile = validationFailure(
      config({ oauth: { connections: { [connectionRef]: oauthConnection({ profile: "missing" }) } } })
    );
    expect(missingProfile.code).toBe("ROUTING_PROFILE_NOT_FOUND");
    expect(missingProfile.message).toContain("oauth.connections");

    const singletonAlias = validationFailure(
      config({ oauth: { connections: { [connectionRef]: oauthConnection({ upstream: "primary" }) } } })
    );
    expect(singletonAlias.code).toBe("UPSTREAM_NOT_FOUND");
    expect(singletonAlias.message).toContain("oauth.connections");

    const missingNamedUpstream = validationFailure(
      config({
        upstream: undefined,
        upstreams: { primary: { transport: "streamable-http", url: "https://mcp.example.test/mcp" } },
        oauth: { connections: { [connectionRef]: oauthConnection({ upstream: "missing" }) } }
      })
    );
    expect(missingNamedUpstream.code).toBe("UPSTREAM_NOT_FOUND");
    expect(missingNamedUpstream.message).toContain("oauth.connections");

    const noncanonicalResource = validationFailure(
      config({
        upstream: { transport: "streamable-http", url: "https://mcp.example.test/%2e%2e/mcp" },
        oauth: {
          connections: {
            [connectionRef]: oauthConnection({ resource: "https://mcp.example.test/%2e%2e/mcp" })
          }
        }
      })
    );
    expect(noncanonicalResource.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(noncanonicalResource.message).toContain("oauth.connections");
  });

  it("keeps profile and upstream target lengths aligned with the exact binding boundary", () => {
    const oversizedProfile = "p".repeat(257);
    const error = validationFailure(
      config({
        defaultProfile: oversizedProfile,
        profiles: { [oversizedProfile]: {} },
        oauth: { connections: { [connectionRef]: oauthConnection({ profile: oversizedProfile }) } }
      })
    );

    expect(error.message).toContain("oauth.connections");
    expect(error.message).not.toContain(oversizedProfile);
  });

  it.each([
    "provider-owned",
    "pre-registered:",
    "client-id-metadata:http://client.example.test/metadata",
    "client-id-metadata:https://client.example.test/"
  ])("rejects an unsupported OAuth client registration mode", (clientRegistration) => {
    const error = validationFailure(
      config({ oauth: { connections: { [connectionRef]: oauthConnection({ clientRegistration }) } } })
    );
    expect(error.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(error.message).toContain("oauth.connections");
    expect(error.message).not.toContain(clientRegistration);
  });

  it("enables the runtime only after constructing an exact vault-backed authorization engine", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-config-"));
    directories.push(directory);
    const path = join(directory, "miftah.json");
    await writeFile(path, JSON.stringify(config()), "utf8");

    const runtime = await createRuntime(path);
    expect(runtime.config.version).toBe("3");
    await runtime.manager.close();
  });
});
