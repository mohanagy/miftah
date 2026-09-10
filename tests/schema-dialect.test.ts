import type { Tool } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { normalizeToolSchemaDialect } from "../src/mcp/server/schema-dialect.js";

const draft07 = "http://json-schema.org/draft-07/schema#";
const draft202012 = "https://json-schema.org/draft/2020-12/schema";

describe("tool schema dialect normalization", () => {
  it("drops unsupported dialect declarations from both tool schemas", () => {
    const tool: Tool = {
      name: "aggregate-db",
      inputSchema: { $schema: draft07, type: "object", properties: { database: { type: "string" } } },
      outputSchema: { $schema: draft07, type: "object", properties: { documents: { type: "array" } } }
    };

    const normalized = normalizeToolSchemaDialect(tool);

    expect(normalized.inputSchema).toEqual({ type: "object", properties: { database: { type: "string" } } });
    expect(normalized.outputSchema).toEqual({ type: "object", properties: { documents: { type: "array" } } });
    expect("$schema" in normalized.inputSchema).toBe(false);
  });

  it("keeps a 2020-12 declaration so compliant upstreams keep byte-identical schemas", () => {
    const tool: Tool = {
      name: "compliant",
      inputSchema: { $schema: draft202012, type: "object" },
      outputSchema: { $schema: `${draft202012}#`, type: "object" }
    };

    const normalized = normalizeToolSchemaDialect(tool);

    expect(normalized.inputSchema.$schema).toBe(draft202012);
    expect(normalized.outputSchema?.$schema).toBe(`${draft202012}#`);
    expect(normalized).toBe(tool);
  });

  it("leaves schemas without a dialect declaration untouched", () => {
    const tool: Tool = { name: "plain", inputSchema: { type: "object", properties: {} } };

    expect(normalizeToolSchemaDialect(tool)).toBe(tool);
  });

  it("never rewrites a nested property that happens to be named $schema", () => {
    const tool: Tool = {
      name: "meta",
      inputSchema: {
        $schema: draft07,
        type: "object",
        properties: { $schema: { type: "string", description: "Dialect of the document to validate" } },
        required: ["$schema"]
      }
    };

    const normalized = normalizeToolSchemaDialect(tool);

    expect(normalized.inputSchema).toEqual({
      type: "object",
      properties: { $schema: { type: "string", description: "Dialect of the document to validate" } },
      required: ["$schema"]
    });
  });

  it("preserves every other field and does not mutate the input tool", () => {
    const tool: Tool = {
      name: "annotated",
      title: "Annotated",
      description: "Keeps metadata.",
      inputSchema: { $schema: draft07, type: "object" },
      annotations: { readOnlyHint: true },
      _meta: { origin: "upstream" }
    };
    const before = structuredClone(tool);

    const normalized = normalizeToolSchemaDialect(tool);

    expect(normalized).toEqual({ ...before, inputSchema: { type: "object" } });
    expect(tool).toEqual(before);
  });

  it("drops other unsupported dialects, not just draft-07", () => {
    for (const dialect of [
      "http://json-schema.org/draft-04/schema#",
      "https://json-schema.org/draft/2019-09/schema"
    ]) {
      const normalized = normalizeToolSchemaDialect({ name: "t", inputSchema: { $schema: dialect, type: "object" } });
      expect(normalized.inputSchema).toEqual({ type: "object" });
    }
  });
});
