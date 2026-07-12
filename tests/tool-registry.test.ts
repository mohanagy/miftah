import type { Tool } from "@modelcontextprotocol/sdk/types.js";
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
