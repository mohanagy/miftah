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
    security: { redactSecrets: true },
    audit: { redact: true, format: "jsonl" },
    state: { persistActiveProfile: true, scope: "workspace" }
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

  it("generates a strict draft 2019-09 schema from the public contract", () => {
    const schema = generateConfigSchema() as unknown as GeneratedConfigSchema;

    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2019-09/schema#",
      title: "Miftah configuration",
      additionalProperties: false
    });
    expect(schema.properties).not.toHaveProperty("ui");
    expect(schema.properties?.state).toMatchObject({ additionalProperties: false });
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
