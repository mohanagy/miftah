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
    ["profiles.default.routing.match", { profiles: { default: { routing: { match: { repo: "acme/miftah" } } } } }],
    ["profiles.default.routing.match", { profiles: { default: { routing: { match: "acme/miftah" } } } }],
    ["security.requireProfileSwitchConfirmation", { security: { requireProfileSwitchConfirmation: true } }],
    ["security.requireProfileSwitchConfirmation", { security: { requireProfileSwitchConfirmation: "true" } }],
    ["security.redactSecrets", { security: { redactSecrets: false } }],
    ["audit.redact", { audit: { redact: false } }],
    ["tooling.managementToolPrefix", { tooling: { managementToolPrefix: "safe_" } }],
    ["tooling.managementToolPrefix", { tooling: { managementToolPrefix: 1 } }],
    ["tooling.upstreamToolNamespace", { tooling: { upstreamToolNamespace: "profile" } }],
    ["tooling.upstreamToolNamespace", { tooling: { upstreamToolNamespace: true } }],
    ["state.persistActiveProfile", { state: { persistActiveProfile: true } }],
    ["state.persistActiveProfile", { state: { persistActiveProfile: "true" } }],
    ["state.path", { state: { path: ".miftah-state.json" } }],
    ["state.path", { state: { path: 1 } }],
    ["ui", { ui: { enabled: true } }],
    ["ui", { ui: "enabled" }]
  ])("rejects unsupported $0", (path, overrides) => {
    const error = validationError(baseConfig(overrides));

    expect(error.code).toBe(unsupportedConfigOption);
    expect(error.message).toContain(path);
  });

  it("rejects an empty state declaration as an unsupported option", () => {
    const error = validationError(baseConfig({ state: {} }));

    expect(error.code).toBe(unsupportedConfigOption);
    expect(error.message).toContain("state");
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
      secrets: { envFiles: [".env"], allowPlaintextSecrets: false }
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
