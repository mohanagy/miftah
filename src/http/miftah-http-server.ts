import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Socket } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isCanonicalHttpHost, isLiteralLoopbackBindHost } from "../config/schema.js";
import { resolveRuntimeConfig } from "../runtime/resolve-runtime-config.js";
import { createHttpSessionRuntime, type MiftahRuntime } from "../runtime/create-miftah-runtime.js";
import { MiftahError } from "../utils/errors.js";

const endpointPath = "/mcp";
const defaultPort = 3000;
const defaultMaxSessions = 32;
const defaultSessionIdleTimeoutMs = 15 * 60_000;
const defaultMaxRequestBytes = 1_048_576;
const bracketedHostPortPattern = /^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/iu;
const decimalPortPattern = /^\d{1,5}$/u;
const decimalPattern = /^\d+$/u;
const requestTimeoutMs = 60_000;
const headersTimeoutMs = 10_000;
const connectionsCheckingIntervalMs = 5_000;

type SessionRuntimeFactory = (configPath: string) => Promise<MiftahRuntime>;

export interface MiftahHttpServer {
  /** The loopback-first Streamable HTTP endpoint. */
  readonly url: URL;
  /** Stops new admissions and closes every session runtime and retained upstream reference. */
  close(): Promise<void>;
}

/** Internal dependency injection points for lifecycle tests and embedding hosts. */
export interface MiftahHttpServerOptions {
  readonly sessionRuntimeFactory?: SessionRuntimeFactory;
  /** Receives fixed, non-sensitive operator warnings only. */
  readonly onWarning?: (message: string) => void;
  /** Receives a fixed message when asynchronous cleanup fails. */
  readonly onBackgroundFailure?: (message: string) => void;
}

interface HttpServerSettings {
  readonly host: string;
  readonly port: number;
  readonly authToken?: Buffer;
  readonly allowedHosts: ReadonlySet<string>;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly maxSessions: number;
  readonly sessionIdleTimeoutMs: number;
  readonly maxRequestBytes: number;
}

interface SessionRecord {
  id?: string;
  pending: boolean;
  timer?: NodeJS.Timeout;
  cleanup?: Promise<void>;
  readonly runtime: MiftahRuntime;
  readonly transport: StreamableHTTPServerTransport;
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly headers: Readonly<Record<string, string>> = {}
  ) {
    super(body);
  }
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  const normalizedName = name.toLowerCase();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === normalizedName) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined | null {
  const values = rawHeaderValues(request, name);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : null;
}

function hasForbiddenHeaderCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function hostFromHeader(value: string): string | undefined {
  if (value.length === 0 || value.length > 320 || hasForbiddenHeaderCharacter(value)) return undefined;
  let host: string;
  let port: string | undefined;
  if (value.startsWith("[")) {
    const match = bracketedHostPortPattern.exec(value);
    if (!match) return undefined;
    host = match[1]!.toLowerCase();
    port = match[2];
  } else {
    const separator = value.lastIndexOf(":");
    if (separator >= 0) {
      if (value.indexOf(":") !== separator) return undefined;
      host = value.slice(0, separator).toLowerCase();
      port = value.slice(separator + 1);
    } else {
      host = value.toLowerCase();
    }
  }
  if (!isCanonicalHttpHost(host)) return undefined;
  if (port !== undefined && (!decimalPortPattern.test(port) || Number(port) > 65_535)) return undefined;
  return host;
}

function isBearerToken(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !hasForbiddenHeaderCharacter(value);
}

function isInitializeRequest(value: unknown): value is { readonly jsonrpc: "2.0"; readonly method: "initialize" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.jsonrpc === "2.0" && message.method === "initialize" && Object.hasOwn(message, "id");
}

function writeResponse(response: ServerResponse, error: HttpRequestError): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.statusCode = error.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "text/plain; charset=utf-8");
  for (const [name, value] of Object.entries(error.headers)) response.setHeader(name, value);
  response.end(error.body);
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentLength = singleHeader(request, "content-length");
  if (contentLength === null || (contentLength !== undefined && !decimalPattern.test(contentLength))) {
    throw new HttpRequestError(400, "Bad Request");
  }
  if (contentLength !== undefined && Number(contentLength) > maximumBytes) {
    throw new HttpRequestError(413, "Payload Too Large");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximumBytes) {
        request.resume();
        throw new HttpRequestError(413, "Payload Too Large");
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, "Bad Request");
  }

  if (bytes === 0) throw new HttpRequestError(400, "Bad Request");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpRequestError(400, "Bad Request");
  }
}

function closeListener(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function endpointUrl(host: string, port: number): URL {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${urlHost}:${port}${endpointPath}`);
}

class HttpServerHost implements MiftahHttpServer {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pendingRecords = new Set<SessionRecord>();
  private readonly closingRecords = new Set<SessionRecord>();
  private readonly cleanupTasks = new Set<Promise<void>>();
  private readonly sockets = new Set<Socket>();
  private pendingInitializations = 0;
  private cleanupFailed = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    readonly url: URL,
    private readonly server: Server,
    private readonly configPath: string,
    private readonly settings: HttpServerSettings,
    private readonly sessionRuntimeFactory: SessionRuntimeFactory,
    private readonly onBackgroundFailure: (message: string) => void
  ) {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await this.route(request, response);
    } catch (error) {
      writeResponse(
        response,
        error instanceof HttpRequestError ? error : new HttpRequestError(500, "Internal Server Error")
      );
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed) throw new HttpRequestError(503, "Service Unavailable");
    if (!this.isEndpointRequest(request)) throw new HttpRequestError(404, "Not Found");
    if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
      throw new HttpRequestError(405, "Method Not Allowed", { allow: "DELETE, GET, POST" });
    }
    if (!this.isAllowedHost(request) || !this.isAllowedOrigin(request)) {
      throw new HttpRequestError(403, "Forbidden");
    }
    if (!this.isAuthorized(request)) {
      throw new HttpRequestError(401, "Unauthorized", { "www-authenticate": "Bearer" });
    }

    const sessionId = singleHeader(request, "mcp-session-id");
    if (sessionId === null || (sessionId !== undefined && (sessionId.length === 0 || sessionId.length > 512))) {
      throw new HttpRequestError(400, "Bad Request");
    }

    const body = request.method === "POST" ? await this.parsePostBody(request) : undefined;
    if (sessionId === undefined) {
      if (request.method !== "POST" || !isInitializeRequest(body)) throw new HttpRequestError(400, "Bad Request");
      await this.initializeSession(request, response, body);
      return;
    }

    const session = this.sessions.get(sessionId);
    if (session === undefined || session.cleanup !== undefined) throw new HttpRequestError(404, "Not Found");
    this.touch(session);
    await session.transport.handleRequest(request, response, body);
  }

  private isEndpointRequest(request: IncomingMessage): boolean {
    return request.url === endpointPath;
  }

  private isAllowedHost(request: IncomingMessage): boolean {
    const host = singleHeader(request, "host");
    if (host === undefined || host === null) return false;
    const normalized = hostFromHeader(host);
    return normalized !== undefined && this.settings.allowedHosts.has(normalized);
  }

  private isAllowedOrigin(request: IncomingMessage): boolean {
    const origin = singleHeader(request, "origin");
    return origin === undefined || (origin !== null && this.settings.allowedOrigins.has(origin));
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const expected = this.settings.authToken;
    if (expected === undefined) return true;
    const authorization = singleHeader(request, "authorization");
    if (authorization === undefined || authorization === null || !authorization.startsWith("Bearer ")) return false;
    const receivedToken = authorization.slice("Bearer ".length);
    if (!isBearerToken(receivedToken)) return false;
    const received = Buffer.from(receivedToken, "utf8");
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  private async parsePostBody(request: IncomingMessage): Promise<unknown> {
    const contentType = singleHeader(request, "content-type");
    if (
      contentType === undefined ||
      contentType === null ||
      contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    ) {
      throw new HttpRequestError(415, "Unsupported Media Type");
    }
    return readJsonBody(request, this.settings.maxRequestBytes);
  }

  private async initializeSession(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    const session = await this.createSession();
    try {
      await session.transport.handleRequest(request, response, body);
      if (session.id === undefined) await this.cleanupRecord(session, true);
    } catch {
      try {
        await this.cleanupRecord(session, true);
      } catch {
        this.onBackgroundFailure("Miftah HTTP session cleanup failed.");
      }
      throw new HttpRequestError(500, "Internal Server Error");
    }
  }

  private async createSession(): Promise<SessionRecord> {
    if (this.sessions.size + this.pendingInitializations + this.closingRecords.size >= this.settings.maxSessions) {
      throw new HttpRequestError(429, "Too Many Requests");
    }
    this.pendingInitializations += 1;
    let record: SessionRecord | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        if (record === undefined || record.cleanup !== undefined) return;
        record.id = sessionId;
        this.pendingRecords.delete(record);
        if (record.pending) {
          record.pending = false;
          this.pendingInitializations -= 1;
        }
        this.sessions.set(sessionId, record);
        this.touch(record);
        if (this.closed) this.scheduleCleanup(record, true);
      },
      onsessionclosed: (sessionId) => {
        const session = this.sessions.get(sessionId);
        if (session !== undefined) this.scheduleCleanup(session, false);
      }
    });

    try {
      const runtime = await this.sessionRuntimeFactory(this.configPath);
      if (this.closed) {
        try {
          await runtime.close();
        } catch {
          this.onBackgroundFailure("Miftah HTTP session cleanup failed.");
        }
        throw new HttpRequestError(503, "Service Unavailable");
      }
      record = { runtime, transport, pending: true };
      this.pendingRecords.add(record);
      await runtime.connect(transport);
      return record;
    } catch (error) {
      if (record !== undefined) {
        try {
          await this.cleanupRecord(record, true);
        } catch {
          this.onBackgroundFailure("Miftah HTTP session cleanup failed.");
        }
      } else {
        this.pendingInitializations -= 1;
        try {
          await transport.close();
        } catch {
          this.onBackgroundFailure("Miftah HTTP session cleanup failed.");
        }
      }
      if (error instanceof HttpRequestError) throw error;
      throw new HttpRequestError(500, "Internal Server Error");
    }
  }

  private touch(record: SessionRecord): void {
    if (record.cleanup !== undefined || record.id === undefined) return;
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.timer = setTimeout(() => this.scheduleCleanup(record, true), this.settings.sessionIdleTimeoutMs);
    record.timer.unref();
  }

  private detach(record: SessionRecord): void {
    if (record.id !== undefined) this.sessions.delete(record.id);
    this.pendingRecords.delete(record);
    if (record.pending) {
      record.pending = false;
      this.pendingInitializations -= 1;
    }
    if (record.timer !== undefined) {
      clearTimeout(record.timer);
      record.timer = undefined;
    }
  }

  private beginCleanup(record: SessionRecord): void {
    this.closingRecords.add(record);
    this.detach(record);
  }

  private cleanupRecord(record: SessionRecord, closeTransport: boolean): Promise<void> {
    if (record.cleanup !== undefined) return record.cleanup;
    this.beginCleanup(record);
    record.cleanup = (async () => {
      let failed = false;
      try {
        await record.runtime.close();
      } catch {
        failed = true;
      }
      if (closeTransport) {
        try {
          await record.transport.close();
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error("Miftah HTTP session cleanup failed.");
    })();
    void record.cleanup.then(
      () => this.closingRecords.delete(record),
      () => {
        this.cleanupFailed = true;
      }
    );
    return record.cleanup;
  }

  private scheduleCleanup(record: SessionRecord, closeTransport: boolean): void {
    if (record.cleanup !== undefined || this.closingRecords.has(record)) return;
    this.beginCleanup(record);
    const task = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.cleanupRecord(record, closeTransport));
    this.cleanupTasks.add(task);
    void task.then(
      () => this.cleanupTasks.delete(task),
      () => {
        this.cleanupTasks.delete(task);
        this.onBackgroundFailure("Miftah HTTP session cleanup failed.");
      }
    );
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    const listener = closeListener(this.server).catch(() => {
      throw new Error("Miftah HTTP server shutdown failed.");
    });
    const records = [...this.sessions.values(), ...this.pendingRecords];
    const results = await Promise.allSettled(records.map((record) => this.cleanupRecord(record, true)));
    const cleanupTaskResults = await Promise.allSettled([...this.cleanupTasks]);
    for (const socket of this.sockets) socket.destroy();
    let listenerFailed = false;
    try {
      await listener;
    } catch {
      listenerFailed = true;
    }
    if (
      this.cleanupFailed ||
      listenerFailed ||
      results.some((result) => result.status === "rejected") ||
      cleanupTaskResults.some((result) => result.status === "rejected")
    ) {
      throw new Error("Miftah HTTP server shutdown failed.");
    }
  }
}

/** Starts a localhost-first Streamable HTTP endpoint with isolated MCP session runtimes. */
export async function startMiftahHttpServer(
  configPath: string,
  options: MiftahHttpServerOptions = {}
): Promise<MiftahHttpServer> {
  const resolved = await resolveRuntimeConfig(configPath, undefined, { resolveServerHttpAuthToken: true });
  const config = resolved.config.server?.http;
  const host = config?.host ?? "127.0.0.1";
  const port = config?.port ?? defaultPort;
  const authToken = config?.authToken;
  if (authToken !== undefined && !isBearerToken(authToken)) {
    throw new MiftahError(
      "CONFIG_SCHEMA_INVALID",
      "CONFIG_SCHEMA_INVALID: HTTP authentication secret resolved to an invalid bearer token"
    );
  }

  const settings: HttpServerSettings = {
    host,
    port,
    authToken: authToken === undefined ? undefined : Buffer.from(authToken, "utf8"),
    allowedHosts: new Set(config?.allowedHosts ?? [host]),
    allowedOrigins: new Set(config?.allowedOrigins ?? []),
    maxSessions: config?.maxSessions ?? defaultMaxSessions,
    sessionIdleTimeoutMs: config?.sessionIdleTimeoutMs ?? defaultSessionIdleTimeoutMs,
    maxRequestBytes: config?.maxRequestBytes ?? defaultMaxRequestBytes
  };
  const server = createServer({
    requestTimeout: requestTimeoutMs,
    headersTimeout: headersTimeoutMs,
    connectionsCheckingInterval: connectionsCheckingIntervalMs
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(settings.port, settings.host);
  }).catch((error: unknown) => {
    throw new Error("Unable to start the Miftah HTTP server.", { cause: error });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    try {
      await closeListener(server);
    } catch {
      throw new Error("Unable to start the Miftah HTTP server.");
    }
    throw new Error("Unable to start the Miftah HTTP server.");
  }

  const hostServer = new HttpServerHost(
    endpointUrl(settings.host, address.port),
    server,
    configPath,
    settings,
    options.sessionRuntimeFactory ?? createHttpSessionRuntime,
    options.onBackgroundFailure ?? ((message) => process.stderr.write(`${message}\n`))
  );
  server.on("request", (request, response) => {
    void hostServer.handle(request, response);
  });
  if (!isLiteralLoopbackBindHost(settings.host)) {
    (options.onWarning ?? ((message) => process.stderr.write(`${message}\n`)))(
      "WARNING: Miftah HTTP serving is bound to a non-loopback host with bearer authentication enabled."
    );
  }
  return hostServer;
}
