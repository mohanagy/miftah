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
const responseText =
  process.env.TEST_INCLUDE_RESPONSE_TOKEN === "true" ? `${account}:${process.env.API_TOKEN ?? ""}` : account;
const listToolsDelayMs = Number(process.env.TEST_LIST_TOOLS_DELAY_MS ?? "0");
const listResourcesDelayMs = Number(process.env.TEST_LIST_RESOURCES_DELAY_MS ?? "0");
const listPromptsDelayMs = Number(process.env.TEST_LIST_PROMPTS_DELAY_MS ?? "0");
const readResourceDelayMs = Number(process.env.TEST_READ_RESOURCE_DELAY_MS ?? "0");
const getPromptDelayMs = Number(process.env.TEST_GET_PROMPT_DELAY_MS ?? "0");
const resourceName = process.env.TEST_RESOURCE_NAME ?? "Current account";
const resourceUri = process.env.TEST_RESOURCE_URI ?? "account://current";
const promptName = process.env.TEST_PROMPT_NAME ?? "account_prompt";
const paginateCapabilities = process.env.TEST_PAGINATE_CAPABILITIES === "true";
const secondResourceName = process.env.TEST_SECOND_RESOURCE_NAME ?? "Second account";
const secondResourceUri = process.env.TEST_SECOND_RESOURCE_URI ?? "account://second";
const secondPromptName = process.env.TEST_SECOND_PROMPT_NAME ?? "second_prompt";
const additionalResourceUri = process.env.TEST_ADDITIONAL_RESOURCE_URI;
const resourceIconUri = process.env.TEST_RESOURCE_ICON_URI;
const promptIconUri = process.env.TEST_PROMPT_ICON_URI;
const promptResourceUri = process.env.TEST_PROMPT_RESOURCE_URI;
const failOnRestartPath = process.env.TEST_FAIL_ON_RESTART_PATH;
const failListResourcesPath = process.env.TEST_FAIL_LIST_RESOURCES_PATH;
const failListPromptsPath = process.env.TEST_FAIL_LIST_PROMPTS_PATH;
const crashOnCallToolPath = process.env.TEST_CRASH_ON_CALL_TOOL_PATH;
if (crashOnCallToolPath && existsSync(crashOnCallToolPath)) {
  throw new Error("test upstream configured to stay unavailable after an abrupt exit");
}
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
  if (crashOnCallToolPath && existsSync(crashOnCallToolPath)) {
    void delay(0).then(() => process.exit(1));
    return new Promise(() => undefined);
  }
  if (process.env.TEST_CALL_TOOL_COUNT_PATH) {
    appendFileSync(process.env.TEST_CALL_TOOL_COUNT_PATH, "1\n");
  }
  if (process.env.TEST_FAIL_CALL_TOOL === "true") {
    throw new Error(`test tool call failure: ${process.env.API_TOKEN}`);
  }
  if (request.params.name === "whoami") {
    return { content: [{ type: "text", text: account }] };
  }
  if (request.params.name === "echo") {
    return { content: [{ type: "text", text: String(request.params.arguments?.message ?? "") }] };
  }
  return { content: [{ type: "text", text: `created:${String(request.params.arguments?.name ?? "")}` }] };
});

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  if (process.env.TEST_LIST_RESOURCES_COUNT_PATH) {
    appendFileSync(process.env.TEST_LIST_RESOURCES_COUNT_PATH, "1\n");
  }
  if (process.env.TEST_LIST_RESOURCES_STARTED_PATH) {
    writeFileSync(process.env.TEST_LIST_RESOURCES_STARTED_PATH, "started");
  }
  if (listResourcesDelayMs > 0) {
    await delay(listResourcesDelayMs);
  }
  if (process.env.TEST_FAIL_LIST_RESOURCES === "true" || (failListResourcesPath && existsSync(failListResourcesPath))) {
    throw new Error(`test resource discovery failure: ${process.env.API_TOKEN}`);
  }
  const secondPage = paginateCapabilities && request.params?.cursor === "next";
  return {
    resources: [
      {
        uri: secondPage ? secondResourceUri : resourceUri,
        name:
          process.env.TEST_INCLUDE_DISCOVERY_TOKEN === "true"
            ? `Current account ${process.env.API_TOKEN}`
            : secondPage ? secondResourceName : resourceName,
        mimeType: "text/plain",
        ...(resourceIconUri ? { icons: [{ src: resourceIconUri }] } : {})
      }
    ],
    ...(paginateCapabilities && !secondPage ? { nextCursor: "next" } : {})
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async () => {
  if (process.env.TEST_READ_RESOURCE_COUNT_PATH) {
    appendFileSync(process.env.TEST_READ_RESOURCE_COUNT_PATH, "1\n");
  }
  if (process.env.TEST_READ_RESOURCE_STARTED_PATH) {
    writeFileSync(process.env.TEST_READ_RESOURCE_STARTED_PATH, "started");
  }
  if (readResourceDelayMs > 0) {
    await delay(readResourceDelayMs);
  }
  if (process.env.TEST_FAIL_READ_RESOURCE === "true") {
    throw new Error(`test resource read failure: ${process.env.TEST_ERROR_URI ?? process.env.API_TOKEN}`);
  }
  return {
    contents: [
      { uri: resourceUri, text: responseText, mimeType: "text/plain" },
      ...(additionalResourceUri ? [{ uri: additionalResourceUri, text: responseText, mimeType: "text/plain" }] : [])
    ]
  };
});

server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
  if (process.env.TEST_LIST_PROMPTS_COUNT_PATH) {
    appendFileSync(process.env.TEST_LIST_PROMPTS_COUNT_PATH, "1\n");
  }
  if (process.env.TEST_LIST_PROMPTS_STARTED_PATH) {
    writeFileSync(process.env.TEST_LIST_PROMPTS_STARTED_PATH, "started");
  }
  if (listPromptsDelayMs > 0) {
    await delay(listPromptsDelayMs);
  }
  if (process.env.TEST_FAIL_LIST_PROMPTS === "true" || (failListPromptsPath && existsSync(failListPromptsPath))) {
    throw new Error(`test prompt discovery failure: ${process.env.API_TOKEN}`);
  }
  const secondPage = paginateCapabilities && request.params?.cursor === "next";
  return {
    prompts: [
      {
        name: secondPage ? secondPromptName : promptName,
        description:
          process.env.TEST_INCLUDE_DISCOVERY_TOKEN === "true"
            ? `Account prompt ${process.env.API_TOKEN}`
            : secondPage ? "Second account prompt" : "Account prompt",
        ...(promptIconUri ? { icons: [{ src: promptIconUri }] } : {})
      }
    ],
    ...(paginateCapabilities && !secondPage ? { nextCursor: "next" } : {})
  };
});

server.setRequestHandler(GetPromptRequestSchema, async () => {
  if (process.env.TEST_GET_PROMPT_COUNT_PATH) {
    appendFileSync(process.env.TEST_GET_PROMPT_COUNT_PATH, "1\n");
  }
  if (process.env.TEST_GET_PROMPT_STARTED_PATH) {
    writeFileSync(process.env.TEST_GET_PROMPT_STARTED_PATH, "started");
  }
  if (getPromptDelayMs > 0) {
    await delay(getPromptDelayMs);
  }
  if (process.env.TEST_FAIL_GET_PROMPT === "true") {
    throw new Error(`test prompt get failure: ${process.env.TEST_ERROR_URI ?? process.env.API_TOKEN}`);
  }
  return {
    description: promptName,
    messages: [
      { role: "user", content: { type: "text", text: responseText } },
      ...(promptResourceUri
        ? [
            {
              role: "assistant",
              content: {
                type: "resource_link",
                uri: promptResourceUri,
                name: "Account resource",
                ...(promptIconUri ? { icons: [{ src: promptIconUri }] } : {})
              }
            },
            {
              role: "assistant",
              content: {
                type: "resource",
                resource: { uri: promptResourceUri, text: responseText, mimeType: "text/plain" }
              }
            }
          ]
        : [])
    ]
  };
});

await server.connect(new StdioServerTransport());
