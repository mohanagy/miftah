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

interface SchemaNode {
  const?: boolean | string;
  properties?: Record<string, SchemaNode>;
}

interface ConfigSchema extends SchemaNode {
  $defs: Record<string, SchemaNode>;
}

function schemaNode(schema: ConfigSchema, name: string): SchemaNode {
  const node = schema.$defs[name];
  if (!node) {
    throw new Error(`Expected schema definition '${name}'`);
  }
  return node;
}

describe("published config schema", () => {
  it("advertises only the runtime-supported configuration surface", () => {
    const schema = generateConfigSchema() as unknown as ConfigSchema;
    const root = schema.properties;
    const routing = schemaNode(schema, "routing").properties;
    const profile = schemaNode(schema, "profile").properties;
    const profileUpstreamOverride = schemaNode(schema, "profileUpstreamOverride").properties;
    const process = schemaNode(schema, "process").properties;
    const security = schemaNode(schema, "security").properties;
    const audit = schemaNode(schema, "audit").properties;
    const tooling = schemaNode(schema, "tooling").properties;

    expect(root).not.toHaveProperty("state");
    expect(root).not.toHaveProperty("ui");
    expect(routing).toMatchObject({ mode: { const: "hybrid" } });
    expect(routing).not.toHaveProperty("plugins");
    expect(profile).toHaveProperty("headers");
    expect(profile).toHaveProperty("upstreams");
    expect(profile).not.toHaveProperty("metadata");
    expect(profile).not.toHaveProperty("routing");
    expect(profileUpstreamOverride).toHaveProperty("args");
    expect(profileUpstreamOverride).toHaveProperty("env");
    expect(profileUpstreamOverride).toHaveProperty("cwd");
    expect(profileUpstreamOverride).toHaveProperty("headers");
    expect(profileUpstreamOverride).not.toHaveProperty("transport");
    expect(profileUpstreamOverride).not.toHaveProperty("command");
    expect(profileUpstreamOverride).not.toHaveProperty("url");
    expect(Object.keys(process ?? {})).toEqual(["startupTimeoutMs"]);
    expect(security).toMatchObject({ redactSecrets: { const: true } });
    expect(audit).toMatchObject({ format: { const: "jsonl" }, redact: { const: true } });
    expect(tooling).not.toHaveProperty("managementToolPrefix");
    expect(tooling).not.toHaveProperty("upstreamToolNamespace");
    expect(tooling).not.toHaveProperty("toolDiscoveryMode");
  });
});
