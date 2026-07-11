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

interface SchemaNode {
  const?: boolean | string;
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
    const routing = root?.routing?.properties;
    const profile = mapValue(root?.profiles, "profiles");
    const profileUpstreamOverride = mapValue(profile.properties?.upstreams, "profile upstreams");
    const process = root?.process?.properties;
    const security = root?.security?.properties;
    const audit = root?.audit?.properties;
    const tooling = root?.tooling?.properties;

    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2019-09/schema#",
      title: "Miftah configuration",
      additionalProperties: false
    });
    expect(root).not.toHaveProperty("state");
    expect(root).not.toHaveProperty("ui");
    expect(routing).toMatchObject({ mode: { const: "hybrid" } });
    expect(routing).not.toHaveProperty("plugins");
    expect(profile.properties).toHaveProperty("headers");
    expect(profile.properties).toHaveProperty("upstreams");
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
    expect(security).toMatchObject({ redactSecrets: { const: true } });
    expect(security).not.toHaveProperty("requireProfileSwitchConfirmation");
    expect(audit).toMatchObject({ format: { const: "jsonl" }, redact: { const: true } });
    expect(tooling).not.toHaveProperty("managementToolPrefix");
    expect(tooling).not.toHaveProperty("upstreamToolNamespace");
    expect(tooling).toMatchObject({ toolDiscoveryMode: { enum: ["permissive", "strict"] } });
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
});
