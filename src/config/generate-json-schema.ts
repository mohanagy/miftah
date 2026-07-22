import { zodToJsonSchema } from "zod-to-json-schema";
import { CANONICAL_HTTPS_ORIGIN_PATTERN, miftahPublicConfigSchema } from "./schema.js";

type SchemaObject = Record<string, unknown>;

function requireSchemaObject(value: unknown, description: string): SchemaObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Generated configuration schema is missing ${description}.`);
  }
  return value as SchemaObject;
}

/** zod-to-json-schema cannot emit the uniqueness half of this Zod super-refinement. */
function addProfileLeaseArrayConstraints(schema: SchemaObject): void {
  const rootProperties = requireSchemaObject(schema.properties, "root properties");
  const profiles = requireSchemaObject(rootProperties.profiles, "profiles schema");
  const profile = requireSchemaObject(profiles.additionalProperties, "profile schema");
  const profileProperties = requireSchemaObject(profile.properties, "profile properties");
  const lease = requireSchemaObject(profileProperties.lease, "profile lease schema");
  const leaseProperties = requireSchemaObject(lease.properties, "profile lease properties");
  const requiredForRisk = requireSchemaObject(leaseProperties.requiredForRisk, "profile lease risk requirements");
  requiredForRisk.maxItems = 2;
  requiredForRisk.uniqueItems = true;
}

/** Zod object-array refinements need an explicit editor-schema duplicate-item constraint. */
function addProfileIsolationArrayConstraints(schema: SchemaObject): void {
  const rootProperties = requireSchemaObject(schema.properties, "root properties");
  const profiles = requireSchemaObject(rootProperties.profiles, "profiles schema");
  const profile = requireSchemaObject(profiles.additionalProperties, "profile schema");
  const profileProperties = requireSchemaObject(profile.properties, "profile properties");
  // zod-to-json-schema shares the named-upstream shape through a reference to this first occurrence.
  const isolationProperties = requireSchemaObject(
    requireSchemaObject(profileProperties.isolation, "profile isolation schema").properties,
    "profile isolation schema properties"
  );
  for (const name of ["files", "containerVolumes"] as const) {
    requireSchemaObject(isolationProperties[name], `profile isolation ${name}`).uniqueItems = true;
  }
}

/** Zod matcher-array refinements need explicit editor-schema duplicate-item constraints. */
function addProfileRoutingMatcherArrayConstraints(schema: SchemaObject): void {
  const rootProperties = requireSchemaObject(schema.properties, "root properties");
  const profiles = requireSchemaObject(rootProperties.profiles, "profiles schema");
  const profile = requireSchemaObject(profiles.additionalProperties, "profile schema");
  const profileProperties = requireSchemaObject(profile.properties, "profile properties");
  const routingProperties = requireSchemaObject(
    requireSchemaObject(profileProperties.routing, "profile routing schema").properties,
    "profile routing schema properties"
  );
  const matchProperties = requireSchemaObject(
    requireSchemaObject(routingProperties.match, "profile routing match schema").properties,
    "profile routing match schema properties"
  );
  requireSchemaObject(routingProperties.match, "profile routing match schema").minProperties = 1;
  const providerFields = {
    github: ["repositories", "organizations"],
    sentry: ["organizations", "projects", "environments"],
    jira: ["sites", "projects"],
    linear: ["workspaces", "teams"],
    posthog: ["hosts", "projects"]
  } as const;
  for (const [provider, fields] of Object.entries(providerFields)) {
    const providerSchema = requireSchemaObject(matchProperties[provider], `${provider} matcher schema`);
    providerSchema.minProperties = 1;
    const properties = requireSchemaObject(
      providerSchema.properties,
      `${provider} matcher schema properties`
    );
    for (const field of fields) {
      const fieldSchema = requireSchemaObject(properties[field], `${provider} matcher ${field}`);
      fieldSchema.uniqueItems = true;
      if ((provider === "jira" && field === "sites") || (provider === "posthog" && field === "hosts")) {
        fieldSchema.items = {
          ...requireSchemaObject(fieldSchema.items, `${provider} matcher ${field} item`),
          pattern: CANONICAL_HTTPS_ORIGIN_PATTERN.source
        };
      }
    }
  }
}

/** zod-to-json-schema cannot emit the audit rotation super-refinement that requires a trigger. */
function addAuditRotationConstraints(schema: SchemaObject): void {
  const rootProperties = requireSchemaObject(schema.properties, "root properties");
  const audit = requireSchemaObject(rootProperties.audit, "audit schema");
  const auditProperties = requireSchemaObject(audit.properties, "audit schema properties");
  const rotation = requireSchemaObject(auditProperties.rotation, "audit rotation schema");
  rotation.anyOf = [{ required: ["maxBytes"] }, { required: ["maxAgeMs"] }];
}

/** Zod URL refinements need an explicit editor-facing registration-mode constraint. */
function addOAuthClientRegistrationConstraints(schema: SchemaObject): void {
  const rootProperties = requireSchemaObject(schema.properties, "root properties");
  const oauth = requireSchemaObject(rootProperties.oauth, "OAuth schema");
  const oauthProperties = requireSchemaObject(oauth.properties, "OAuth schema properties");
  const connections = requireSchemaObject(oauthProperties.connections, "OAuth connections schema");
  const connection = requireSchemaObject(connections.additionalProperties, "OAuth connection schema");
  const connectionProperties = requireSchemaObject(connection.properties, "OAuth connection properties");
  const registration = requireSchemaObject(connectionProperties.clientRegistration, "OAuth client registration");
  registration.anyOf = [
    { pattern: "^pre-registered:.+$" },
    { pattern: "^client-id-metadata:https://[^?#]+/[^?#]+$" },
    { const: "dynamic" }
  ];
}

/** Mirrors canonical-version runtime alias rejection for editor JSON Schema consumers. */
function canonicalVersionCompatibilityConstraint(version: "2" | "3"): SchemaObject {
  const forbiddenProperty = (section: string, property: string): SchemaObject => ({
    not: {
      required: [section],
      properties: { [section]: { required: [property] } }
    }
  });
  const httpTransport = {
    required: ["transport"],
    properties: { transport: { const: "http" } }
  };
  return {
    if: {
      required: ["version"],
      properties: { version: { const: version } }
    },
    then: {
      allOf: [
        forbiddenProperty("security", "allowPlaintextSecrets"),
        forbiddenProperty("security", "redactSecrets"),
        forbiddenProperty("audit", "redact"),
        {
          not: {
            required: ["upstream"],
            properties: { upstream: httpTransport }
          }
        },
        {
          // `additionalProperties` validates every named upstream, which is the object-map equivalent of forbidding a match.
          properties: {
            upstreams: {
              additionalProperties: { not: httpTransport }
            }
          }
        }
      ]
    }
  };
}

/** OAuth connection records are an explicit v3-only additive configuration surface. */
function oauthVersionConstraint(version: "1" | "2"): SchemaObject {
  return {
    if: {
      required: ["version"],
      properties: { version: { const: version } }
    },
    then: {
      not: { required: ["oauth"] }
    }
  };
}

/** Generates the editor-facing JSON Schema from the same strict Zod contract used after validation. */
export function generateConfigSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(miftahPublicConfigSchema, { target: "jsonSchema2019-09" }) as SchemaObject;
  addProfileLeaseArrayConstraints(schema);
  addProfileIsolationArrayConstraints(schema);
  addProfileRoutingMatcherArrayConstraints(schema);
  addAuditRotationConstraints(schema);
  addOAuthClientRegistrationConstraints(schema);
  return {
    ...schema,
    allOf: [
      {
        oneOf: [{ required: ["upstream"] }, { required: ["upstreams"] }]
      },
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
      },
      {
        // zod-to-json-schema cannot emit the parent audit super-refinement for managed options.
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
      },
      canonicalVersionCompatibilityConstraint("2"),
      canonicalVersionCompatibilityConstraint("3"),
      oauthVersionConstraint("1"),
      oauthVersionConstraint("2")
    ],
    title: "Miftah configuration"
  };
}
