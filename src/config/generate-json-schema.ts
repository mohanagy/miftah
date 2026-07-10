import { zodToJsonSchema } from "zod-to-json-schema";
import { miftahPublicConfigSchema } from "./schema.js";

/** Generates the editor-facing JSON Schema from the same strict Zod contract used after validation. */
export function generateConfigSchema(): Record<string, unknown> {
  return {
    ...zodToJsonSchema(miftahPublicConfigSchema, { target: "jsonSchema2019-09" }),
    title: "Miftah configuration"
  };
}
