export function generateConfigSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Miftah configuration",
    type: "object",
    required: ["version", "name", "defaultProfile", "profiles"],
    properties: {
      version: { const: "1" },
      name: { type: "string", minLength: 1 },
      description: { type: "string" },
      defaultProfile: { type: "string" },
      upstream: { $ref: "#/$defs/upstream" },
      upstreams: { type: "object", additionalProperties: { $ref: "#/$defs/upstream" } },
      profiles: { type: "object", additionalProperties: { $ref: "#/$defs/profile" } },
      routing: { $ref: "#/$defs/routing" },
      policies: { type: "object", additionalProperties: { $ref: "#/$defs/policy" } },
      security: { type: "object" },
      process: { type: "object" },
      audit: { type: "object" },
      tooling: { type: "object" },
      secrets: { type: "object" },
      state: { type: "object" }
    },
    $defs: {
      upstream: {
        type: "object",
        required: ["transport"],
        properties: {
          transport: { enum: ["stdio", "http", "sse", "streamable-http"] },
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          env: { type: "object", additionalProperties: { type: "string" } },
          cwd: { type: "string" },
          url: { type: "string", format: "uri" },
          headers: { type: "object", additionalProperties: { type: "string" } }
        }
      },
      profile: {
        type: "object",
        properties: {
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          env: { type: "object", additionalProperties: { type: "string" } },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
          policy: { type: "string" }
        }
      },
      routing: {
        type: "object",
        properties: {
          mode: { enum: ["active", "rules", "hybrid"] },
          fallback: { enum: ["default", "activeProfile", "ask", "block"] },
          rules: { type: "array", items: { type: "object" } }
        }
      },
      policy: { type: "object" }
    }
  };
}
