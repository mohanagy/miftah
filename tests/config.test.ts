import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { expandEnvironmentReferences, expandEnvironmentReferencesWithSecretValues } from "../src/config/env-expand.js";
import type { IdentityConfig } from "../src/config/types.js";
import { MiftahError } from "../src/utils/errors.js";

const policyNotFoundPattern = /POLICY_NOT_FOUND/u;
const duplicateIdentityRiskPattern = /profiles\.work\.identity\.requiredForRisk/u;
const identityProbeProviderPattern = /profiles\.work\.identity\.probe\.provider/u;
const identityExpectedLoginPattern = /profiles\.work\.identity\.expected\.login/u;
const insecureRemoteUrlPattern = /CONFIG_SCHEMA_INVALID.*upstream\.url/u;

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

  it("accepts an explicit profile-switch confirmation requirement", () => {
    const config = validateConfig({
      version: "1",
      name: "github",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: ["server.js"] },
      profiles: { work: {}, personal: {} },
      security: { requireProfileSwitchConfirmation: true }
    });

    expect(config.security?.requireProfileSwitchConfirmation).toBe(true);
  });

  it("accepts an explicit runtime profile-locking opt-in", () => {
    const config = validateConfig({
      version: "1",
      name: "github",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: ["server.js"] },
      profiles: { work: {}, personal: {} },
      security: { allowProfileLockingFromMcp: true }
    });

    expect(config.security?.allowProfileLockingFromMcp).toBe(true);
  });

  it("accepts an explicit-selection guard for destructive operations", () => {
    const config = validateConfig({
      version: "1",
      name: "github",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: ["server.js"] },
      profiles: { work: {}, personal: {} },
      security: { requireExplicitSelectionForDestructive: true }
    });

    expect(config.security?.requireExplicitSelectionForDestructive).toBe(true);
  });

  it("accepts an explicit profile lease for risky operations", () => {
    const config = validateConfig({
      version: "1",
      name: "github",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: ["server.js"] },
      profiles: {
        work: {
          lease: { ttlMs: 60_000, requiredForRisk: ["write", "destructive"] }
        }
      }
    });

    expect(config.profiles.work?.lease).toEqual({ ttlMs: 60_000, requiredForRisk: ["write", "destructive"] });
  });

  it.each([
    ["an empty risk list", { ttlMs: 60_000, requiredForRisk: [] }, "profiles.work.lease.requiredForRisk"],
    ["a duplicate risk", { ttlMs: 60_000, requiredForRisk: ["write", "write"] }, "profiles.work.lease.requiredForRisk"],
    ["the unsupported read risk", { ttlMs: 60_000, requiredForRisk: ["read"] }, "profiles.work.lease.requiredForRisk.0"],
    ["a zero TTL", { ttlMs: 0, requiredForRisk: ["write"] }, "profiles.work.lease.ttlMs"],
    ["a negative TTL", { ttlMs: -1, requiredForRisk: ["write"] }, "profiles.work.lease.ttlMs"],
    ["an oversized TTL", { ttlMs: 3_600_001, requiredForRisk: ["write"] }, "profiles.work.lease.ttlMs"],
    ["an unknown lease option", { ttlMs: 60_000, requiredForRisk: ["write"], extra: true }, "profiles.work.lease.extra"]
  ])("rejects a profile lease with %s at its exact path", (_label, lease, expectedPath) => {
    let thrown: unknown;
    try {
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", args: ["server.js"] },
        profiles: { work: { lease } }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MiftahError);
    const diagnostics = (thrown as MiftahError).details?.diagnostics ?? [];
    expect(diagnostics.map((diagnostic) => diagnostic.path)).toContain(expectedPath);
  });

  it("accepts an opt-in profile identity verifier for risky operations", () => {
    const config = validateConfig({
      version: "1",
      name: "github",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: ["server.js"] },
      profiles: {
        work: {
          identity: {
            expected: { provider: "github", login: "mona" },
            probe: { tool: "whoami", resultFormat: "text", provider: "github" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write", "destructive"]
          }
        }
      }
    });

    expect(config.profiles.work?.identity).toEqual({
      expected: { provider: "github", login: "mona" },
      probe: { tool: "whoami", resultFormat: "text", provider: "github" },
      maxAgeMs: 60_000,
      requiredForRisk: ["write", "destructive"]
    });
  });

  it("rejects duplicate identity risk requirements", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", args: ["server.js"] },
        profiles: {
          work: {
            identity: {
              expected: { login: "mona" },
              probe: { tool: "whoami", resultFormat: "text" },
              maxAgeMs: 60_000,
              requiredForRisk: ["write", "write"]
            }
          }
        }
      })
    ).toThrow(duplicateIdentityRiskPattern);
  });

  it.each([
    ["organization", { organization: "github" }],
    ["host", { host: "github.com" }]
  ])("rejects a text identity probe that cannot verify %s", (field, expected) => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", args: ["server.js"] },
        profiles: {
          work: {
            identity: {
              expected,
              probe: { tool: "whoami", resultFormat: "text" },
              maxAgeMs: 60_000
            }
          }
        }
      })
    ).toThrow(new RegExp(`profiles\\.work\\.identity\\.expected\\.${field}`, "u"));
  });

  it("rejects a text identity probe whose static provider differs from the expected provider", () => {
    // This structurally type-checks; validateConfig must enforce provider equality at runtime.
    const mismatchedTextProviderIdentity: IdentityConfig = {
      expected: { provider: "github", login: "mona" },
      probe: { tool: "whoami", resultFormat: "text", provider: "gitlab" },
      maxAgeMs: 60_000
    };

    expect(() =>
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", args: ["server.js"] },
        profiles: {
          work: {
            identity: mismatchedTextProviderIdentity
          }
        }
      })
    ).toThrow(identityProbeProviderPattern);
  });

  it("rejects a static provider on a JSON identity probe", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", args: ["server.js"] },
        profiles: {
          work: {
            identity: {
              expected: { provider: "github", login: "mona" },
              probe: { tool: "identity", resultFormat: "json", provider: "github" },
              maxAgeMs: 60_000
            }
          }
        }
      })
    ).toThrow(identityProbeProviderPattern);
  });

  it("rejects a text identity probe that has no response-derived expected field", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", args: ["server.js"] },
        profiles: {
          work: {
            identity: {
              expected: { provider: "github" },
              probe: { tool: "whoami", resultFormat: "text", provider: "github" },
              maxAgeMs: 60_000
            }
          }
        }
      })
    ).toThrow(identityExpectedLoginPattern);
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
    ).toThrow(insecureRemoteUrlPattern);
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
