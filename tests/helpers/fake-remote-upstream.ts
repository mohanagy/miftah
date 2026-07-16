import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CancelledNotificationSchema,
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

interface StreamableSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface SseSession {
  server: McpServer;
  transport: SSEServerTransport;
}

export interface RemoteRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

export interface FakeRemoteUpstream {
  readonly streamableHttpUrl: string;
  readonly sseUrl: string;
  requests(): readonly RemoteRequest[];
  toolCallRequests(): number;
  cancelledNotifications(): number;
  failNextStreamableRequest(status: number, body: string): void;
  failNextSsePost(status: number, body: string): void;
  hangStreamableDeletes(): void;
  hangingStreamableDeleteClosed(): boolean;
  releaseHangingStreamableDelete(): void;
  streamableSessionIds(): readonly string[];
  closedStreamableSessionIds(): readonly string[];
  close(): Promise<void>;
}

export interface OAuthCompatibilityProbe {
  readonly streamableHttpUrl: string;
  discoveryRequests(): readonly string[];
  registrationRequests(): readonly {
    readonly clientName: string;
    readonly redirectUri: string;
    readonly scope: string;
  }[];
  tokenExchanges(): readonly {
    readonly clientId: string;
    readonly codeWasExpected: boolean;
    readonly codeVerifierPresent: boolean;
    readonly grantType: string;
    readonly redirectUri: string;
    readonly resource: string;
  }[];
  authenticatedMcpRequests(): number;
  unauthenticatedMcpRequests(): number;
  close(): Promise<void>;
}

export interface FakeRemoteUpstreamOptions {
  readonly initializationStatus?: number;
  readonly initializationBody?: string;
  readonly callToolError?: { code: number; message: string };
  readonly callToolDelayMs?: number;
  readonly emitCallToolProgress?: boolean;
}

interface FakeRemoteCallToolState {
  toolCallRequests: number;
  cancelledNotifications: number;
}

/** Starts real local MCP HTTP and legacy SSE endpoints for remote transport integration tests. */
export async function startFakeRemoteUpstream(options: FakeRemoteUpstreamOptions = {}): Promise<FakeRemoteUpstream> {
  const requests: RemoteRequest[] = [];
  const streamableSessions = new Map<string, StreamableSession>();
  const sseSessions = new Map<string, SseSession>();
  const closedStreamableSessionIds: string[] = [];
  const callToolState: FakeRemoteCallToolState = { toolCallRequests: 0, cancelledNotifications: 0 };
  let nextStreamableFailure: { status: number; body: string } | undefined;
  let nextSsePostFailure: { status: number; body: string } | undefined;
  let hangStreamableDeletes = false;
  let hangingStreamableDeleteClosed = false;
  const releaseHangingStreamableDeletes = new Set<() => void>();

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const baseUrl = `http://${request.headers.host ?? "127.0.0.1"}`;
    const url = new URL(request.url ?? "/", baseUrl);
    requests.push({
      method: request.method ?? "UNKNOWN",
      path: url.pathname,
      headers: normalizeHeaders(request)
    });

    if (url.pathname === "/mcp") {
      const sessionId = request.headers["mcp-session-id"];
      if (!sessionId && options.initializationStatus !== undefined) {
        response.statusCode = options.initializationStatus;
        response.end(options.initializationBody ?? "fake remote initialization failure");
        return;
      }
      if (typeof sessionId === "string") {
        const session = streamableSessions.get(sessionId);
        if (!session) {
          response.statusCode = 404;
          response.end("unknown MCP session");
          return;
        }
        if (request.method === "DELETE" && hangStreamableDeletes) {
          await new Promise<void>((resolve) => {
            const release = (): void => {
              releaseHangingStreamableDeletes.delete(release);
              if (!response.writableEnded) {
                response.statusCode = 500;
                response.end("fake remote DELETE release");
              }
              resolve();
            };
            request.once("close", () => {
              hangingStreamableDeleteClosed = true;
              releaseHangingStreamableDeletes.delete(release);
              if (!response.writableEnded) response.destroy();
              resolve();
            });
            releaseHangingStreamableDeletes.add(release);
          });
          return;
        }
        if (request.method === "POST" && nextStreamableFailure) {
          const failure = nextStreamableFailure;
          nextStreamableFailure = undefined;
          response.statusCode = failure.status;
          response.end(failure.body);
          return;
        }
        await session.transport.handleRequest(request, response);
        return;
      }
      if (request.method !== "POST") {
        response.statusCode = 400;
        response.end("MCP initialization requires POST");
        return;
      }

      const server = createMcpServer(request.headers["x-profile"], options, callToolState);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (createdSessionId) => {
          streamableSessions.set(createdSessionId, { server, transport });
        },
        onsessionclosed: (closedSessionId) => {
          streamableSessions.delete(closedSessionId);
          closedStreamableSessionIds.push(closedSessionId);
        }
      });
      await server.connect(transport);
      await transport.handleRequest(request, response);
      return;
    }

    if (url.pathname === "/sse" && request.method === "GET") {
      const server = createMcpServer(request.headers["x-profile"], options, callToolState);
      const transport = new SSEServerTransport("/messages", response);
      sseSessions.set(transport.sessionId, { server, transport });
      await server.connect(transport);
      return;
    }

    if (url.pathname === "/messages" && request.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      const session = sessionId ? sseSessions.get(sessionId) : undefined;
      if (!session) {
        response.statusCode = 404;
        response.end("unknown SSE session");
        return;
      }
      if (nextSsePostFailure) {
        const failure = nextSsePostFailure;
        nextSsePostFailure = undefined;
        response.statusCode = failure.status;
        response.end(failure.body);
        return;
      }
      await session.transport.handlePostMessage(request, response);
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  };

  const httpServer = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      response.statusCode = 500;
      response.end("fake remote upstream failure");
    });
  });
  await listen(httpServer);
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address for fake remote upstream");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    streamableHttpUrl: `${baseUrl}/mcp`,
    sseUrl: `${baseUrl}/sse`,
    requests: () => requests.map((request) => ({ ...request, headers: { ...request.headers } })),
    toolCallRequests: () => callToolState.toolCallRequests,
    cancelledNotifications: () => callToolState.cancelledNotifications,
    failNextStreamableRequest(status: number, body: string): void {
      nextStreamableFailure = { status, body };
    },
    failNextSsePost(status: number, body: string): void {
      nextSsePostFailure = { status, body };
    },
    hangStreamableDeletes(): void {
      hangingStreamableDeleteClosed = false;
      hangStreamableDeletes = true;
    },
    hangingStreamableDeleteClosed(): boolean {
      return hangingStreamableDeleteClosed;
    },
    releaseHangingStreamableDelete(): void {
      hangStreamableDeletes = false;
      for (const release of [...releaseHangingStreamableDeletes]) release();
    },
    streamableSessionIds: () => [...streamableSessions.keys()],
    closedStreamableSessionIds: () => [...closedStreamableSessionIds],
    async close(): Promise<void> {
      for (const release of [...releaseHangingStreamableDeletes]) release();
      await Promise.all([
        ...[...streamableSessions.values()].map(({ transport }) => transport.close()),
        ...[...sseSessions.values()].map(({ transport }) => transport.close())
      ]);
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

/**
 * Starts a deterministic loopback-only protected MCP resource for OAuth SDK compatibility tests.
 * It deliberately uses fixture-only opaque values and never reaches a browser or live authorization server.
 */
export async function startOAuthCompatibilityProbe(): Promise<OAuthCompatibilityProbe> {
  const discoveryRequests: string[] = [];
  const registrationRequests: Array<{ clientName: string; redirectUri: string; scope: string }> = [];
  const tokenExchanges: Array<{
    clientId: string;
    codeWasExpected: boolean;
    codeVerifierPresent: boolean;
    grantType: string;
    redirectUri: string;
    resource: string;
  }> = [];
  const sessions = new Map<string, StreamableSession>();
  const callToolState: FakeRemoteCallToolState = { toolCallRequests: 0, cancelledNotifications: 0 };
  let authenticatedMcpRequests = 0;
  let unauthenticatedMcpRequests = 0;
  let baseUrl = "";

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", baseUrl);
    if (requestUrl.pathname === "/.well-known/oauth-protected-resource" && request.method === "GET") {
      discoveryRequests.push(requestUrl.pathname);
      sendJson(response, 200, {
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ["mcp:tools"]
      });
      return;
    }

    if (requestUrl.pathname === "/.well-known/oauth-authorization-server" && request.method === "GET") {
      discoveryRequests.push(requestUrl.pathname);
      sendJson(response, 200, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"]
      });
      return;
    }

    if (requestUrl.pathname === "/oauth/register" && request.method === "POST") {
      const registration = await readJsonRecord(request);
      const redirectUri = Array.isArray(registration.redirect_uris) ? registration.redirect_uris[0] : undefined;
      registrationRequests.push({
        clientName: typeof registration.client_name === "string" ? registration.client_name : "",
        redirectUri: typeof redirectUri === "string" ? redirectUri : "",
        scope: typeof registration.scope === "string" ? registration.scope : ""
      });
      sendJson(response, 201, {
        client_id: "miftah-compatibility-client",
        redirect_uris: typeof redirectUri === "string" ? [redirectUri] : [],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      });
      return;
    }

    if (requestUrl.pathname === "/oauth/token" && request.method === "POST") {
      const parameters = new URLSearchParams(await readRequestBody(request));
      tokenExchanges.push({
        clientId: parameters.get("client_id") ?? "",
        codeWasExpected: parameters.get("code") === "fixture-authorization-code",
        codeVerifierPresent: (parameters.get("code_verifier")?.length ?? 0) > 0,
        grantType: parameters.get("grant_type") ?? "",
        redirectUri: parameters.get("redirect_uri") ?? "",
        resource: parameters.get("resource") ?? ""
      });
      sendJson(response, 200, {
        access_token: "fixture-access-token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: "mcp:tools"
      });
      return;
    }

    if (requestUrl.pathname !== "/mcp") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    if (request.headers.authorization !== "Bearer fixture-access-token") {
      unauthenticatedMcpRequests += 1;
      response.writeHead(401, {
        "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="mcp:tools"`
      });
      response.end();
      return;
    }

    authenticatedMcpRequests += 1;
    if (request.method === "GET") {
      response.statusCode = 405;
      response.end();
      return;
    }

    const sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      if (!session) {
        response.statusCode = 404;
        response.end("unknown MCP session");
        return;
      }
      await session.transport.handleRequest(request, response);
      return;
    }

    if (request.method !== "POST") {
      response.statusCode = 400;
      response.end("MCP initialization requires POST");
      return;
    }

    const server = createMcpServer(undefined, {}, callToolState);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (createdSessionId) => {
        sessions.set(createdSessionId, { server, transport });
      },
      onsessionclosed: (closedSessionId) => {
        sessions.delete(closedSessionId);
      }
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  };

  const httpServer = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      response.statusCode = 500;
      response.end("OAuth compatibility probe failure");
    });
  });
  await listen(httpServer);
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address for the OAuth compatibility probe");
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    streamableHttpUrl: `${baseUrl}/mcp`,
    discoveryRequests: () => [...discoveryRequests],
    registrationRequests: () => registrationRequests.map((request) => ({ ...request })),
    tokenExchanges: () => tokenExchanges.map((exchange) => ({ ...exchange })),
    authenticatedMcpRequests: () => authenticatedMcpRequests,
    unauthenticatedMcpRequests: () => unauthenticatedMcpRequests,
    async close(): Promise<void> {
      await Promise.all([...sessions.values()].map(({ transport }) => transport.close()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

function createMcpServer(
  profileHeader: string | string[] | undefined,
  options: FakeRemoteUpstreamOptions,
  callToolState: FakeRemoteCallToolState
): McpServer {
  const profile = Array.isArray(profileHeader) ? profileHeader.join(",") : profileHeader ?? "unknown";
  const server = new McpServer(
    { name: "fake-remote-upstream", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "whoami", description: "Return the request profile.", inputSchema: { type: "object", properties: {} } }
    ]
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    callToolState.toolCallRequests += 1;
    if (options.callToolError) {
      throw new McpError(options.callToolError.code, options.callToolError.message);
    }
    if (options.emitCallToolProgress && request.params._meta?.progressToken !== undefined) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: request.params._meta.progressToken, progress: 1, total: 2 }
      });
    }
    if (options.callToolDelayMs && options.callToolDelayMs > 0) await delay(options.callToolDelayMs);
    return { content: [{ type: "text", text: profile }] };
  });
  server.setNotificationHandler(CancelledNotificationSchema, () => {
    callToolState.cancelledNotifications += 1;
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "account://current", name: "Current profile", mimeType: "text/plain" }]
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async () => ({
    contents: [{ uri: "account://current", text: profile, mimeType: "text/plain" }]
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: "account_prompt", description: "Current profile prompt." }]
  }));
  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    messages: [{ role: "user", content: { type: "text", text: profile } }]
  }));
  return server;
}

function normalizeHeaders(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value ?? ""])
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonRecord(request: IncomingMessage): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readRequestBody(request));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OAuth compatibility registration must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function listen(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
