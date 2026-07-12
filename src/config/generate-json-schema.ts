import { zodToJsonSchema } from "zod-to-json-schema";
import { miftahPublicConfigSchema } from "./schema.js";

/** Generates the editor-facing JSON Schema from the same strict Zod contract used after validation. */
export function generateConfigSchema(): Record<string, unknown> {
  return {
    ...zodToJsonSchema(miftahPublicConfigSchema, { target: "jsonSchema2019-09" }),
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
