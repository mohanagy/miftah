import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { presetConfig } from "../src/config/presets.js";
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
    ["process.idleTimeoutMs", { process: { idleTimeoutMs: 1 } }],
    ["process.restartOnCrash", { process: { restartOnCrash: true } }],
    ["process.maxRestarts", { process: { maxRestarts: 1 } }],
    ["process.shutdownTimeoutMs", { process: { shutdownTimeoutMs: 1 } }],
    ["process.maxConcurrentProfiles", { process: { maxConcurrentProfiles: 1 } }],
    ["routing.mode", { routing: { mode: "active" } }],
    ["routing.mode", { routing: { mode: "rules" } }],
    ["routing.plugins", { routing: { plugins: [] } }],
    ["profiles.default.metadata", { profiles: { default: { metadata: { owner: "team" } } } }],
    ["profiles.default.routing.match", { profiles: { default: { routing: { match: { repo: "acme/miftah" } } } } }],
    [
      "profiles.default.upstreams.primary.transport",
      { profiles: { default: { upstreams: { primary: { transport: "stdio" } } } } }
    ],
    [
      "profiles.default.upstreams.primary.command",
      { profiles: { default: { upstreams: { primary: { command: "node" } } } } }
    ],
    [
      "profiles.default.upstreams.primary.url",
      { profiles: { default: { upstreams: { primary: { url: "https://example.com/mcp" } } } } }
    ],
    ["security.requireProfileSwitchConfirmation", { security: { requireProfileSwitchConfirmation: true } }],
    ["security.redactSecrets", { security: { redactSecrets: false } }],
    ["audit.redact", { audit: { redact: false } }],
    ["tooling.managementToolPrefix", { tooling: { managementToolPrefix: "safe_" } }],
    ["tooling.upstreamToolNamespace", { tooling: { upstreamToolNamespace: "profile" } }],
    ["tooling.toolDiscoveryMode", { tooling: { toolDiscoveryMode: "allProfilesUnion" } }],
    ["state.persistActiveProfile", { state: { persistActiveProfile: true } }],
    ["state.path", { state: { path: ".miftah-state.json" } }],
    ["ui", { ui: { enabled: true } }]
  ])("rejects unsupported $0", (path, overrides) => {
    const error = validationError(baseConfig(overrides));

    expect(error.code).toBe(unsupportedConfigOption);
    expect(error.message).toContain(path);
  });

  it("accepts implemented options and compatible declarations", () => {
    const config = validateConfig({
      version: "1",
      name: "test",
      description: "Human-readable wrapper metadata",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node" },
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
      audit: { enabled: true, path: "audit.jsonl", format: "jsonl", includeArguments: false, redact: true },
      tooling: { collisionStrategy: "prefix-upstream", toolRiskOverrides: { write_tool: "write" } },
      secrets: { envFiles: [".env"], allowPlaintextSecrets: false }
    });

    expect(config.routing?.mode).toBe("hybrid");
    expect(config.process?.startupTimeoutMs).toBe(1_000);
    expect(config.security?.redactSecrets).toBe(true);
    expect(config.audit?.redact).toBe(true);
  });

  it.each(["generic", "github", "sentry"])("keeps the %s generated preset valid", (preset) => {
    expect(() => validateConfig(presetConfig("test", preset))).not.toThrow();
  });

  it.each(checkedInExamples)("keeps the checked-in %s example valid", (example) => {
    const input = JSON.parse(readFileSync(new URL(`../examples/${example}`, import.meta.url), "utf8"));

    expect(() => validateConfig(input)).not.toThrow();
  });
});
