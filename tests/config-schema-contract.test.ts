import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateConfigSchema } from "../src/config/generate-json-schema.js";
import type { MiftahConfig } from "../src/config/types.js";

const publicConfig: MiftahConfig = {
  version: "1",
  name: "typed",
  defaultProfile: "default",
  upstream: { transport: "stdio", command: "node" },
  profiles: { default: {} }
};
void publicConfig;

const invalidRoutingConfig: MiftahConfig = {
  ...publicConfig,
  routing: {
    // @ts-expect-error Public configurations only support the implemented hybrid mode.
    mode: "rules"
  }
};
void invalidRoutingConfig;

const invalidSecurityConfig: MiftahConfig = {
  ...publicConfig,
  security: {
    // @ts-expect-error Secret redaction cannot be disabled.
    redactSecrets: false
  }
};
void invalidSecurityConfig;

const invalidAuditConfig: MiftahConfig = {
  ...publicConfig,
  audit: {
    // @ts-expect-error Audit redaction cannot be disabled.
    redact: false
  }
};
void invalidAuditConfig;

const validStateConfig: MiftahConfig = {
  ...publicConfig,
  state: { persistActiveProfile: true, scope: "workspace" }
};
void validStateConfig;

const validRiskClassificationConfig: MiftahConfig = {
  ...publicConfig,
  upstream: { transport: "stdio", command: "node", trustToolAnnotations: true },
  tooling: { unknownToolRisk: "destructive" }
};
void validRiskClassificationConfig;

const invalidRiskClassificationConfig: MiftahConfig = {
  ...publicConfig,
  tooling: {
    // @ts-expect-error Unknown tool risk must be a supported risk level.
    unknownToolRisk: "unsafe"
  }
};
void invalidRiskClassificationConfig;

const invalidInMemoryStateConfig: MiftahConfig = {
  ...publicConfig,
  // @ts-expect-error In-memory scopes cannot opt in to durable persistence.
  state: { persistActiveProfile: true, scope: "session" }
};
void invalidInMemoryStateConfig;

const invalidDurableStateConfig: MiftahConfig = {
  ...publicConfig,
  // @ts-expect-error Durable scopes require explicit persistence opt-in.
  state: { scope: "global" }
};
void invalidDurableStateConfig;

const invalidStateConfig: MiftahConfig = {
  ...publicConfig,
  state: {
    // @ts-expect-error Arbitrary profile-state paths are intentionally unsupported.
    path: "state.json"
  }
};
void invalidStateConfig;

interface SchemaNode {
  type?: string;
  const?: boolean | string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: boolean | SchemaNode;
  required?: string[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
}

interface ConfigSchema extends SchemaNode {
  $schema?: string;
  title?: string;
}

function mapValue(node: SchemaNode | undefined, name: string): SchemaNode {
  if (!node || typeof node.additionalProperties !== "object") {
    throw new Error(`Expected an object map for '${name}'.`);
  }
  return node.additionalProperties;
}

describe("published config schema", () => {
  it("pins the schema generator to its reviewed output version", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(manifest.dependencies["zod-to-json-schema"]).toBe("3.25.2");
  });

  it("advertises only the runtime-supported configuration surface", () => {
    const schema = generateConfigSchema() as unknown as ConfigSchema;
    const root = schema.properties;
    const upstream = root?.upstream?.properties;
    const routing = root?.routing?.properties;
    const profile = mapValue(root?.profiles, "profiles");
    const profileUpstreamOverride = mapValue(profile.properties?.upstreams, "profile upstreams");
    const process = root?.process?.properties;
    const security = root?.security?.properties;
    const audit = root?.audit?.properties;
    const tooling = root?.tooling?.properties;
    const secrets = root?.secrets?.properties;
    const state = root?.state?.properties;

    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2019-09/schema#",
      title: "Miftah configuration",
      additionalProperties: false
    });
    expect(root).not.toHaveProperty("ui");
    expect(upstream).toMatchObject({ trustToolAnnotations: { type: "boolean" } });
    expect(routing).toMatchObject({ mode: { const: "hybrid" } });
    expect(routing).not.toHaveProperty("plugins");
    expect(profile.properties).toHaveProperty("headers");
    expect(profile.properties).toHaveProperty("upstreams");
    expect(profile.properties?.lease).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["ttlMs", "requiredForRisk"],
      properties: {
        ttlMs: { type: "integer", minimum: 1_000, maximum: 3_600_000 },
        requiredForRisk: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { enum: ["write", "destructive"] }
        }
      }
    });
    expect(profile.properties).not.toHaveProperty("metadata");
    expect(profile.properties).not.toHaveProperty("routing");
    expect(profileUpstreamOverride.properties).toHaveProperty("args");
    expect(profileUpstreamOverride.properties).toHaveProperty("env");
    expect(profileUpstreamOverride.properties).toHaveProperty("cwd");
    expect(profileUpstreamOverride.properties).toHaveProperty("headers");
    expect(profileUpstreamOverride.properties).not.toHaveProperty("transport");
    expect(profileUpstreamOverride.properties).not.toHaveProperty("command");
    expect(profileUpstreamOverride.properties).not.toHaveProperty("url");
    expect(Object.keys(process ?? {})).toEqual([
      "startupTimeoutMs",
      "shutdownTimeoutMs",
      "idleTimeoutMs",
      "restartOnCrash",
      "maxRestarts",
      "maxConcurrentProfiles"
    ]);
    expect(security).toMatchObject({
      redactSecrets: { const: true },
      requireProfileSwitchConfirmation: { type: "boolean" },
      allowProfileLockingFromMcp: { type: "boolean" },
      requireExplicitSelectionForDestructive: { type: "boolean" }
    });
    expect(audit).toMatchObject({
      format: { const: "jsonl" },
      redact: { const: true },
      failureMode: { enum: ["fail-open", "fail-closed"] }
    });
    expect(tooling).not.toHaveProperty("managementToolPrefix");
    expect(tooling).not.toHaveProperty("upstreamToolNamespace");
    expect(tooling).toMatchObject({
      toolDiscoveryMode: { enum: ["permissive", "strict"] },
      unknownToolRisk: { enum: ["write", "destructive"] }
    });
    expect(secrets).toMatchObject({
      providerTimeoutMs: { minimum: 100, maximum: 120_000 }
    });
    expect(state).toMatchObject({
      persistActiveProfile: { type: "boolean" },
      scope: { enum: ["process", "session", "workspace", "global"] }
    });
    expect(state).not.toHaveProperty("path");
    expect(root?.state?.additionalProperties).toBe(false);
    expect(root?.routing?.additionalProperties).toBe(false);
    expect(profile.additionalProperties).toBe(false);
    expect(profileUpstreamOverride.additionalProperties).toBe(false);
    expect(root?.routing?.properties?.rules?.items?.properties?.when?.additionalProperties).toEqual({});
  });

  it("requires exactly one upstream declaration in generated JSON Schema", () => {
    const schema = generateConfigSchema() as unknown as ConfigSchema;

    expect(schema.allOf).toContainEqual({
      oneOf: [{ required: ["upstream"] }, { required: ["upstreams"] }]
    });
  });

  it("requires an explicit opt-in for durable active-profile state in generated JSON Schema", () => {
    const schema = generateConfigSchema() as unknown as ConfigSchema;

    expect(schema.allOf).toEqual(
      expect.arrayContaining([
        {
          if: {
            required: ["state"],
            properties: {
              state: {
                required: ["persistActiveProfile"],
                properties: { persistActiveProfile: { const: true } }
              }
            }
          },
          then: {
            properties: {
              state: {
                required: ["scope"],
                properties: { scope: { enum: ["workspace", "global"] } }
              }
            }
          }
        },
        {
          if: {
            required: ["state"],
            properties: {
              state: {
                required: ["scope"],
                properties: { scope: { enum: ["workspace", "global"] } }
              }
            }
          },
          then: {
            properties: {
              state: {
                required: ["persistActiveProfile"],
                properties: { persistActiveProfile: { const: true } }
              }
            }
          }
        }
      ])
    );
  });
});
