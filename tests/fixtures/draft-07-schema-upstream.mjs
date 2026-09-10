import { createInterface } from "node:readline";

// Servers built on the MCP SDK's Zod path emit zod-to-json-schema output, which stamps this dialect.
const dialect = "http://json-schema.org/draft-07/schema#";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "draft-07-schema-upstream", version: "1.0.0" }
      }
    });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "validate",
            description: "Validate a document.",
            // The nested `$schema` is a real property name, not a dialect switch: it must survive.
            inputSchema: {
              $schema: dialect,
              type: "object",
              properties: { $schema: { type: "string", description: "Dialect of the document" } },
              required: ["$schema"]
            },
            outputSchema: {
              $schema: dialect,
              type: "object",
              properties: { valid: { type: "boolean" } },
              required: ["valid"]
            },
            annotations: { readOnlyHint: true }
          }
        ]
      }
    });
    return;
  }
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
});
