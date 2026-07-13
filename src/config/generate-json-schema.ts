import { zodToJsonSchema } from "zod-to-json-schema";
import { miftahPublicConfigSchema } from "./schema.js";

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
  const providerFields = {
    github: ["repositories", "organizations"],
    sentry: ["organizations", "projects", "environments"],
    jira: ["sites", "projects"],
    linear: ["workspaces", "teams"],
    posthog: ["hosts", "projects"]
  } as const;
  for (const [provider, fields] of Object.entries(providerFields)) {
    const properties = requireSchemaObject(
      requireSchemaObject(matchProperties[provider], `${provider} matcher schema`).properties,
      `${provider} matcher schema properties`
    );
    for (const field of fields) {
      requireSchemaObject(properties[field], `${provider} matcher ${field}`).uniqueItems = true;
    }
  }
}

/** Generates the editor-facing JSON Schema from the same strict Zod contract used after validation. */
export function generateConfigSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(miftahPublicConfigSchema, { target: "jsonSchema2019-09" }) as SchemaObject;
  addProfileLeaseArrayConstraints(schema);
  addProfileIsolationArrayConstraints(schema);
  addProfileRoutingMatcherArrayConstraints(schema);
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
      }
    ],
    title: "Miftah configuration"
  };
}
