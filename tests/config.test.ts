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
const profileIsolationTransportPattern = /profiles\.work\.isolation/u;
const namedUpstreamIsolationTransportPattern = /profiles\.work\.upstreams\.remote\.isolation/u;
const homeBindingReplacementPathPattern = /profiles\.work\.isolation\.files\.0\.environment/u;
const containerVolumeEnvironmentMismatchPathPattern = /profiles\.work\.isolation\.containerVolumes\.0\.environment/u;

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

  it("accepts typed profile-local bindings for every built-in provider matcher", () => {
    const config = validateConfig({
      version: "1",
      name: "provider-routing",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: ["server.js"] },
      profiles: {
        work: {
          routing: {
            match: {
              github: { repositories: ["acme/work"], organizations: ["acme"] },
              sentry: { organizations: ["acme"], projects: ["acme/api"], environments: ["production"] },
              jira: { sites: ["https://acme.atlassian.net"], projects: ["OPS"] },
              linear: { workspaces: ["acme"], teams: ["eng"] },
              posthog: { hosts: ["https://app.posthog.com"], projects: ["123"] }
            }
          }
        }
      }
    });

    expect(config.profiles.work?.routing?.match?.github?.repositories).toEqual(["acme/work"]);
    expect(config.profiles.work?.routing?.match?.posthog?.projects).toEqual(["123"]);
  });

  it.each([
    [
      "a duplicate GitHub repository",
      { github: { repositories: ["acme/work", "acme/work"] } },
      "profiles.work.routing.match.github.repositories.1"
    ],
    [
      "a noncanonical GitHub repository",
      { github: { repositories: ["Acme/work"] } },
      "profiles.work.routing.match.github.repositories.0"
    ],
    [
      "Jira site credentials",
      { jira: { sites: ["https://admin:secret@acme.atlassian.net"] } },
      "profiles.work.routing.match.jira.sites.0"
    ],
    [
      "a PostHog host query",
      { posthog: { hosts: ["https://app.posthog.com?token=secret"] } },
      "profiles.work.routing.match.posthog.hosts.0"
    ],
    [
      "an oversized Jira site",
      { jira: { sites: [`https://${"a".repeat(246)}.com`] } },
      "profiles.work.routing.match.jira.sites.0"
    ],
    [
      "a non-decimal PostHog project",
      { posthog: { projects: ["project-one"] } },
      "profiles.work.routing.match.posthog.projects.0"
    ],
    [
      "a noncanonical Linear workspace",
      { linear: { workspaces: ["Acme"] } },
      "profiles.work.routing.match.linear.workspaces.0"
    ]
  ])("rejects %s in profile routing matcher configuration", (_label, match, expectedPath) => {
    let failure: unknown;
    try {
      validateConfig({
        version: "1",
        name: "provider-routing",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", args: ["server.js"] },
        profiles: { work: { routing: { match } } }
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MiftahError);
    expect((failure as MiftahError).details?.diagnostics?.map((diagnostic) => diagnostic.path)).toContain(expectedPath);
  });

  it("accepts a profile isolation declaration and additional named-upstream configuration", () => {
    const config = validateConfig({
      version: "1",
      name: "github",
      defaultProfile: "work",
      upstreams: { github: { transport: "stdio", command: "node", args: ["server.js"] } },
      profiles: {
        work: {
          isolation: {
            files: [
              {
                source: "credentials/work-oauth.json",
                destination: "credentials/oauth.json",
                environment: "OAUTH_CREDENTIAL_PATH"
              }
            ]
          },
          upstreams: {
            github: {
              isolation: {
                containerVolumes: [
                  {
                    source: "credentials/oauth.json",
                    destination: "/run/miftah/oauth.json",
                    environment: "OAUTH_CREDENTIAL_PATH"
                  }
                ]
              }
            }
          }
        }
      }
    });

    expect(config.profiles.work?.isolation?.files).toEqual([
      {
        source: "credentials/work-oauth.json",
        destination: "credentials/oauth.json",
        environment: "OAUTH_CREDENTIAL_PATH"
      }
    ]);
    expect(config.profiles.work?.upstreams?.github?.isolation?.containerVolumes).toEqual([
      {
        source: "credentials/oauth.json",
        destination: "/run/miftah/oauth.json",
        environment: "OAUTH_CREDENTIAL_PATH"
      }
    ]);
  });

  it("rejects profile isolation for a non-stdio default upstream during configuration validation", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "remote-isolation",
        defaultProfile: "work",
        upstream: { transport: "streamable-http", url: "https://example.test/mcp" },
        profiles: {
          work: {
            isolation: {
              files: [{ source: "credentials/oauth.json", destination: "credentials/oauth.json" }]
            }
          }
        }
      })
    ).toThrow(profileIsolationTransportPattern);
  });

  it("rejects named-upstream isolation for a non-stdio upstream during configuration validation", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "named-remote-isolation",
        defaultProfile: "work",
        upstreams: {
          remote: { transport: "sse", url: "https://example.test/mcp" }
        },
        profiles: {
          work: {
            upstreams: {
              remote: {
                isolation: {
                  files: [{ source: "credentials/oauth.json", destination: "credentials/oauth.json" }]
                }
              }
            }
          }
        }
      })
    ).toThrow(namedUpstreamIsolationTransportPattern);
  });

  it("rejects profile isolation inherited by a non-stdio named upstream during configuration validation", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "mixed-transport-isolation",
        defaultProfile: "work",
        upstreams: {
          local: { transport: "stdio", command: "node", args: ["server.js"] },
          remote: { transport: "http", url: "https://example.test/mcp" }
        },
        profiles: {
          work: {
            isolation: {
              files: [{ source: "credentials/oauth.json", destination: "credentials/oauth.json" }]
            }
          }
        }
      })
    ).toThrow(profileIsolationTransportPattern);
  });

  it("allows a named stdio isolation override when a sibling upstream is remote", () => {
    const config = validateConfig({
      version: "1",
      name: "targeted-isolation",
      defaultProfile: "work",
      upstreams: {
        local: { transport: "stdio", command: "node", args: ["server.js"] },
        remote: { transport: "http", url: "https://example.test/mcp" }
      },
      profiles: {
        work: {
          upstreams: {
            local: {
              isolation: {
                files: [{ source: "credentials/oauth.json", destination: "credentials/oauth.json" }]
              }
            }
          }
        }
      }
    });

    expect(config.profiles.work?.upstreams?.local?.isolation?.files).toHaveLength(1);
  });

  it("rejects duplicate isolation destinations added by a named-upstream override", () => {
    let failure: unknown;
    try {
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstreams: { github: { transport: "stdio", command: "node", args: ["server.js"] } },
        profiles: {
          work: {
            isolation: {
              files: [{ source: "credentials/base.json", destination: "credentials/oauth.json" }],
              containerVolumes: [{ source: "home", destination: "/home/miftah" }]
            },
            upstreams: {
              github: {
                isolation: {
                  files: [{ source: "credentials/target.json", destination: "credentials/oauth.json" }],
                  containerVolumes: [{ source: "appdata", destination: "/home/miftah" }]
                }
              }
            }
          }
        }
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MiftahError);
    expect((failure as MiftahError).details?.diagnostics?.map((diagnostic) => diagnostic.path)).toEqual(
      expect.arrayContaining([
        "profiles.work.upstreams.github.isolation.files.0.destination",
        "profiles.work.upstreams.github.isolation.containerVolumes.0.destination"
      ])
    );
  });

  it("rejects cross-scope isolation environment collisions and incompatible file-volume handoffs", () => {
    let failure: unknown;
    try {
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstreams: { github: { transport: "stdio", command: "node", args: ["server.js"] } },
        profiles: {
          work: {
            isolation: {
              files: [
                { source: "credentials/base-token.json", destination: "credentials/base-token.json", environment: "TOKEN" },
                {
                  source: "credentials/base-oauth.json",
                  destination: "credentials/base-oauth.json",
                  environment: "OAUTH_CREDENTIAL_PATH"
                }
              ],
              containerVolumes: [{ source: "home", destination: "/home/miftah", environment: "HOME_DIR" }]
            },
            upstreams: {
              github: {
                isolation: {
                  files: [
                    { source: "credentials/target-token.json", destination: "credentials/target-token.json", environment: "token" },
                    { source: "credentials/target-home.json", destination: "credentials/target-home.json", environment: "home_dir" }
                  ],
                  containerVolumes: [
                    {
                      source: "credentials/other-oauth.json",
                      destination: "/run/miftah/oauth.json",
                      environment: "oauth_credential_path"
                    }
                  ]
                }
              }
            }
          }
        }
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MiftahError);
    expect((failure as MiftahError).details?.diagnostics?.map((diagnostic) => diagnostic.path)).toEqual(
      expect.arrayContaining([
        "profiles.work.upstreams.github.isolation.files.0.environment",
        "profiles.work.upstreams.github.isolation.files.1.environment",
        "profiles.work.upstreams.github.isolation.containerVolumes.0.environment"
      ])
    );
  });

  it("rejects an isolation mapping that tries to replace a generated HOME binding", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", args: ["server.js"] },
        profiles: {
          work: {
            isolation: {
              files: [
                {
                  source: "credentials/work-oauth.json",
                  destination: "credentials/oauth.json",
                  environment: "HOME"
                }
              ]
            }
          }
        }
      })
    ).toThrow(homeBindingReplacementPathPattern);
  });

  it("rejects a container environment binding that does not map the same isolated file", () => {
    expect(() =>
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", args: ["server.js"] },
        profiles: {
          work: {
            isolation: {
              files: [
                {
                  source: "credentials/work-oauth.json",
                  destination: "credentials/oauth.json",
                  environment: "OAUTH_CREDENTIAL_PATH"
                }
              ],
              containerVolumes: [
                {
                  source: "credentials/other.json",
                  destination: "/run/miftah/oauth.json",
                  environment: "OAUTH_CREDENTIAL_PATH"
                }
              ]
            }
          }
        }
      })
    ).toThrow(containerVolumeEnvironmentMismatchPathPattern);
  });

  it("allows a container environment binding for the exact copied file it mounts", () => {
    const config = validateConfig({
      version: "1",
      name: "github",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: ["server.js"] },
      profiles: {
        work: {
          isolation: {
            files: [
              {
                source: "credentials/work-oauth.json",
                destination: "credentials/oauth.json",
                environment: "OAUTH_CREDENTIAL_PATH"
              }
            ],
            containerVolumes: [
              {
                source: "credentials/oauth.json",
                destination: "/run/miftah/oauth.json",
                environment: "OAUTH_CREDENTIAL_PATH"
              }
            ]
          }
        }
      }
    });

    expect(config.profiles.work?.isolation?.containerVolumes?.[0]?.environment).toBe("OAUTH_CREDENTIAL_PATH");
  });

  it.each([
    ["a parent-directory source", "../credentials/work-oauth.json", "credentials/oauth.json", "profiles.work.isolation.files.0.source"],
    ["a Windows drive-relative source", "C:credentials/work-oauth.json", "credentials/oauth.json", "profiles.work.isolation.files.0.source"],
    ["an absolute destination", "credentials/work-oauth.json", "/tmp/oauth.json", "profiles.work.isolation.files.0.destination"],
    ["a traversal destination", "credentials/work-oauth.json", "credentials/../oauth.json", "profiles.work.isolation.files.0.destination"],
    ["a comma-delimited container source", "credentials/oauth,dst=/override", "/run/miftah/oauth.json", "profiles.work.isolation.containerVolumes.0.source"],
    ["an invalid container destination", "credentials/oauth.json", "run/miftah/oauth.json", "profiles.work.isolation.containerVolumes.0.destination"]
  ])("rejects %s in isolation mappings", (_label, source, destination, expectedPath) => {
    const isolation = expectedPath.includes("containerVolumes")
      ? { containerVolumes: [{ source, destination }] }
      : { files: [{ source, destination }] };

    let thrown: unknown;
    try {
      validateConfig({
        version: "1",
        name: "github",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: "node", args: ["server.js"] },
        profiles: { work: { isolation } }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MiftahError);
    expect((thrown as MiftahError).details?.diagnostics?.map((diagnostic) => diagnostic.path)).toContain(expectedPath);
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
