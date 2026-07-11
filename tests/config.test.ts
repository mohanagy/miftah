import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { expandEnvironmentReferences, expandEnvironmentReferencesWithSecretValues } from "../src/config/env-expand.js";
import { MiftahError } from "../src/utils/errors.js";

const policyNotFoundPattern = /POLICY_NOT_FOUND/u;

describe("config foundation", () => {
  it("accepts a valid wrapper and expands profile environment references", () => {
    const config = validateConfig({
      version: "1",
      name: "github",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: ["server.js"] },
      profiles: {
        work: {
          description: "Work GitHub",
          env: { API_TOKEN: "${WORK_TOKEN}", ACCOUNT: "work" }
        }
      }
    });

    expect(
      expandEnvironmentReferences(config.profiles.work!.env!, { WORK_TOKEN: "secret-value" })
    ).toEqual({ API_TOKEN: "secret-value", ACCOUNT: "work" });
  });

  it("tracks values resolved from environment references regardless of their configuration key", () => {
    expect(
      expandEnvironmentReferencesWithSecretValues(
        { COOKIE: "session=${SESSION_ID}", ACCOUNT: "work" },
        { SESSION_ID: "dynamic-session-secret" }
      )
    ).toEqual({
      values: { COOKIE: "session=dynamic-session-secret", ACCOUNT: "work" },
      secretValues: ["dynamic-session-secret"]
    });
  });

  it("rejects a config whose default profile does not exist", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "missing",
        upstream: { transport: "stdio", command: "node" },
        profiles: { work: {} }
      })
    ).toThrow(/DEFAULT_PROFILE_NOT_FOUND/);
  });

  it("reports missing environment references without exposing values", () => {
    expect(() =>
      expandEnvironmentReferences({ API_TOKEN: "${MISSING_TOKEN}" }, {})
    ).toThrow(/MISSING_TOKEN/);
  });

  it.each([
    ["missing-policy", { readonly: { allowRisk: ["read"] } }],
    ["", undefined]
  ])("rejects an undefined policy reference with contextual diagnostics", (policy, policies) => {
    let thrown: unknown;

    try {
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node" },
        policies,
        profiles: {
          work: { policy }
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MiftahError);
    if (!(thrown instanceof MiftahError)) {
      throw new Error("Expected a MiftahError for an undefined policy reference");
    }
    expect(thrown.code).toBe("POLICY_NOT_FOUND");
    expect(thrown.message).toMatch(policyNotFoundPattern);
    expect(thrown.message).toContain("profiles.work.policy");
    expect(thrown.message).toContain(`policy '${policy}'`);
  });

  it("does not derive the error code from user-controlled policy names", () => {
    let thrown: unknown;

    try {
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node" },
        profiles: {
          work: { policy: "DEFAULT_PROFILE_NOT_FOUND" }
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MiftahError);
    expect(thrown).toMatchObject({ code: "POLICY_NOT_FOUND" });
  });

  it.each([
    ["http://mcp.example.test/mcp", "http://localhost:3000/mcp"],
    ["http://mcp.example.test/mcp", "http://127.0.0.1:3000/mcp"],
    ["ftp://mcp.example.test/mcp", "http://[::1]:3000/mcp"]
  ])("requires HTTPS for remote upstream URLs while allowing loopback HTTP", (insecureUrl, loopbackUrl) => {
    const baseConfig = {
      version: "1",
      name: "remote",
      defaultProfile: "work",
      profiles: { work: {} }
    };

    expect(() =>
      validateConfig({
        ...baseConfig,
        upstream: { transport: "streamable-http", url: insecureUrl }
      })
    ).toThrow(/CONFIG_SCHEMA_INVALID.*upstream\.url/u);
    expect(() =>
      validateConfig({
        ...baseConfig,
        upstream: { transport: "streamable-http", url: loopbackUrl }
      })
    ).not.toThrow();
    expect(() =>
      validateConfig({
        ...baseConfig,
        upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" }
      })
    ).not.toThrow();
  });

  it("reports an insecure named remote upstream at its exact URL path", () => {
    let thrown: unknown;
    try {
      validateConfig({
        version: "1",
        name: "named-remote",
        defaultProfile: "work",
        upstreams: { provider: { transport: "streamable-http", url: "http://mcp.example.test/mcp" } },
        profiles: { work: {} }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MiftahError);
    if (!(thrown instanceof MiftahError)) throw new Error("Expected an insecure remote URL validation error");
    expect(thrown.details?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "upstreams.provider.url" })])
    );
  });
});
