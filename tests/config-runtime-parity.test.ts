import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPresetConfig } from "../src/config/presets.js";
import { validateConfig } from "../src/config/validate-config.js";
import { MiftahError } from "../src/utils/errors.js";

const checkedInExamples = [
  "generic.miftah.json",
  "github.miftah.json",
  "multi-upstream.miftah.json",
  "sentry.miftah.json"
];
const unsupportedConfigOption = "UNSUPPORTED_CONFIG_OPTION";
const upstreamTrustPathPattern = /upstream\.trustToolAnnotations/u;
const unknownToolRiskPathPattern = /tooling\.unknownToolRisk/u;
const profileUpstreamTrustPathPattern = /profiles\.default\.upstreams\.primary\.trustToolAnnotations/u;

function baseConfig(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "1",
    name: "test",
    defaultProfile: "default",
    upstream: { transport: "stdio", command: "node" },
    profiles: { default: {} },
    ...overrides
  };
}

function validationError(input: unknown): MiftahError {
  try {
    validateConfig(input);
  } catch (error) {
    if (error instanceof MiftahError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected configuration validation to fail");
}

describe("config runtime parity", () => {
  it.each([
    ["process.startMode", { process: { startMode: "lazy" } }],
    ["process.cache", { process: { cache: true } }],
    ["routing.mode", { routing: { mode: "active" } }],
    ["routing.mode", { routing: { mode: "rules" } }],
    ["routing.mode", { routing: { mode: true } }],
    ["routing.plugins", { routing: { plugins: [] } }],
    ["routing.plugins", { routing: { plugins: {} } }],
    ["profiles.default.metadata", { profiles: { default: { metadata: { owner: "team" } } } }],
    ["profiles.default.metadata", { profiles: { default: { metadata: "team" } } }],
    ["security.redactSecrets", { security: { redactSecrets: false } }],
    ["audit.redact", { audit: { redact: false } }],
    ["tooling.managementToolPrefix", { tooling: { managementToolPrefix: "safe_" } }],
    ["tooling.managementToolPrefix", { tooling: { managementToolPrefix: 1 } }],
    ["tooling.upstreamToolNamespace", { tooling: { upstreamToolNamespace: "profile" } }],
    ["tooling.upstreamToolNamespace", { tooling: { upstreamToolNamespace: true } }],
    ["state.path", { state: { path: ".miftah-state.json" } }],
    ["state.path", { state: { path: 1 } }],
    ["ui", { ui: { enabled: true } }],
    ["ui", { ui: "enabled" }]
  ])("rejects unsupported $0", (path, overrides) => {
    const error = validationError(baseConfig(overrides));

    expect(error.code).toBe(unsupportedConfigOption);
    expect(error.message).toContain(path);
  });

  it("accepts a boolean profile-switch confirmation requirement and rejects a malformed one", () => {
    expect(validateConfig(baseConfig({ security: { requireProfileSwitchConfirmation: true } })).security).toEqual({
      requireProfileSwitchConfirmation: true
    });

    const malformed = validationError(baseConfig({ security: { requireProfileSwitchConfirmation: "true" } }));
    expect(malformed.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(malformed.message).toContain("security.requireProfileSwitchConfirmation");
  });

  it("accepts explicit active-profile state scopes and requires durable scopes to opt in", () => {
    expect(
      validateConfig(baseConfig({ state: { persistActiveProfile: true, scope: "workspace" } })).state
    ).toEqual({ persistActiveProfile: true, scope: "workspace" });
    expect(validateConfig(baseConfig({ state: { scope: "session" } })).state).toEqual({ scope: "session" });

    const processPersistence = validationError(
      baseConfig({ state: { persistActiveProfile: true, scope: "process" } })
    );
    const missingDurableOptIn = validationError(baseConfig({ state: { scope: "global" } }));
    const malformedPersistence = validationError(baseConfig({ state: { persistActiveProfile: "true" } }));

    expect(processPersistence.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(processPersistence.message).toContain("state.scope");
    expect(missingDurableOptIn.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(missingDurableOptIn.message).toContain("state.persistActiveProfile");
    expect(malformedPersistence.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(malformedPersistence.message).toContain("state.persistActiveProfile");
  });

  it("requires explicit, secret-backed protection before a non-loopback HTTP bind", () => {
    const config = validateConfig(
      baseConfig({
        server: {
          http: {
            host: "0.0.0.0",
            port: 8443,
            allowNonLoopback: true,
            authToken: "${MIFTAH_HTTP_TOKEN}",
            allowedHosts: ["mcp.example.test"],
            allowedOrigins: ["https://client.example.test"],
            maxSessions: 8,
            sessionIdleTimeoutMs: 15_000,
            maxRequestBytes: 8_192
          }
        }
      })
    );

    expect(config.server?.http).toEqual({
      host: "0.0.0.0",
      port: 8443,
      allowNonLoopback: true,
      authToken: "${MIFTAH_HTTP_TOKEN}",
      allowedHosts: ["mcp.example.test"],
      allowedOrigins: ["https://client.example.test"],
      maxSessions: 8,
      sessionIdleTimeoutMs: 15_000,
      maxRequestBytes: 8_192
    });

    const missingOptIn = validationError(
      baseConfig({
        server: {
          http: {
            host: "0.0.0.0",
            authToken: "${MIFTAH_HTTP_TOKEN}",
            allowedHosts: ["mcp.example.test"]
          }
        }
      })
    );
    const rawToken = "must-not-appear-in-diagnostics";
    const rawTokenError = validationError(
      baseConfig({
        server: {
          http: {
            host: "0.0.0.0",
            allowNonLoopback: true,
            authToken: rawToken,
            allowedHosts: ["mcp.example.test"]
          }
        }
      })
    );

    expect(missingOptIn.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(missingOptIn.message).toContain("server.http.allowNonLoopback");
    expect(rawTokenError.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(rawTokenError.message).toContain("server.http.authToken");
    expect(rawTokenError.message).not.toContain(rawToken);

    const malformedIpv6 = validationError(
      baseConfig({
        server: {
          http: {
            host: ":::",
            allowNonLoopback: true,
            authToken: "${MIFTAH_HTTP_TOKEN}",
            allowedHosts: ["mcp.example.test"]
          }
        }
      })
    );
    expect(malformedIpv6.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(malformedIpv6.message).toContain("server.http.host");
  });

  it("requires explicit annotation trust and validates the unknown-tool risk default", () => {
    const config = validateConfig(
      baseConfig({
        upstream: { transport: "stdio", command: "node", trustToolAnnotations: true },
        tooling: { unknownToolRisk: "destructive" }
      })
    );

    expect(config.upstream?.trustToolAnnotations).toBe(true);
    expect(config.tooling?.unknownToolRisk).toBe("destructive");
    expect(() => validateConfig(baseConfig({ upstream: { transport: "stdio", command: "node", trustToolAnnotations: "true" } }))).toThrow(
      upstreamTrustPathPattern
    );
    expect(() => validateConfig(baseConfig({ tooling: { unknownToolRisk: "read" } }))).toThrow(unknownToolRiskPathPattern);
    expect(() => validateConfig(baseConfig({
      upstreams: { primary: { transport: "stdio", command: "node" } },
      upstream: undefined,
      profiles: { default: { upstreams: { primary: { trustToolAnnotations: true } } } }
    }))).toThrow(profileUpstreamTrustPathPattern);
  });

  it.each([
    ["transport", "stdio"],
    ["transport", true],
    ["command", "node"],
    ["command", 1],
    ["url", "https://example.com/mcp"],
    ["url", false]
  ])("rejects unsupported per-upstream %s overrides", (option, value) => {
    const error = validationError({
      version: "1",
      name: "test",
      defaultProfile: "default",
      upstreams: { primary: { transport: "stdio", command: "node" } },
      profiles: { default: { upstreams: { primary: { [option]: value } } } }
    });

    expect(error.code).toBe(unsupportedConfigOption);
    expect(error.message).toContain(`profiles.default.upstreams.primary.${option}`);
  });

  it("accepts implemented options and compatible declarations", () => {
    const config = validateConfig({
      version: "1",
      name: "test",
      description: "Human-readable wrapper metadata",
      defaultProfile: "default",
      upstreams: { primary: { transport: "stdio", command: "node" } },
      profiles: {
        default: {
          description: "Default profile",
          tags: ["local"],
          env: { TOKEN: "${TOKEN}" },
          args: ["--profile", "default"],
          cwd: ".",
          headers: { "x-profile": "default" },
          policy: "readonly",
          upstreams: {
            primary: {
              args: ["--profile", "default"],
              env: { TOKEN: "${TOKEN}" },
              cwd: ".",
              headers: { "x-profile": "default" }
            }
          }
        }
      },
      routing: {
        mode: "hybrid",
        fallback: "activeProfile",
        rules: [{ name: "default", when: { "args.profile": "default" }, profile: "default" }]
      },
      policies: { readonly: { allowRisk: ["read"] } },
      security: {
        allowPlaintextSecrets: false,
        redactSecrets: true,
        allowProfileSwitchingFromMcp: true,
        requireExplicitProfileForDestructive: true,
        lockToProfile: null
      },
      process: { startupTimeoutMs: 1_000 },
      audit: {
        enabled: true,
        path: "audit.jsonl",
        format: "jsonl",
        includeArguments: false,
        redact: true,
        failureMode: "fail-open"
      },
      tooling: { collisionStrategy: "prefix-upstream", toolRiskOverrides: { write_tool: "write" } },
      secrets: { envFiles: [".env"], allowPlaintextSecrets: false },
      state: { persistActiveProfile: true, scope: "workspace" }
    });

    expect(config.routing?.mode).toBe("hybrid");
    expect(config.process?.startupTimeoutMs).toBe(1_000);
    expect(config.security?.redactSecrets).toBe(true);
    expect(config.audit?.redact).toBe(true);
    expect(config.audit?.failureMode).toBe("fail-open");
  });

  it("accepts implemented lifecycle controls", () => {
    const config = validateConfig(
      baseConfig({
        process: {
          startupTimeoutMs: 1_000,
          shutdownTimeoutMs: 500,
          idleTimeoutMs: 1_500,
          restartOnCrash: true,
          maxRestarts: 2,
          maxConcurrentProfiles: 3
        }
      })
    );

    expect(config.process).toEqual({
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      idleTimeoutMs: 1_500,
      restartOnCrash: true,
      maxRestarts: 2,
      maxConcurrentProfiles: 3
    });
  });

  it("accepts a bounded secret-provider timeout", () => {
    const config = validateConfig(
      baseConfig({
        secrets: { providerTimeoutMs: 15_000 }
      })
    );

    expect(config.secrets?.providerTimeoutMs).toBe(15_000);
  });

  it("validates local plugin allowlists and routing bindings against configured profiles", () => {
    const config = validateConfig(
      baseConfig({
        plugins: {
          timeoutMs: 15_000,
          allowlist: [
            { id: "consumer-secret", kind: "secret-provider", path: "./plugins/consumer-secret.mjs" },
            {
              id: "consumer-routing",
              kind: "routing-matcher",
              path: "./plugins/consumer-routing.mjs",
              bindings: { "consumer-default": "default" }
            }
          ]
        }
      })
    );

    expect(config.plugins).toEqual({
      timeoutMs: 15_000,
      allowlist: [
        { id: "consumer-secret", kind: "secret-provider", path: "./plugins/consumer-secret.mjs" },
        {
          id: "consumer-routing",
          kind: "routing-matcher",
          path: "./plugins/consumer-routing.mjs",
          bindings: { "consumer-default": "default" }
        }
      ]
    });

    const reservedProvider = validationError(
      baseConfig({
        plugins: { allowlist: [{ id: "env", kind: "secret-provider", path: "./plugins/env.mjs" }] }
      })
    );
    const duplicatePlugin = validationError(
      baseConfig({
        plugins: {
          allowlist: [
            { id: "duplicate", kind: "secret-provider", path: "./plugins/one.mjs" },
            {
              id: "duplicate",
              kind: "routing-matcher",
              path: "./plugins/two.mjs",
              bindings: { "duplicate-default": "default" }
            }
          ]
        }
      })
    );
    const missingBindingProfile = validationError(
      baseConfig({
        plugins: {
          allowlist: [
            {
              id: "missing-profile",
              kind: "routing-matcher",
              path: "./plugins/missing-profile.mjs",
              bindings: { "missing-profile-default": "absent" }
            }
          ]
        }
      })
    );
    const emptyBindings = validationError(
      baseConfig({
        plugins: {
          allowlist: [{ id: "empty", kind: "routing-matcher", path: "./plugins/empty.mjs", bindings: {} }]
        }
      })
    );
    const nonLocalPath = validationError(
      baseConfig({
        plugins: { allowlist: [{ id: "non-local", kind: "secret-provider", path: "plugins/non-local.mjs" }] }
      })
    );

    expect(reservedProvider.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(reservedProvider.message).toContain("plugins.allowlist.0.id");
    expect(duplicatePlugin.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(duplicatePlugin.message).toContain("plugins.allowlist.1.id");
    expect(missingBindingProfile.code).toBe("ROUTING_PROFILE_NOT_FOUND");
    expect(missingBindingProfile.message).toContain("plugins.allowlist.0.bindings.missing-profile-default");
    expect(emptyBindings.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(emptyBindings.message).toContain("plugins.allowlist.0.bindings");
    expect(nonLocalPath.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(nonLocalPath.message).toContain("plugins.allowlist.0.path");
  });

  it("limits a routing plugin to 64 configured bindings", () => {
    const bindings = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`binding-${index}`, "default"])
    );
    const error = validationError(
      baseConfig({
        plugins: {
          allowlist: [
            { id: "too-many-bindings", kind: "routing-matcher", path: "./plugins/too-many.mjs", bindings }
          ]
        }
      })
    );

    expect(error.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(error.message).toContain("plugins.allowlist.0.bindings");
  });

  it.each([100, 60_000])("accepts the plugin timeout boundary %s", (timeoutMs) => {
    const config = validateConfig(
      baseConfig({ plugins: { timeoutMs, allowlist: [{ id: "boundary", kind: "secret-provider", path: "./plugins/boundary.mjs" }] } })
    );

    expect(config.plugins?.timeoutMs).toBe(timeoutMs);
  });

  it.each([99, 60_001, 100.5])("rejects an out-of-range plugin timeout of %s", (timeoutMs) => {
    const error = validationError(
      baseConfig({ plugins: { timeoutMs, allowlist: [{ id: "timeout", kind: "secret-provider", path: "./plugins/timeout.mjs" }] } })
    );

    expect(error.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(error.message).toContain("plugins.timeoutMs");
  });

  it("accepts explicit bounded audit rotation and retention controls", () => {
    const config = validateConfig(
      baseConfig({
        audit: {
          path: "audit/events.jsonl",
          rotation: { maxBytes: 1_024, maxAgeMs: 60_000, retainFiles: 3 }
        }
      })
    );

    expect(config.audit?.rotation).toEqual({ maxBytes: 1_024, maxAgeMs: 60_000, retainFiles: 3 });
  });

  it("requires an audit rotation trigger when retention is configured", () => {
    const error = validationError(
      baseConfig({
        audit: { rotation: { retainFiles: 3 } }
      })
    );

    expect(error.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(error.message).toContain("audit.rotation");
  });

  it("accepts the explicit SHA-256 audit integrity chain", () => {
    const config = validateConfig(
      baseConfig({
        audit: { path: "audit/events.jsonl", integrity: { algorithm: "sha256-chain" } }
      })
    );

    expect(config.audit?.integrity).toEqual({ algorithm: "sha256-chain" });
  });

  it("rejects unsupported audit integrity algorithms", () => {
    const error = validationError(
      baseConfig({
        audit: { integrity: { algorithm: "signature" } }
      })
    );

    expect(error.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(error.message).toContain("audit.integrity.algorithm");
  });

  it.each([0, 99, 120_001, 1.5])("rejects an out-of-range secret-provider timeout of %s", (providerTimeoutMs) => {
    const error = validationError(
      baseConfig({
        secrets: { providerTimeoutMs }
      })
    );

    expect(error.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(error.message).toContain("secrets.providerTimeoutMs");
  });

  it("requires automatic recovery when a restart limit is configured", () => {
    const error = validationError(
      baseConfig({
        process: { maxRestarts: 2 }
      })
    );

    expect(error.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(error.message).toContain("process.maxRestarts");
  });

  it.each(["permissive", "strict"] as const)("accepts the %s discovery mode", (toolDiscoveryMode) => {
    const config = validateConfig(
      baseConfig({
        tooling: { toolDiscoveryMode }
      })
    );

    expect(config.tooling?.toolDiscoveryMode).toBe(toolDiscoveryMode);
  });

  it.each(["allProfilesUnion", {}])("rejects an unsupported discovery mode value", (toolDiscoveryMode) => {
    const error = validationError(
      baseConfig({
        tooling: { toolDiscoveryMode }
      })
    );

    expect(error.code).toBe("CONFIG_SCHEMA_INVALID");
    expect(error.message).toContain("tooling.toolDiscoveryMode");
  });

  it.each([
    ["generic", {}],
    ["github", {}],
    ["sentry", {}],
    ["generic-npx", { npmPackage: "server@1.2.3" }],
    ["generic-docker", {
      dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }],
    ["streamable-http", { url: "https://mcp.example.com" }]
  ])("keeps the %s generated preset valid", (preset, options) => {
    expect(() => validateConfig(buildPresetConfig("test", preset, options))).not.toThrow();
  });

  it.each(checkedInExamples)("keeps the checked-in %s example valid", (example) => {
    const input = JSON.parse(readFileSync(new URL(`../examples/${example}`, import.meta.url), "utf8"));

    expect(() => validateConfig(input)).not.toThrow();
  });
});
