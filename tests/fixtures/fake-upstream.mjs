import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const account = process.env.TEST_ACCOUNT_NAME ?? "unknown";
const listToolsDelayMs = Number(process.env.TEST_LIST_TOOLS_DELAY_MS ?? "0");
const failOnRestartPath = process.env.TEST_FAIL_ON_RESTART_PATH;
if (failOnRestartPath) {
  if (existsSync(failOnRestartPath)) {
    throw new Error("test upstream configured to fail after its initial start");
  }
  writeFileSync(failOnRestartPath, "started");
}
const restartBlockPath = process.env.TEST_BLOCK_ON_RESTART_PATH;
if (restartBlockPath) {
  const isRestart = existsSync(restartBlockPath);
  writeFileSync(restartBlockPath, "started");
  if (isRestart) {
    const readyPath = process.env.TEST_BLOCK_ON_RESTART_READY_PATH;
    const releasePath = process.env.TEST_BLOCK_ON_RESTART_RELEASE_PATH;
    if (!readyPath || !releasePath) {
      throw new Error("test restart block requires ready and release paths");
    }
    writeFileSync(readyPath, "ready");
    while (!existsSync(releasePath)) {
      await delay(5);
    }
  }
}
const whoamiInputSchema =
  process.env.TEST_WHOAMI_SCHEMA === "account"
    ? {
        type: "object",
        properties: { account: { type: "string" } },
        required: ["account"]
      }
    : { type: "object", properties: {} };
const server = new Server(
  { name: "fake-upstream", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.env.TEST_LIST_TOOLS_STARTED_PATH) {
    writeFileSync(process.env.TEST_LIST_TOOLS_STARTED_PATH, "started");
  }
  if (process.env.TEST_LIST_TOOLS_COUNT_PATH) {
    appendFileSync(process.env.TEST_LIST_TOOLS_COUNT_PATH, "1\n");
  }
  if (listToolsDelayMs > 0) {
    await delay(listToolsDelayMs);
  }
  return {
    tools: [
      {
        name: "whoami",
        description: "Return the injected account.",
        inputSchema: whoamiInputSchema
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
      },
      ...(process.env.TEST_INCLUDE_MANAGEMENT_TOOL === "true"
        ? [
            {
              name: "miftah_health",
              description: "Collides with a reserved Miftah management tool.",
              inputSchema: { type: "object", properties: {} }
            }
          ]
        : []),
      ...(process.env.TEST_INCLUDE_MIFTAH_PREFIX_TOOL === "true"
        ? [
            {
              name: "miftah_custom",
              description: "An upstream tool with a Miftah-looking name.",
              inputSchema: { type: "object", properties: {} }
            }
          ]
        : [])
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (process.env.TEST_CALL_TOOL_COUNT_PATH) {
    appendFileSync(process.env.TEST_CALL_TOOL_COUNT_PATH, "1\n");
  }
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

server.setRequestHandler(ReadResourceRequestSchema, async () => {
  if (process.env.TEST_FAIL_READ_RESOURCE === "true") {
    throw new Error(`test resource read failure: ${process.env.API_TOKEN}`);
  }
  return {
    contents: [{ uri: "account://current", text: account, mimeType: "text/plain" }]
  };
});

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

server.setRequestHandler(GetPromptRequestSchema, async () => {
  if (process.env.TEST_FAIL_GET_PROMPT === "true") {
    throw new Error(`test prompt get failure: ${process.env.API_TOKEN}`);
  }
  return {
    description: "Account prompt",
    messages: [{ role: "user", content: { type: "text", text: account } }]
  };
});

await server.connect(new StdioServerTransport());
