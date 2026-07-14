import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateConfigSchema } from "../src/config/generate-json-schema.js";
import type { AuditConfig, AuditIntegrityConfig, AuditRotationConfig, MiftahConfig } from "../src/config/types.js";

type AssertFalse<Value extends false> = Value;

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

const validRotatingIntegrityAuditConfig: MiftahConfig = {
  ...publicConfig,
  audit: {
    path: "audit/events.jsonl",
    rotation: { maxBytes: 1_024, retainFiles: 7 },
    integrity: { algorithm: "sha256-chain" }
  }
};
void validRotatingIntegrityAuditConfig;

type ManagedAuditWithoutPathMustBeRejected = AssertFalse<
  { rotation: AuditRotationConfig } extends AuditConfig ? true : false
>;
void (0 as unknown as ManagedAuditWithoutPathMustBeRejected);

type DisabledManagedAuditMustBeRejected = AssertFalse<
  { path: string; enabled: false; integrity: AuditIntegrityConfig } extends AuditConfig ? true : false
>;
void (0 as unknown as DisabledManagedAuditMustBeRejected);

// @ts-expect-error Rotation must have a size or age trigger, not retention alone.
const invalidAuditRotationConfig: AuditRotationConfig = { retainFiles: 7 };
void invalidAuditRotationConfig;

const invalidIntegrityAuditConfig: MiftahConfig = {
  ...publicConfig,
  audit: {
    integrity: {
      // @ts-expect-error The public integrity contract has one reviewed algorithm.
      algorithm: "sha512-chain"
    }
  }
};
void invalidIntegrityAuditConfig;

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
  pattern?: string;
  const?: boolean | string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  uniqueItems?: boolean;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: boolean | SchemaNode;
  required?: string[];
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
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
    const auditRotation = audit?.rotation?.properties;
    const auditIntegrity = audit?.integrity?.properties;
    const tooling = root?.tooling?.properties;
    const secrets = root?.secrets?.properties;
    const state = root?.state?.properties;
    const server = root?.server?.properties;
    const httpServer = server?.http?.properties;

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
    expect(profile.properties?.isolation).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        files: {
          type: "array",
          maxItems: 32,
          uniqueItems: true
        },
        containerVolumes: {
          type: "array",
          maxItems: 32,
          uniqueItems: true
        }
      }
    });
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
    expect(profile.properties?.routing).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["match"],
      properties: {
        match: {
          type: "object",
          additionalProperties: false,
          properties: {
            github: {
              type: "object",
              additionalProperties: false,
              minProperties: 1,
              properties: {
                repositories: {
                  type: "array",
                  minItems: 1,
                  maxItems: 32,
                  uniqueItems: true
                }
              }
            },
            sentry: { type: "object", additionalProperties: false },
            jira: { type: "object", additionalProperties: false },
            linear: { type: "object", additionalProperties: false },
            posthog: { type: "object", additionalProperties: false }
          },
          minProperties: 1
        }
      }
    });
    const jiraSitePattern = profile.properties?.routing?.properties?.match?.properties?.jira?.properties?.sites?.items?.pattern;
    const posthogHostPattern = profile.properties?.routing?.properties?.match?.properties?.posthog?.properties?.hosts?.items?.pattern;
    if (!jiraSitePattern || !posthogHostPattern) {
      throw new Error("Expected generated matcher-origin patterns.");
    }
    for (const pattern of [jiraSitePattern, posthogHostPattern]) {
      const expression = new RegExp(pattern, "u");
      expect(expression.test("https://acme.atlassian.net")).toBe(true);
      expect(expression.test("https://acme.atlassian.net:8443")).toBe(true);
      expect(expression.test("https://acme.atlassian.net:443")).toBe(false);
      expect(expression.test("https://admin:secret@acme.atlassian.net/private?token=secret#fragment")).toBe(false);
      expect(expression.test("https://acme.atlassian.net/")).toBe(false);
    }
    expect(profileUpstreamOverride.properties).toHaveProperty("args");
    expect(profileUpstreamOverride.properties).toHaveProperty("env");
    expect(profileUpstreamOverride.properties).toHaveProperty("cwd");
    expect(profileUpstreamOverride.properties).toHaveProperty("headers");
    expect(profileUpstreamOverride.properties).toHaveProperty("isolation");
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
      failureMode: { enum: ["fail-open", "fail-closed"] },
      rotation: {
        type: "object",
        additionalProperties: false,
        required: ["retainFiles"]
      },
      integrity: {
        type: "object",
        additionalProperties: false,
        required: ["algorithm"]
      }
    });
    expect(auditRotation).toMatchObject({
      maxBytes: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
      maxAgeMs: { type: "integer", minimum: 0, maximum: 31_536_000_000 },
      retainFiles: { type: "integer", minimum: 0, maximum: 2_000 }
    });
    expect(auditIntegrity).toMatchObject({ algorithm: { const: "sha256-chain" } });
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
    expect(httpServer).toMatchObject({
      host: { type: "string" },
      port: { type: "integer", minimum: 0, maximum: 65_535 },
      allowNonLoopback: { const: true },
      authToken: { type: "string" },
      maxSessions: { type: "integer", minimum: 1, maximum: 256 },
      sessionIdleTimeoutMs: { type: "integer", minimum: 1_000, maximum: 86_400_000 },
      maxRequestBytes: { type: "integer", minimum: 1_024, maximum: 10_485_760 }
    });
    expect(root?.server?.additionalProperties).toBe(false);
    expect(server?.http?.additionalProperties).toBe(false);
    expect(state).not.toHaveProperty("path");
    expect(root?.state?.additionalProperties).toBe(false);
    expect(root?.routing?.additionalProperties).toBe(false);
    expect(profile.additionalProperties).toBe(false);
    expect(profileUpstreamOverride.additionalProperties).toBe(false);
    expect(root?.routing?.properties?.rules?.items?.properties?.when?.additionalProperties).toEqual({});
  });

  it("encodes isolation path safety in the generated editor schema", () => {
    const schema = generateConfigSchema() as unknown as ConfigSchema;
    const profile = mapValue(schema.properties?.profiles, "profiles");
    const isolation = profile.properties?.isolation;
    const fileSourcePattern = isolation?.properties?.files?.items?.properties?.source?.pattern;
    const containerSourcePattern = isolation?.properties?.containerVolumes?.items?.properties?.source?.pattern;
    const containerDestinationPattern = isolation?.properties?.containerVolumes?.items?.properties?.destination?.pattern;

    if (!fileSourcePattern || !containerSourcePattern || !containerDestinationPattern) {
      throw new Error("Expected generated schema patterns for every isolation path boundary.");
    }

    expect(new RegExp(fileSourcePattern, "u").test("../credentials/oauth.json")).toBe(false);
    expect(new RegExp(fileSourcePattern, "u").test("C:credentials/oauth.json")).toBe(false);
    expect(new RegExp(containerSourcePattern, "u").test("credentials/oauth,dst=/override")).toBe(false);
    expect(new RegExp(containerDestinationPattern, "u").test("/run/miftah/../oauth.json")).toBe(false);
    expect(new RegExp(containerDestinationPattern, "u").test("/run/miftah/oauth.json")).toBe(true);
  });

  it("requires exactly one upstream declaration in generated JSON Schema", () => {
    const schema = generateConfigSchema() as unknown as ConfigSchema;

    expect(schema.allOf).toContainEqual({
      oneOf: [{ required: ["upstream"] }, { required: ["upstreams"] }]
    });
  });

  it("requires a size or age trigger for generated audit rotation", () => {
    const schema = generateConfigSchema() as unknown as ConfigSchema;
    const rotation = schema.properties?.audit?.properties?.rotation;

    expect(rotation).toMatchObject({
      required: ["retainFiles"],
      anyOf: [{ required: ["maxBytes"] }, { required: ["maxAgeMs"] }]
    });
  });

  it("requires a path and enabled audit for generated managed audit options", () => {
    const schema = generateConfigSchema() as unknown as ConfigSchema;

    expect(schema.allOf).toEqual(
      expect.arrayContaining([
        {
          if: {
            required: ["audit"],
            properties: {
              audit: {
                anyOf: [{ required: ["rotation"] }, { required: ["integrity"] }]
              }
            }
          },
          then: {
            properties: {
              audit: {
                required: ["path"],
                properties: {
                  enabled: { not: { const: false } }
                }
              }
            }
          }
        }
      ])
    );
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
