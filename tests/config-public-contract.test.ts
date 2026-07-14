import { describe, expect, it } from "vitest";
import { generateConfigSchema } from "../src/config/generate-json-schema.js";
import { miftahPublicConfigSchema } from "../src/config/schema.js";
import { validateConfig } from "../src/config/validate-config.js";

interface PublicConfigSchema {
  safeParse(input: unknown): { success: boolean };
}

interface JsonSchemaNode {
  additionalProperties?: boolean | JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
}

interface GeneratedConfigSchema extends JsonSchemaNode {
  $schema?: string;
  title?: string;
}

const missingRotationTriggerError = /audit rotation requires maxBytes or maxAgeMs/u;
const unsupportedIntegrityAlgorithmError = /integrity\.algorithm/u;
const zeroByteRotationError = /maxBytes/u;
const oversizedRetentionError = /retainFiles/u;
const rotationWithoutAuditPathError = /audit\.path/u;
const disabledIntegrityAuditError = /audit\.enabled/u;

describe("public configuration contract", () => {
  const supportedConfig = {
    version: "1",
    name: "test",
    defaultProfile: "default",
    upstream: { transport: "stdio", command: "node" },
    profiles: {
      default: {
        isolation: {
          files: [
            {
              source: "credentials/default.json",
              destination: "credentials/default.json",
              environment: "DEFAULT_CREDENTIAL_PATH"
            }
          ]
        }
      }
    },
    routing: {
      mode: "hybrid",
      rules: [{ when: { "args.profile": "default" }, profile: "default" }]
    },
    plugins: {
      timeoutMs: 5_000,
      allowlist: [
        { id: "consumer-secret", kind: "secret-provider", path: "./plugins/consumer-secret.mjs" },
        {
          id: "consumer-routing",
          kind: "routing-matcher",
          path: "./plugins/consumer-routing.mjs",
          bindings: { "consumer-work": "default" }
        }
      ]
    },
    security: { redactSecrets: true },
    audit: {
      path: "audit/events.jsonl",
      redact: true,
      format: "jsonl",
      rotation: { maxBytes: 1_024, retainFiles: 7 },
      integrity: { algorithm: "sha256-chain" }
    },
    state: { persistActiveProfile: true, scope: "workspace" },
    server: {
      http: {
        host: "127.0.0.1",
        port: 3000,
        authToken: "${MIFTAH_HTTP_TOKEN}",
        maxSessions: 32,
        sessionIdleTimeoutMs: 60_000,
        maxRequestBytes: 1_048_576
      }
    }
  };

  it("shares supported structural acceptance between public and runtime schemas", () => {
    const publicSchema: PublicConfigSchema = miftahPublicConfigSchema;

    expect(publicSchema.safeParse(supportedConfig).success).toBe(true);
    expect(() => validateConfig(supportedConfig)).not.toThrow();

    const misspelledSecuritySetting = {
      ...supportedConfig,
      security: { redactSecretts: true }
    };
    expect(publicSchema.safeParse(misspelledSecuritySetting).success).toBe(false);
    expect(() => validateConfig(misspelledSecuritySetting)).toThrow(/CONFIG_UNKNOWN_OPTION/u);
  });

  it("does not advertise durable profile scopes without an explicit persistence opt-in", () => {
    const publicSchema: PublicConfigSchema = miftahPublicConfigSchema;
    const invalidState = { ...supportedConfig, state: { scope: "workspace" } };

    expect(publicSchema.safeParse(invalidState).success).toBe(false);
    expect(() => validateConfig(invalidState)).toThrow(/state\.persistActiveProfile/u);
  });

  it("keeps audit rotation and integrity declarations aligned with runtime validation", () => {
    const publicSchema: PublicConfigSchema = miftahPublicConfigSchema;
    const missingRotationTrigger = {
      ...supportedConfig,
      audit: { ...supportedConfig.audit, rotation: { retainFiles: 7 } }
    };
    const unsupportedIntegrityAlgorithm = {
      ...supportedConfig,
      audit: { ...supportedConfig.audit, integrity: { algorithm: "sha512-chain" } }
    };
    const zeroByteRotation = {
      ...supportedConfig,
      audit: { ...supportedConfig.audit, rotation: { maxBytes: 0, retainFiles: 7 } }
    };
    const oversizedRetention = {
      ...supportedConfig,
      audit: { ...supportedConfig.audit, rotation: { maxBytes: 1_024, retainFiles: 2_001 } }
    };
    const rotationWithoutAuditPath = {
      ...supportedConfig,
      audit: { rotation: { maxBytes: 1_024, retainFiles: 7 } }
    };
    const disabledIntegrityAudit = {
      ...supportedConfig,
      audit: { ...supportedConfig.audit, enabled: false, integrity: { algorithm: "sha256-chain" } }
    };

    expect(publicSchema.safeParse(missingRotationTrigger).success).toBe(false);
    expect(() => validateConfig(missingRotationTrigger)).toThrow(missingRotationTriggerError);
    expect(publicSchema.safeParse(unsupportedIntegrityAlgorithm).success).toBe(false);
    expect(() => validateConfig(unsupportedIntegrityAlgorithm)).toThrow(unsupportedIntegrityAlgorithmError);
    expect(publicSchema.safeParse(zeroByteRotation).success).toBe(false);
    expect(() => validateConfig(zeroByteRotation)).toThrow(zeroByteRotationError);
    expect(publicSchema.safeParse(oversizedRetention).success).toBe(false);
    expect(() => validateConfig(oversizedRetention)).toThrow(oversizedRetentionError);
    expect(publicSchema.safeParse(rotationWithoutAuditPath).success).toBe(false);
    expect(() => validateConfig(rotationWithoutAuditPath)).toThrow(rotationWithoutAuditPathError);
    expect(publicSchema.safeParse(disabledIntegrityAudit).success).toBe(false);
    expect(() => validateConfig(disabledIntegrityAudit)).toThrow(disabledIntegrityAuditError);
  });

  it("generates a strict draft 2019-09 schema from the public contract", () => {
    const schema = generateConfigSchema() as unknown as GeneratedConfigSchema;

    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2019-09/schema#",
      title: "Miftah configuration",
      additionalProperties: false
    });
    expect(schema.properties).not.toHaveProperty("ui");
    expect(schema.properties?.state).toMatchObject({ additionalProperties: false });
    expect(schema.properties?.server).toMatchObject({ additionalProperties: false });
    expect(schema.properties?.security).toMatchObject({ additionalProperties: false });
    const profileSchema = schema.properties?.profiles?.additionalProperties;
    if (profileSchema === undefined || typeof profileSchema === "boolean") {
      throw new Error("Expected generated profiles to use an object-valued additionalProperties schema.");
    }
    expect(profileSchema.properties?.isolation).toMatchObject({
      additionalProperties: false
    });
    expect(schema.properties?.routing?.properties?.rules?.additionalProperties).toBeUndefined();
  });
});
