import { describe, expect, it } from "vitest";
import type { ConfigDiagnostic } from "../src/config/diagnostics.js";
import { validateConfig } from "../src/config/validate-config.js";
import { MiftahError } from "../src/utils/errors.js";

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function firstDiagnostic(error: MiftahError): ConfigDiagnostic | undefined {
  return error.details?.diagnostics?.[0];
}

describe("configuration diagnostics", () => {
  it("rejects misspelled security settings with a typed remediation", () => {
    const error = validationError(baseConfig({ security: { redactSecretts: true } }));

    expect(error.code).toBe("CONFIG_UNKNOWN_OPTION");
    expect(error.details).toEqual({
      diagnostics: [
        {
          code: "CONFIG_UNKNOWN_OPTION",
          path: "security.redactSecretts",
          severity: "error",
          message: "Unknown configuration option 'redactSecretts'.",
          remediation: "Remove it or replace it with a property from `miftah schema`."
        }
      ]
    });
    expect(error.message).toContain("security.redactSecretts");
    expect(error.message).toContain("miftah schema");
    expect(firstDiagnostic(error)).toEqual({
      code: "CONFIG_UNKNOWN_OPTION",
      path: "security.redactSecretts",
      severity: "error",
      message: "Unknown configuration option 'redactSecretts'.",
      remediation: "Remove it or replace it with a property from `miftah schema`."
    });
  });

  it.each([
    ["root", baseConfig({ misspelledRootSetting: true }), "misspelledRootSetting"],
    [
      "upstream",
      baseConfig({ upstream: { transport: "stdio", command: "node", misspelledUpstreamSetting: true } }),
      "upstream.misspelledUpstreamSetting"
    ],
    [
      "named upstream",
      baseConfig({
        upstream: undefined,
        upstreams: { primary: { transport: "stdio", command: "node", misspelledUpstreamSetting: true } }
      }),
      "upstreams.primary.misspelledUpstreamSetting"
    ],
    [
      "profile",
      baseConfig({ profiles: { default: { misspelledProfileSetting: true } } }),
      "profiles.default.misspelledProfileSetting"
    ],
    [
      "profile upstream override",
      baseConfig({
        upstream: undefined,
        upstreams: { primary: { transport: "stdio", command: "node" } },
        profiles: { default: { upstreams: { primary: { misspelledOverrideSetting: true } } } }
      }),
      "profiles.default.upstreams.primary.misspelledOverrideSetting"
    ],
    [
      "routing",
      baseConfig({ routing: { misspelledRoutingSetting: true } }),
      "routing.misspelledRoutingSetting"
    ],
    [
      "routing rule",
      baseConfig({ routing: { rules: [{ when: {}, profile: "default", misspelledRuleSetting: true }] } }),
      "routing.rules.0.misspelledRuleSetting"
    ],
    [
      "policy",
      baseConfig({ policies: { readonly: { misspelledPolicySetting: true } } }),
      "policies.readonly.misspelledPolicySetting"
    ],
    ["security", baseConfig({ security: { misspelledSecuritySetting: true } }), "security.misspelledSecuritySetting"],
    ["process", baseConfig({ process: { misspelledProcessSetting: true } }), "process.misspelledProcessSetting"],
    ["audit", baseConfig({ audit: { misspelledAuditSetting: true } }), "audit.misspelledAuditSetting"],
    ["tooling", baseConfig({ tooling: { misspelledToolingSetting: true } }), "tooling.misspelledToolingSetting"],
    ["secrets", baseConfig({ secrets: { misspelledSecretsSetting: true } }), "secrets.misspelledSecretsSetting"]
  ])("rejects misspelled settings in the %s public section", (_section, input, path) => {
    const error = validationError(input);

    expect(error.code).toBe("CONFIG_UNKNOWN_OPTION");
    expect(error.details).toEqual({
      diagnostics: [
        expect.objectContaining({
          code: "CONFIG_UNKNOWN_OPTION",
          path,
          severity: "error"
        })
      ]
    });
  });

  it.each([
    [
      "missing upstream declaration",
      baseConfig({ upstream: undefined }),
      "CONFIG_SCHEMA_INVALID",
      "upstream",
      "Configure either `upstream` or `upstreams`."
    ],
    [
      "conflicting upstream declarations",
      baseConfig({ upstreams: { primary: { transport: "stdio", command: "node" } } }),
      "CONFIG_SCHEMA_INVALID",
      "upstream",
      "Configure either `upstream` or `upstreams`, not both."
    ],
    [
      "default profile",
      baseConfig({ defaultProfile: "missing" }),
      "DEFAULT_PROFILE_NOT_FOUND",
      "defaultProfile",
      "Choose a profile name defined under `profiles`."
    ],
    [
      "profile policy",
      baseConfig({ profiles: { default: { policy: "missing" } } }),
      "POLICY_NOT_FOUND",
      "profiles.default.policy",
      "Choose a policy name defined under `policies`."
    ],
    [
      "routing rule profile",
      baseConfig({ routing: { rules: [{ when: {}, profile: "missing" }] } }),
      "ROUTING_PROFILE_NOT_FOUND",
      "routing.rules.0.profile",
      "Choose a profile name defined under `profiles`."
    ],
    [
      "profile lock",
      baseConfig({ security: { lockToProfile: "missing" } }),
      "LOCK_PROFILE_NOT_FOUND",
      "security.lockToProfile",
      "Choose a profile name defined under `profiles`."
    ],
    [
      "per-profile upstream override",
      baseConfig({
        upstream: undefined,
        upstreams: { primary: { transport: "stdio", command: "node" } },
        profiles: { default: { upstreams: { missing: {} } } }
      }),
      "UPSTREAM_NOT_FOUND",
      "profiles.default.upstreams.missing",
      "Choose an upstream name defined under `upstreams` or remove the override."
    ]
  ])("rejects an invalid %s before runtime startup", (_reference, input, code, path, remediation) => {
    const error = validationError(input);

    expect(error.code).toBe(code);
    expect(error.details).toEqual({
      diagnostics: [
        expect.objectContaining({
          code,
          path,
          severity: "error",
          remediation
        })
      ]
    });
  });

  it("rejects unsupported config versions without automatic migration", () => {
    const error = validationError(baseConfig({ version: "2" }));

    expect(error.code).toBe("UNSUPPORTED_CONFIG_VERSION");
    expect(error.details).toEqual({
      diagnostics: [
        expect.objectContaining({
          code: "UNSUPPORTED_CONFIG_VERSION",
          path: "version",
          severity: "error",
          remediation: 'Set version to "1"; automatic config migrations are not supported.'
        })
      ]
    });
  });
});
