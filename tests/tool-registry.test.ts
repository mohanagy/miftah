import type { Tool } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/mcp/server/tool-registry.js";

const emptyInputSchema = { type: "object", properties: {} } as const;

describe("tool registry risk metadata", () => {
  it("keeps only behavioral annotation booleans in immutable registered-tool metadata", async () => {
    const tools: Tool[] = [
      {
        name: "annotated",
        description: "Metadata should not be copied into policy input.",
        inputSchema: emptyInputSchema,
        annotations: {
          title: "Sensitive title",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "partial",
        inputSchema: emptyInputSchema,
        annotations: { readOnlyHint: false }
      },
      {
        name: "title_only",
        inputSchema: emptyInputSchema,
        annotations: { title: "No risk signal" }
      },
      { name: "plain", inputSchema: emptyInputSchema }
    ];
    const registry = new ToolRegistry(
      async () => ({ discovered: [{ tools }], incomplete: false }),
      (name) => name
    );

    const snapshot = await registry.get("work");
    const annotated = snapshot.resolve("annotated");
    const partial = snapshot.resolve("partial");
    const titleOnly = snapshot.resolve("title_only");
    const plain = snapshot.resolve("plain");

    expect(annotated?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(partial?.annotations).toEqual({ readOnlyHint: false });
    expect(titleOnly?.annotations).toBeUndefined();
    expect(plain?.annotations).toBeUndefined();

    if (!annotated?.annotations) throw new Error("Expected normalized annotations.");
    (annotated.annotations as { readOnlyHint?: boolean }).readOnlyHint = false;
    expect(snapshot.resolve("annotated")?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("tool registry schema dialect", () => {
  const draft07 = "http://json-schema.org/draft-07/schema#";

  it("exposes upstream tools without an unsupported dialect declaration", async () => {
    const tools: Tool[] = [
      {
        name: "aggregate",
        inputSchema: { $schema: draft07, type: "object", properties: { database: { type: "string" } } },
        outputSchema: { $schema: draft07, type: "object", properties: { documents: { type: "array" } } }
      }
    ];
    const registry = new ToolRegistry(
      async () => ({ discovered: [{ tools }], incomplete: false }),
      (name) => name
    );

    const [exposed] = (await registry.get("work")).getTools();

    expect(exposed?.inputSchema).toEqual({ type: "object", properties: { database: { type: "string" } } });
    expect(exposed?.outputSchema).toEqual({ type: "object", properties: { documents: { type: "array" } } });
  });

  it("fingerprints the normalized schema so dialect churn alone is not a tool change", async () => {
    const withDialect: Tool = { name: "find", inputSchema: { $schema: draft07, type: "object" } };
    const withoutDialect: Tool = { name: "find", inputSchema: { type: "object" } };
    const fingerprint = async (tool: Tool): Promise<string | undefined> => {
      const registry = new ToolRegistry(
        async () => ({ discovered: [{ tools: [tool] }], incomplete: false }),
        (name) => name
      );
      return (await registry.get("work")).resolve("find")?.fingerprint;
    };

    expect(await fingerprint(withDialect)).toBe(await fingerprint(withoutDialect));
  });
});
