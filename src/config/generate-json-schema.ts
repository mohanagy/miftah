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
      security: { $ref: "#/$defs/security" },
      process: { $ref: "#/$defs/process" },
      audit: { $ref: "#/$defs/audit" },
      tooling: { $ref: "#/$defs/tooling" },
      secrets: { $ref: "#/$defs/secrets" }
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
          headers: { type: "object", additionalProperties: { type: "string" } },
          policy: { type: "string" },
          upstreams: { type: "object", additionalProperties: { $ref: "#/$defs/profileUpstreamOverride" } }
        }
      },
      profileUpstreamOverride: {
        type: "object",
        properties: {
          args: { type: "array", items: { type: "string" } },
          env: { type: "object", additionalProperties: { type: "string" } },
          cwd: { type: "string" },
          headers: { type: "object", additionalProperties: { type: "string" } }
        }
      },
      routing: {
        type: "object",
        properties: {
          mode: { const: "hybrid" },
          fallback: { enum: ["default", "activeProfile", "ask", "block"] },
          rules: { type: "array", items: { $ref: "#/$defs/routingRule" } }
        }
      },
      routingRule: {
        type: "object",
        required: ["when", "profile"],
        properties: {
          name: { type: "string" },
          when: { type: "object", additionalProperties: true },
          profile: { type: "string", minLength: 1 }
        }
      },
      policy: {
        type: "object",
        properties: {
          allow: { type: "array", items: { enum: ["read", "write", "destructive"] } },
          allowRisk: { type: "array", items: { enum: ["read", "write", "destructive"] } },
          deny: { type: "array", items: { type: "string" } },
          denyRisk: { type: "array", items: { enum: ["read", "write", "destructive"] } },
          requireConfirmation: { type: "array", items: { type: "string" } }
        }
      },
      security: {
        type: "object",
        properties: {
          allowPlaintextSecrets: { type: "boolean" },
          redactSecrets: { const: true, description: "Secret redaction is always enabled." },
          allowProfileSwitchingFromMcp: { type: "boolean" },
          requireExplicitProfileForDestructive: { type: "boolean" },
          lockToProfile: { type: ["string", "null"] }
        }
      },
      process: {
        type: "object",
        properties: {
          startupTimeoutMs: { type: "integer", exclusiveMinimum: 0 }
        }
      },
      audit: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          path: { type: "string" },
          format: { const: "jsonl" },
          includeArguments: { type: "boolean" },
          redact: { const: true, description: "Audit redaction is always enabled." }
        }
      },
      tooling: {
        type: "object",
        properties: {
          collisionStrategy: { enum: ["prefix-upstream", "fail"] },
          toolRiskOverrides: {
            type: "object",
            additionalProperties: { enum: ["read", "write", "destructive"] }
          }
        }
      },
      secrets: {
        type: "object",
        properties: {
          envFiles: { type: "array", items: { type: "string" } },
          allowPlaintextSecrets: { type: "boolean" }
        }
      }
    }
  };
}
