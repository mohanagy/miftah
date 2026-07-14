import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  CancelledNotificationSchema,
  CallToolRequestSchema,
  GetPromptRequestSchema,
  InitializeRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const account = process.env.TEST_ACCOUNT_NAME ?? "unknown";
const responseText =
  process.env.TEST_INCLUDE_RESPONSE_TOKEN === "true" ? `${account}:${process.env.API_TOKEN ?? ""}` : account;
const listToolsDelayMs = Number(process.env.TEST_LIST_TOOLS_DELAY_MS ?? "0");
const listToolsDelayAfterNotificationMs = Number(process.env.TEST_LIST_TOOLS_DELAY_AFTER_NOTIFICATION_MS ?? "0");
const listResourcesDelayMs = Number(process.env.TEST_LIST_RESOURCES_DELAY_MS ?? "0");
const listPromptsDelayMs = Number(process.env.TEST_LIST_PROMPTS_DELAY_MS ?? "0");
const listToolsProgress = process.env.TEST_LIST_TOOLS_PROGRESS === "true";
const listResourcesProgress = process.env.TEST_LIST_RESOURCES_PROGRESS === "true";
const listResourceTemplatesProgress = process.env.TEST_LIST_RESOURCE_TEMPLATES_PROGRESS === "true";
const listPromptsProgress = process.env.TEST_LIST_PROMPTS_PROGRESS === "true";
const callToolDelayMs = Number(process.env.TEST_CALL_TOOL_DELAY_MS ?? "0");
const callToolProgress = process.env.TEST_CALL_TOOL_PROGRESS === "true";
const callToolProgressMessage = process.env.TEST_CALL_TOOL_PROGRESS_MESSAGE;
const readResourceDelayMs = Number(process.env.TEST_READ_RESOURCE_DELAY_MS ?? "0");
const getPromptDelayMs = Number(process.env.TEST_GET_PROMPT_DELAY_MS ?? "0");
const resourceName = process.env.TEST_RESOURCE_NAME ?? "Current account";
const resourceUri = process.env.TEST_RESOURCE_URI ?? "account://current";
const resourceTemplateName = process.env.TEST_RESOURCE_TEMPLATE_NAME ?? "account";
const resourceTemplateUri = process.env.TEST_RESOURCE_TEMPLATE_URI;
const resourceTemplatesUnsupported = process.env.TEST_RESOURCE_TEMPLATES_UNSUPPORTED === "true";
const resourceSubscriptions = process.env.TEST_RESOURCE_SUBSCRIPTIONS === "true";
const resourceSubscriptionStatefulUpdates = process.env.TEST_RESOURCE_SUBSCRIPTION_STATEFUL_UPDATES === "true";
const failSubscribe = process.env.TEST_FAIL_SUBSCRIBE === "true";
const resourceUpdateUri = process.env.TEST_RESOURCE_UPDATE_URI;
const resourceUpdateDelayMs = Number(process.env.TEST_RESOURCE_UPDATE_DELAY_MS ?? "0");
const subscribeDelayMs = Number(process.env.TEST_SUBSCRIBE_DELAY_MS ?? "0");
const unsubscribeDelayMs = Number(process.env.TEST_UNSUBSCRIBE_DELAY_MS ?? "0");
const subscribeCountPath = process.env.TEST_SUBSCRIBE_COUNT_PATH;
const unsubscribeCountPath = process.env.TEST_UNSUBSCRIBE_COUNT_PATH;
const subscribeStartedPath = process.env.TEST_SUBSCRIBE_STARTED_PATH;
const notifyToolListChangeOnListTools = process.env.TEST_NOTIFY_TOOL_LIST_CHANGE_ON_LIST_TOOLS === "true";
const notifyToolListChangeOnFirstListTools = process.env.TEST_NOTIFY_TOOL_LIST_CHANGE_ON_FIRST_LIST_TOOLS === "true";
const changeToolListAfterFirstRequest = process.env.TEST_TOOL_LIST_CHANGES_AFTER_FIRST_REQUEST === "true";
const notifyListChangesOnCallTool = process.env.TEST_NOTIFY_LIST_CHANGES_ON_CALL_TOOL === "true";
const promptName = process.env.TEST_PROMPT_NAME ?? "account_prompt";
let resourceSubscribed = false;
let resourceSubscriptionGeneration = 0;
const paginateCapabilities = process.env.TEST_PAGINATE_CAPABILITIES === "true";
const paginateTools = process.env.TEST_PAGINATE_TOOLS === "true";
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
const crashAfterInitializedPath = process.env.TEST_CRASH_AFTER_INITIALIZED_PATH;
const startCountPath = process.env.TEST_START_COUNT_PATH;
const initializedPath = process.env.TEST_INITIALIZED_PATH;
const createItemCountPath = process.env.TEST_CREATE_ITEM_COUNT_PATH;
const callToolStartedPath = process.env.TEST_CALL_TOOL_STARTED_PATH;
const cancelledPath = process.env.TEST_CANCELLED_PATH;
const failInitialize = process.env.TEST_FAIL_INITIALIZE === "true";
const clientInfoPath = process.env.TEST_CLIENT_INFO_PATH;
const stderrMessage = process.env.TEST_STDERR_MESSAGE;
const stderrSplitAt = Number(process.env.TEST_STDERR_SPLIT_AT ?? "0");
const hangOnStartPath = process.env.TEST_HANG_ON_START_PATH;
const hangOnStartReadyPath = process.env.TEST_HANG_ON_START_READY_PATH;
const shutdownDelayMs = Number(process.env.TEST_SHUTDOWN_DELAY_MS ?? "0");
const shutdownEndPath = process.env.TEST_SHUTDOWN_END_PATH;
const includeIdentityTool = process.env.TEST_INCLUDE_IDENTITY_TOOL === "true";
const oversizedIdentityResponseRepeat = Number(process.env.TEST_OVERSIZED_IDENTITY_RESPONSE_REPEAT ?? "0");
const oversizedIdentityLogin =
  Number.isSafeInteger(oversizedIdentityResponseRepeat) && oversizedIdentityResponseRepeat > 0
    ? "identity-response-secret".repeat(oversizedIdentityResponseRepeat)
    : undefined;
const identityResponse =
  oversizedIdentityLogin === undefined
    ? (process.env.TEST_IDENTITY_RESPONSE ?? JSON.stringify({ login: account }))
    : JSON.stringify({ login: oversizedIdentityLogin });
const identityInputSchema =
  process.env.TEST_IDENTITY_SCHEMA === "min-properties"
    ? { type: "object", properties: { account: { type: "string" } }, minProperties: 1 }
    : process.env.TEST_IDENTITY_SCHEMA === "all-of-required"
      ? { type: "object", properties: { account: { type: "string" } }, allOf: [{ required: ["account"] }] }
      : process.env.TEST_IDENTITY_SCHEMA === "additional-properties-false"
        ? { type: "object", properties: {}, additionalProperties: false }
      : { type: "object", properties: {} };

let toolListRequests = 0;

const isolationReportPath = process.env.TEST_ISOLATION_REPORT_PATH;
if (isolationReportPath) {
  const credentialPath = process.env.OAUTH_CREDENTIAL_PATH;
  if (!credentialPath) {
    throw new Error("test isolation fixture requires OAUTH_CREDENTIAL_PATH");
  }
  const credential = readFileSync(credentialPath, "utf8");
  writeFileSync(
    isolationReportPath,
    JSON.stringify({
      home: process.env.HOME,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      xdgCacheHome: process.env.XDG_CACHE_HOME,
      xdgDataHome: process.env.XDG_DATA_HOME,
      xdgStateHome: process.env.XDG_STATE_HOME,
      xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
      credentialPath,
      credential
    })
  );
  if (process.env.TEST_ISOLATION_EMIT_CREDENTIAL === "true") {
    process.stderr.write(`test isolated credential: ${credential}\n`);
  }
  const credentialField = process.env.TEST_ISOLATION_EMIT_CREDENTIAL_FIELD;
  if (credentialField) {
    const fieldValue = JSON.parse(credential)[credentialField];
    if (typeof fieldValue !== "string") {
      throw new Error("test isolation fixture requires a string credential field");
    }
    process.stderr.write(`test isolated credential field: ${fieldValue}\n`);
  }
}

if (startCountPath) {
  appendFileSync(startCountPath, "1\n");
}
if (process.env.TEST_HANG_ON_START === "true" || (hangOnStartPath && existsSync(hangOnStartPath))) {
  if (hangOnStartReadyPath) {
    writeFileSync(hangOnStartReadyPath, "ready");
  }
  if (hangOnStartPath) {
    while (existsSync(hangOnStartPath)) {
      await delay(5);
    }
  } else {
    for (;;) {
      await delay(1_000);
    }
  }
}
if (shutdownEndPath || shutdownDelayMs > 0) {
  process.stdin.once("end", () => {
    if (shutdownEndPath) {
      writeFileSync(shutdownEndPath, "ended");
    }
    if (shutdownDelayMs > 0) {
      void delay(shutdownDelayMs).then(() => process.exit(0));
    }
  });
}
if (process.env.TEST_IGNORE_SIGTERM === "true") {
  process.on("SIGTERM", () => undefined);
}
if (stderrMessage) {
  if (stderrSplitAt > 0 && stderrSplitAt < stderrMessage.length) {
    process.stderr.write(stderrMessage.slice(0, stderrSplitAt));
    await delay(0);
    process.stderr.write(`${stderrMessage.slice(stderrSplitAt)}\n`);
  } else {
    process.stderr.write(`${stderrMessage}\n`);
  }
}
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
    : process.env.TEST_WHOAMI_SCHEMA === "malformed-required"
      ? { type: "object", properties: {}, required: "account" }
      : { type: "object", properties: {} };
const createItemAnnotations = parseOptionalJson(process.env.TEST_CREATE_ITEM_ANNOTATIONS, "TEST_CREATE_ITEM_ANNOTATIONS");
const server = new Server(
  { name: "fake-upstream", version: "1.0.0" },
  { capabilities: { tools: {}, resources: resourceSubscriptions ? { subscribe: true } : {}, prompts: {} } }
);
server.oninitialized = () => {
  if (initializedPath) {
    writeFileSync(initializedPath, "initialized");
  }
  if (crashAfterInitializedPath && existsSync(crashAfterInitializedPath)) {
    void delay(0).then(() => process.exit(1));
  }
};

function parseOptionalJson(value, variableName) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${variableName} must contain valid JSON`);
  }
}

if (failInitialize || clientInfoPath) {
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    if (clientInfoPath) {
      writeFileSync(clientInfoPath, JSON.stringify(request.params.clientInfo));
    }
    if (failInitialize) {
      throw new Error(`test initialize failure: ${process.env.API_TOKEN}`);
    }
    return {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {}, resources: resourceSubscriptions ? { subscribe: true } : {}, prompts: {} },
      serverInfo: { name: "fake-upstream", version: "1.0.0" }
    };
  });
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  toolListRequests += 1;
  const changedToolList = changeToolListAfterFirstRequest && toolListRequests > 1;
  if (process.env.TEST_LIST_TOOLS_STARTED_PATH) {
    writeFileSync(process.env.TEST_LIST_TOOLS_STARTED_PATH, "started");
  }
  if (process.env.TEST_LIST_TOOLS_COUNT_PATH) {
    appendFileSync(process.env.TEST_LIST_TOOLS_COUNT_PATH, "1\n");
  }
  if (listToolsDelayMs > 0) {
    await delay(listToolsDelayMs);
  }
  if (listToolsProgress && request.params._meta?.progressToken !== undefined) {
    await server.notification({
      method: "notifications/progress",
      params: { progressToken: request.params._meta.progressToken, progress: 1, total: 2 }
    });
  }
  if (process.env.TEST_FAIL_LIST_TOOLS === "true") {
    throw new Error(`test tool list failure: ${process.env.TEST_ERROR_MESSAGE ?? process.env.API_TOKEN}`);
  }
  if (
    notifyToolListChangeOnListTools ||
    (notifyToolListChangeOnFirstListTools && toolListRequests === 1)
  ) {
    await server.sendToolListChanged();
  }
  if (listToolsDelayAfterNotificationMs > 0) {
    await delay(listToolsDelayAfterNotificationMs);
  }
  const secondPage = paginateTools && request.params?.cursor === "next";
  return {
    tools: [
      ...(secondPage
        ? [
            {
              name: "whoami_second",
              description: "Return the second injected account.",
              inputSchema: whoamiInputSchema
            },
            {
              name: "echo_second",
              description: "Echo a second message.",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"]
              }
            },
            {
              name: "create_second_item",
              description: "Create a second item.",
              inputSchema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"]
              }
            }
          ]
        : [
            {
              name: changedToolList ? "whoami_reloaded" : "whoami",
              description:
                process.env.TEST_INCLUDE_DISCOVERY_TOKEN === "true"
                  ? `Return the injected account ${process.env.API_TOKEN}`
                  : "Return the injected account.",
              inputSchema: whoamiInputSchema
            },
            {
              name: changedToolList ? "echo_reloaded" : "echo",
              description: "Echo a message.",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"]
              }
            },
            {
              name: changedToolList ? "create_reloaded_item" : "create_item",
              description: "Create an item.",
              inputSchema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"]
              },
              ...(createItemAnnotations === undefined ? {} : { annotations: createItemAnnotations })
            }
          ]),
      ...(includeIdentityTool && !secondPage
        ? [
            {
              name: "identity",
              description: "Return the configured account identity.",
              inputSchema: identityInputSchema
            }
          ]
        : []),
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
    ],
    ...(paginateTools && !secondPage ? { nextCursor: "next" } : {})
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (callToolStartedPath) {
    writeFileSync(callToolStartedPath, "started");
  }
  if (crashOnCallToolPath && existsSync(crashOnCallToolPath)) {
    void delay(0).then(() => process.exit(1));
    return new Promise(() => undefined);
  }
  if (process.env.TEST_CALL_TOOL_COUNT_PATH) {
    appendFileSync(process.env.TEST_CALL_TOOL_COUNT_PATH, "1\n");
  }
  if (request.params.name === "create_item" && createItemCountPath) {
    appendFileSync(createItemCountPath, "1\n");
  }
  if (process.env.TEST_FAIL_CALL_TOOL === "true") {
    throw new Error(`test tool call failure: ${process.env.API_TOKEN}`);
  }
  if (process.env.TEST_RETURN_CALL_TOOL_ERROR === "true") {
    return { content: [{ type: "text", text: "test tool returned an error result" }], isError: true };
  }
  if (callToolProgress && request.params._meta?.progressToken !== undefined) {
    await server.notification({
      method: "notifications/progress",
      params: {
        progressToken: request.params._meta.progressToken,
        progress: 1,
        total: 2,
        ...(callToolProgressMessage === undefined ? {} : { message: callToolProgressMessage })
      }
    });
  }
  if (notifyListChangesOnCallTool) {
    await Promise.all([
      server.sendToolListChanged(),
      server.sendResourceListChanged(),
      server.sendPromptListChanged()
    ]);
  }
  if (callToolDelayMs > 0) {
    await delay(callToolDelayMs);
  }
  if (request.params.name === "whoami") {
    return { content: [{ type: "text", text: oversizedIdentityLogin ?? account }] };
  }
  if (request.params.name === "identity") {
    return { content: [{ type: "text", text: identityResponse }] };
  }
  if (request.params.name === "echo") {
    return { content: [{ type: "text", text: String(request.params.arguments?.message ?? "") }] };
  }
  return { content: [{ type: "text", text: `created:${String(request.params.arguments?.name ?? "")}` }] };
});

server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
  if (cancelledPath) {
    appendFileSync(cancelledPath, `${notification.params.requestId}\n`);
  }
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
  if (listResourcesProgress && request.params._meta?.progressToken !== undefined) {
    await server.notification({
      method: "notifications/progress",
      params: { progressToken: request.params._meta.progressToken, progress: 1, total: 2 }
    });
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

if (!resourceTemplatesUnsupported) {
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    if (listResourceTemplatesProgress && request.params._meta?.progressToken !== undefined) {
      await server.notification({
        method: "notifications/progress",
        params: { progressToken: request.params._meta.progressToken, progress: 1, total: 2 }
      });
    }
    return {
      resourceTemplates:
        resourceTemplateUri === undefined
          ? []
          : [{ uriTemplate: resourceTemplateUri, name: resourceTemplateName, mimeType: "text/plain" }]
    };
  });
}

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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
  const templateResource =
    resourceTemplateUri !== undefined && new UriTemplate(resourceTemplateUri).match(request.params.uri) !== null;
  return {
    contents: [
      { uri: templateResource ? request.params.uri : resourceUri, text: responseText, mimeType: "text/plain" },
      ...(additionalResourceUri ? [{ uri: additionalResourceUri, text: responseText, mimeType: "text/plain" }] : [])
    ]
  };
});

server.setRequestHandler(SubscribeRequestSchema, async () => {
  if (!resourceSubscriptions) throw new Error("test upstream does not support resource subscriptions");
  if (subscribeStartedPath) writeFileSync(subscribeStartedPath, "started");
  if (subscribeCountPath) appendFileSync(subscribeCountPath, "1\n");
  if (subscribeDelayMs > 0) await delay(subscribeDelayMs);
  if (failSubscribe) throw new Error("test subscribe failure");
  const subscriptionGeneration = resourceSubscriptionStatefulUpdates ? ++resourceSubscriptionGeneration : undefined;
  if (resourceSubscriptionStatefulUpdates) resourceSubscribed = true;
  if (resourceUpdateUri) {
    const notify = async () => {
      if (
        resourceSubscriptionStatefulUpdates &&
        (!resourceSubscribed || resourceSubscriptionGeneration !== subscriptionGeneration)
      ) {
        return;
      }
      await server.sendResourceUpdated({ uri: resourceUpdateUri });
    };
    if (resourceUpdateDelayMs > 0) {
      void delay(resourceUpdateDelayMs).then(notify);
    } else {
      await notify();
    }
  }
  return {};
});

server.setRequestHandler(UnsubscribeRequestSchema, async () => {
  if (!resourceSubscriptions) throw new Error("test upstream does not support resource subscriptions");
  if (unsubscribeCountPath) appendFileSync(unsubscribeCountPath, "1\n");
  if (unsubscribeDelayMs > 0) await delay(unsubscribeDelayMs);
  if (resourceSubscriptionStatefulUpdates) {
    resourceSubscribed = false;
    resourceSubscriptionGeneration += 1;
  }
  return {};
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
  if (listPromptsProgress && request.params._meta?.progressToken !== undefined) {
    await server.notification({
      method: "notifications/progress",
      params: { progressToken: request.params._meta.progressToken, progress: 1, total: 2 }
    });
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
