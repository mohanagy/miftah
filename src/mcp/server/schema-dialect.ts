import type { Tool } from "@modelcontextprotocol/server";

type SchemaObject = { readonly [keyword: string]: unknown };

/**
 * The canonical 2020-12 dialect id. JSON Schema moved to `https` from 2019-09 onward, so the plain-HTTP
 * spelling is deliberately not accepted: a client that only recognizes the canonical id would still
 * reject a schema declaring it, and dropping the declaration is safe either way.
 */
const supportedDialect = "https://json-schema.org/draft/2020-12/schema";

/**
 * MCP pins tool schemas to JSON Schema 2020-12, but servers built on the SDK's Zod path emit
 * `zod-to-json-schema` output, which stamps a draft-07 dialect. Strict clients reject the whole
 * `outputSchema` over that declaration alone, so upstream tools silently lose structured output.
 *
 * Dropping `$schema` is preferred over rewriting it to the 2020-12 URI: an absent declaration means
 * "the dialect the consumer expects", which is exactly 2020-12 here, and it avoids asserting 2020-12
 * semantics over keywords that changed meaning between drafts (boolean `exclusiveMinimum`, `dependencies`).
 *
 * Only the schema root is inspected. A `$schema` nested deeper is far more likely to be a property
 * literally named `$schema` than a dialect switch, and rewriting it would corrupt the upstream contract.
 */
export function normalizeToolSchemaDialect(tool: Tool): Tool {
  const inputSchema = normalizeSchema(tool.inputSchema);
  const outputSchema = tool.outputSchema === undefined ? undefined : normalizeSchema(tool.outputSchema);
  if (inputSchema === tool.inputSchema && outputSchema === tool.outputSchema) return tool;
  return {
    ...tool,
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema })
  };
}

function normalizeSchema<Schema extends SchemaObject>(schema: Schema): Schema {
  if (!declaresUnsupportedDialect(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([keyword]) => keyword !== "$schema")) as Schema;
}

function declaresUnsupportedDialect(schema: SchemaObject): boolean {
  const dialect = schema.$schema;
  return typeof dialect === "string" && dialect.replace(/#$/, "") !== supportedDialect;
}
