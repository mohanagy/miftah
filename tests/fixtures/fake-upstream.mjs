import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const account = process.env.TEST_ACCOUNT_NAME ?? "unknown";
const server = new Server(
  { name: "fake-upstream", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "whoami",
      description: "Return the injected account.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "echo",
      description: "Echo a message.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"]
      }
    },
    {
      name: "create_item",
      description: "Create an item.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "whoami") {
    return { content: [{ type: "text", text: account }] };
  }
  if (request.params.name === "echo") {
    return { content: [{ type: "text", text: String(request.params.arguments?.message ?? "") }] };
  }
  return { content: [{ type: "text", text: `created:${String(request.params.arguments?.name ?? "")}` }] };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  if (process.env.TEST_FAIL_LIST_RESOURCES === "true") {
    throw new Error(`test resource discovery failure: ${process.env.API_TOKEN}`);
  }
  return {
    resources: [
      {
        uri: "account://current",
        name:
          process.env.TEST_INCLUDE_DISCOVERY_TOKEN === "true"
            ? `Current account ${process.env.API_TOKEN}`
            : "Current account",
        mimeType: "text/plain"
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async () => ({
  contents: [{ uri: "account://current", text: account, mimeType: "text/plain" }]
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  if (process.env.TEST_FAIL_LIST_PROMPTS === "true") {
    throw new Error(`test prompt discovery failure: ${process.env.API_TOKEN}`);
  }
  return {
    prompts: [
      {
        name: "account_prompt",
        description:
          process.env.TEST_INCLUDE_DISCOVERY_TOKEN === "true"
            ? `Account prompt ${process.env.API_TOKEN}`
            : "Account prompt"
      }
    ]
  };
});

server.setRequestHandler(GetPromptRequestSchema, async () => ({
  description: "Account prompt",
  messages: [{ role: "user", content: { type: "text", text: account } }]
}));

await server.connect(new StdioServerTransport());
