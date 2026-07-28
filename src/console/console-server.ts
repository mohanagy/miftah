import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";
import { loadConfig } from "../config/load-config.js";
import { PRESET_CATALOG } from "../config/presets.js";
import { MiftahError } from "../utils/errors.js";
import { CLIENT_NAMES, type ClientLauncher, type ClientSelection } from "../cli/client-snippets.js";
import { consoleAsset, type ConsoleAsset } from "./console-assets.js";
import {
  ConsoleApplicationService,
  type ConsoleControlApplication
} from "./console-application-service.js";

export type { ConsoleControlApplication } from "./console-application-service.js";

const loopbackHost = "127.0.0.1";
const defaultMaximumRequestBytes = 64 * 1024;
const maximumClientEntryDocumentBytes = 64 * 1024;
/** The pasted JSON is subsequently limited to 64 KiB; this only leaves bounded room for JSON string escaping and the request envelope. */
const maximumClientEntryOnboardingRequestBytes = maximumClientEntryDocumentBytes * 2 + 8 * 1024;
const defaultMaximumSessions = 8;
const defaultBootstrapTtlMs = 5 * 60_000;
const defaultMaximumRequestsPerMinute = 240;
const defaultMaximumBootstrapAttemptsPerMinute = 8;
const rateWindowMs = 60_000;
const defaultIdleSessionMs = 15 * 60_000;
const defaultAbsoluteSessionMs = 60 * 60_000;
const requestTimeoutMs = 30_000;
const headersTimeoutMs = 10_000;
const connectionsCheckingIntervalMs = 5_000;
const maximumHeaderBytes = 16 * 1024;
const sessionCookieName = "miftah_console_session";
const bootstrapSchema = z.object({}).strict();
const httpsUrlSchema = z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:");
const connectionAddSchema = z.object({
  connectionRef: z.string().min(1).max(512).optional(),
  profile: z.string().min(1).max(256),
  upstream: z.string().min(1).max(256).optional(),
  issuer: z.string().url().max(2_048),
  clientRegistration: z.string().min(1).max(2_048),
  scopes: z.array(z.string().min(1).max(512)).max(128)
}).strict();
const discoveredNativeOAuthConnectionSchema = z.object({
  profile: z.string().min(1).max(256),
  upstream: z.string().min(1).max(256)
}).strict();
const discoveredNativeOAuthAccountSchema = z.object({
  profile: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,63})$/u),
  description: z.string().max(1_024).optional(),
  upstream: z.string().min(1).max(256),
  makeDefault: z.literal(true).optional()
}).strict();
const providerAccountAdditionSchema = z.object({
  profile: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,63})$/u),
  description: z.string().max(1_024).optional(),
  credentialFile: z.string().min(1).max(4_096),
  makeDefault: z.literal(true).optional()
}).strict();
const environmentProfileAdditionSchema = z.object({
  profile: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,63})$/u),
  description: z.string().min(1).max(1_024).optional(),
  credentialEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  makeDefault: z.literal(true).optional()
}).strict();
const defaultProfileChangeSchema = z.object({
  // Profile keys are compatibility data owned by the selected configuration.
  // Validate their existence in the guarded configuration transaction rather
  // than imposing the narrower preset-onboarding slug grammar here.
  profile: z.string().min(1)
}).strict();
// Keep the HTTP boundary bounded, while the guarded configuration change owns
// all description-format rules and its safe public error mapping.
const profileDescriptionTextSchema = z.string().max(1_024);
const profileDescriptionChangeSchema = z.object({
  // Profile keys are compatibility data owned by the selected configuration.
  // Validate their existence in the guarded configuration transaction rather
  // than imposing the narrower preset-onboarding slug grammar here.
  profile: z.string().min(1),
  description: profileDescriptionTextSchema.optional(),
  clearDescription: z.literal(true).optional()
}).strict().superRefine((value, context) => {
  if ((value.description === undefined) === (value.clearDescription !== true)) {
    context.addIssue({ code: "custom", message: "Provide a description or explicitly clear it." });
  }
});
const profileRemovalSchema = z.object({
  // Profile keys are compatibility data owned by the selected configuration.
  // Validate their existence and any durable references in the guarded
  // configuration transaction rather than imposing preset-onboarding grammar.
  profile: z.string().min(1),
  replacementProfile: z.string().min(1).optional()
}).strict();
const profileRenameSchema = z.object({
  // Preserve compatibility with existing profile keys for the selected source
  // profile. The guarded lifecycle owns existence checks; a new profile name
  // is bounded here and fully safety-validated before it becomes an object key.
  profile: z.string().min(1),
  newProfile: z.string().min(1).max(256)
}).strict();
const nativeOAuthOnboardingSchema = z.object({
  name: z.string().min(1).max(256),
  profile: z.string().min(1).max(256),
  description: z.string().max(1_024).optional(),
  resource: z.string().url().max(2_048),
  issuer: z.string().url().max(2_048),
  clientRegistration: z.string().min(1).max(2_048),
  scopes: z.array(z.string().min(1).max(512)).max(128)
}).strict();
const discoveredNativeOAuthOnboardingSchema = z.object({
  name: z.string().min(1).max(256),
  profile: z.string().min(1).max(256),
  description: z.string().max(1_024).optional(),
  resource: httpsUrlSchema
}).strict();
const googleSearchConsoleProfileSchema = z.object({
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,63})$/u),
  description: z.string().min(1).max(1_024).optional(),
  oauthClientSecretsFile: z.string().min(1).max(4_096)
}).strict();
const presetOnboardingSchema = z.object({
  name: z.string().min(1).max(256),
  preset: z.string().min(1).max(128),
  credentialEnv: z.string().min(1).max(256).optional(),
  npmPackage: z.string().min(1).max(1_024).optional(),
  dockerImage: z.string().min(1).max(2_048).optional(),
  url: z.string().min(1).max(2_048).optional(),
  headerName: z.string().min(1).max(256).optional(),
  headerPrefix: z.string().max(256).optional(),
  oauthClientSecretsFile: z.string().min(1).max(4_096).optional(),
  localCommand: z.string().min(1).max(4_096).optional(),
  args: z.array(z.string().max(4_096)).max(128).optional(),
  cwd: z.string().min(1).max(4_096).optional(),
  acceptLocalCommand: z.literal(true).optional(),
  googleSearchConsoleProfiles: z.array(googleSearchConsoleProfileSchema).min(1).optional(),
  defaultProfile: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,63})$/u).optional()
}).strict().superRefine((request, context) => {
  if (
    request.preset === "google-search-console" &&
    (request.googleSearchConsoleProfiles?.length ?? 0) > 1 &&
    request.defaultProfile === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultProfile"],
      message: "Google Search Console setup requires an explicit default profile when more than one account is configured."
    });
  }
  if (request.preset === "local-stdio" && request.acceptLocalCommand !== true) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acceptLocalCommand"],
      message: "Local stdio setup requires explicit acknowledgement before a command is saved."
    });
  }
});
const setupDraftSchema = z.object({
  source: z.literal("connector"),
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,63})?$/u),
  preset: z.string().max(128).refine((value) => Object.hasOwn(PRESET_CATALOG.presets, value)),
  stage: z.literal("connection"),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
}).strict();
const setupDraftDiscardSchema = z.object({
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
}).strict();
const clientEntryOnboardingSchema = z.object({
  name: z.string().min(1).max(256),
  entry: z.string().min(1).max(256),
  /** Parsed in memory only; it is never persisted, echoed, or added to audit records. */
  document: z.string().min(1).max(maximumClientEntryDocumentBytes)
}).strict();
const profileReadinessSchema = z.object({
  profile: z.string().min(1).max(256),
  upstream: z.string().min(1).max(256).optional()
}).strict();

interface BrowserSession {
  readonly id: string;
  readonly csrfToken: string;
  readonly createdAt: number;
  lastUsedAt: number;
}

export interface ConsoleServer {
  readonly url: URL;
  /** Invocation-bound bootstrap credential. Print it only to the launching terminal. */
  readonly bootstrapCredential: string;
  /** Invalidates every browser session and returns a fresh one-use bootstrap credential. */
  rotateCredential(): string;
  close(): Promise<void>;
}

export interface ConsoleServerOptions {
  readonly bootstrapCredential?: string;
  readonly port?: number;
  readonly maximumRequestBytes?: number;
  readonly maximumSessions?: number;
  readonly bootstrapTtlMs?: number;
  readonly maximumRequestsPerMinute?: number;
  readonly maximumBootstrapAttemptsPerMinute?: number;
  readonly idleSessionMs?: number;
  readonly absoluteSessionMs?: number;
  readonly now?: () => number;
  /** Allows the dashboard to start before its first configuration is created. */
  readonly allowMissingConfig?: boolean;
  /** Lets the no-config dashboard application safely inspect its bounded catalog before a default path is valid. */
  readonly deferConfigValidation?: boolean;
  /** Exact installed CLI launcher used only to generate copyable client snippets. */
  readonly launcher?: ClientLauncher;
  /** Internal embedding/test seam; production CLI uses the native in-process application service. */
  readonly application?: ConsoleControlApplication;
}

interface ResolvedConsoleServerOptions extends Required<Pick<ConsoleServerOptions, "maximumRequestBytes" | "maximumSessions" | "bootstrapTtlMs" | "maximumRequestsPerMinute" | "maximumBootstrapAttemptsPerMinute" | "idleSessionMs" | "absoluteSessionMs" | "now">> {
  /** The default leaves bounded JSON-escaping room for a 64 KiB document; an explicit global cap remains authoritative. */
  readonly maximumClientEntryOnboardingRequestBytes: number;
}

class ConsoleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly message: string,
    readonly headers: Readonly<Record<string, string>> = {}
  ) {
    super(message);
  }
}

function randomCredential(): string {
  return randomBytes(32).toString("base64url");
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  const expected = name.toLowerCase();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === expected) {
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

function safeEqual(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(body));
}

function writeAsset(response: ServerResponse, requestMethod: string | undefined, asset: ConsoleAsset): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.statusCode = 200;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", asset.contentType);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
      "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  response.end(requestMethod === "HEAD" ? undefined : asset.body);
}

function writeError(response: ServerResponse, error: ConsoleHttpError): void {
  writeJson(response, error.status, { error: { code: error.code, message: error.message } }, error.headers);
}

function publicApplicationError(error: unknown): ConsoleHttpError {
  if (!(error instanceof MiftahError)) {
    return new ConsoleHttpError(500, "internal_error", "The Console request failed.");
  }
  if (error.code === "AUDIT_WRITE_FAILED") {
    return new ConsoleHttpError(503, "audit_unavailable", "The required Console audit journal is unavailable.");
  }
  if (error.code === "OAUTH_CONNECTION_NOT_FOUND") {
    return new ConsoleHttpError(404, "oauth_connection_not_found", "The OAuth connection does not exist.");
  }
  if (error.code === "CONSOLE_CONFIGURATION_NOT_FOUND") {
    return new ConsoleHttpError(404, "configuration_not_found", "The selected configuration is not available.");
  }
  if (error.code === "CONSOLE_CONFIGURATION_SELECTION_REQUIRED") {
    return new ConsoleHttpError(409, "configuration_selection_required", "Select a configuration before using this Console control.");
  }
  if (error.code === "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE") {
    return new ConsoleHttpError(503, "configuration_discovery_unavailable", "The standard configuration directory is unavailable.");
  }
  if (error.code === "CONFIG_ALREADY_EXISTS") {
    return new ConsoleHttpError(409, "config_already_exists", "A configuration already exists at this location.");
  }
  if (error.code === "CONFIG_CREATE_FAILED") {
    return new ConsoleHttpError(503, "config_create_failed", "The initial configuration could not be created.");
  }
  if (error.code === "CONSOLE_LAUNCHER_UNAVAILABLE") {
    return new ConsoleHttpError(
      503,
      "console_launcher_unavailable",
      "Client snippets are unavailable because the Console launcher is not configured."
    );
  }
  if (error.code === "CLIENT_ENTRY_STATIC_LAUNCH_UNSUPPORTED") {
    return new ConsoleHttpError(
      422,
      "client_entry_static_launch_unsupported",
      "This entry needs manual transport setup. Miftah did not import it or write a configuration. It did not retain its arguments, headers, environment values, or credentials. Re-enter a reviewed executable and literal arguments, or a canonical HTTPS endpoint; configure authentication separately."
    );
  }
  if (error.code === "OAUTH_DISCOVERY_UNSUPPORTED") {
    return new ConsoleHttpError(
      422,
      "oauth_discovery_unsupported",
      "The endpoint does not support the required standards-based OAuth setup."
    );
  }
  if (error.code === "OAUTH_CLIENT_REGISTRATION_UNSUPPORTED") {
    return new ConsoleHttpError(
      422,
      "oauth_client_registration_unsupported",
      "The endpoint does not support automatic OAuth setup. Use its documented manual registration details."
    );
  }
  if (error.code === "OAUTH_RESOURCE_INVALID") {
    return new ConsoleHttpError(
      422,
      "oauth_resource_invalid",
      "The MCP endpoint must be an exact HTTPS Streamable HTTP URL."
    );
  }
  if (error.code === "PROFILE_ALREADY_EXISTS") {
    return new ConsoleHttpError(422, "profile_already_exists", "That account profile already exists.");
  }
  if (error.code === "PROVIDER_ACCOUNT_ADDITION_UNSUPPORTED") {
    return new ConsoleHttpError(
      422,
      "provider_account_addition_unsupported",
      "This configuration does not support reviewed provider-owned account addition."
    );
  }
  if (error.code === "PROVIDER_ACCOUNT_INPUT_INVALID") {
    return new ConsoleHttpError(
      422,
      "provider_account_input_invalid",
      "Choose an absolute literal credential-file path."
    );
  }
  if (error.code === "ENVIRONMENT_PROFILE_ADDITION_UNSUPPORTED") {
    return new ConsoleHttpError(
      422,
      "environment_profile_addition_unsupported",
      "This configuration does not have one simple local environment credential binding to copy safely."
    );
  }
  if (error.code === "ENVIRONMENT_PROFILE_INPUT_INVALID") {
    return new ConsoleHttpError(
      422,
      "environment_profile_input_invalid",
      "Choose a safe profile name and an environment variable name, not a credential value."
    );
  }
  if (error.code === "PROFILE_DESCRIPTION_INPUT_INVALID") {
    return new ConsoleHttpError(
      422,
      "profile_description_input_invalid",
      "Choose a trimmed non-secret profile description or explicitly clear it."
    );
  }
  if (error.code === "PROFILE_REMOVAL_INPUT_INVALID") {
    return new ConsoleHttpError(422, "profile_removal_input_invalid", "Choose an existing configured account.");
  }
  if (error.code === "PROFILE_RENAME_INPUT_INVALID") {
    return new ConsoleHttpError(422, "profile_rename_input_invalid", "Choose a distinct safe account name.");
  }
  if (error.code === "PROFILE_LAST_PROFILE") {
    return new ConsoleHttpError(422, "profile_last_profile", "At least one configured account must remain.");
  }
  if (error.code === "PROFILE_REPLACEMENT_REQUIRED") {
    return new ConsoleHttpError(
      422,
      "profile_replacement_required",
      "Choose a different configured account to receive the durable references."
    );
  }
  if (error.code === "PROFILE_REPLACEMENT_INVALID") {
    return new ConsoleHttpError(
      422,
      "profile_replacement_invalid",
      "Choose a different existing configured account as the replacement."
    );
  }
  if (error.code === "PROFILE_REMOVAL_OAUTH_CONNECTION") {
    return new ConsoleHttpError(
      422,
      "profile_removal_oauth_connection",
      "This account has a native OAuth binding. Miftah refuses to split configuration removal from OS-vault cleanup."
    );
  }
  if (error.code === "PROFILE_RENAME_OAUTH_CONNECTION") {
    return new ConsoleHttpError(
      422,
      "profile_rename_oauth_connection",
      "This account has a native OAuth binding. Miftah refuses to split the rename from OS-vault credential migration."
    );
  }
  if (error.code === "PROFILE_SELECTION_STALE") {
    return new ConsoleHttpError(
      409,
      "profile_selection_stale",
      "The configuration changed during recovery; reload it before retrying."
    );
  }
  if (error.code === "OAUTH_PROFILE_RENAME_RECOVERY_REQUIRED") {
    return new ConsoleHttpError(
      409,
      "oauth_profile_rename_recovery_required",
      "Miftah must complete a prior local OAuth profile-rename recovery before retrying."
    );
  }
  if (
    error.code.startsWith("CONFIG_") ||
    error.code.startsWith("OAUTH_CONNECTION_") ||
    error.code === "DEFAULT_PROFILE_NOT_FOUND" ||
    error.code === "PROFILE_NOT_FOUND" ||
    error.code === "UPSTREAM_NOT_FOUND"
  ) {
    return new ConsoleHttpError(422, error.code.toLowerCase(), "The requested change is not valid.");
  }
  return new ConsoleHttpError(502, error.code.toLowerCase(), "The requested operation could not be completed.");
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentType = singleHeader(request, "content-type");
  if (
    contentType === undefined ||
    contentType === null ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new ConsoleHttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const length = singleHeader(request, "content-length");
  if (length === null || (length !== undefined && !/^\d+$/u.test(length))) {
    throw new ConsoleHttpError(400, "invalid_request", "The request is invalid.");
  }
  if (length !== undefined && Number(length) > maximumBytes) {
    throw new ConsoleHttpError(413, "payload_too_large", "The request body is too large.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximumBytes) {
        request.resume();
        throw new ConsoleHttpError(413, "payload_too_large", "The request body is too large.");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof ConsoleHttpError) throw error;
    throw new ConsoleHttpError(400, "invalid_request", "The request is invalid.");
  }
  if (size === 0) throw new ConsoleHttpError(400, "invalid_json", "A JSON body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ConsoleHttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const cookie = singleHeader(request, "cookie");
  if (cookie === undefined || cookie === null || cookie.length > 4_096) return undefined;
  const matches = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{32,}$/u.test(value) ? value : undefined;
}

function closeListener(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

class LocalConsoleServer implements ConsoleServer {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly sockets = new Set<Socket>();
  private bootstrap: string;
  private bootstrapIssuedAt: number;
  private bootstrapUsed = false;
  private rateWindowStartedAt: number;
  private requestCount = 0;
  private bootstrapAttemptCount = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    readonly url: URL,
    readonly bootstrapCredential: string,
    private readonly listener: Server,
    private readonly application: ConsoleControlApplication,
    private readonly options: ResolvedConsoleServerOptions
  ) {
    this.bootstrap = bootstrapCredential;
    this.bootstrapIssuedAt = options.now();
    this.rateWindowStartedAt = options.now();
    listener.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      await this.route(request, response);
    } catch (error) {
      writeError(
        response,
        error instanceof ConsoleHttpError
          ? error
          : new ConsoleHttpError(500, "internal_error", "The Console request failed.")
      );
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed) throw new ConsoleHttpError(503, "service_unavailable", "The Console is shutting down.");
    const asset = request.url === undefined ? undefined : consoleAsset(request.url);
    if (asset !== undefined) {
      this.requireTrustedNavigation(request);
      this.admitRequest(false);
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "GET, HEAD" });
      }
      writeAsset(response, request.method, asset);
      return;
    }
    this.requireTrustedBrowser(request);
    this.admitRequest(request.url === "/api/v1/sessions");

    if (request.url === "/api/v1/sessions") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      await this.bootstrapSession(request, response);
      return;
    }

    const session = this.requireSession(request);
    if (request.url === "/api/v1/health") {
      if (request.method !== "GET") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "GET" });
      }
      try {
        writeJson(response, 200, { data: await this.application.health() });
      } catch (error) {
        throw publicApplicationError(error);
      }
      session.lastUsedAt = this.options.now();
      return;
    }
    if (request.url === "/api/v1/config" || request.url === "/api/v1/profiles") {
      if (request.method !== "GET") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "GET" });
      }
      try {
        const metadata = await this.application.configMetadata();
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, {
          data: request.url.endsWith("/profiles")
            ? metadata.initialized
              ? metadata.profiles
              : []
            : metadata
        });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/setup-draft") {
      if (request.method === "GET") {
        if (this.application.loadSetupDraft === undefined) {
          throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
        }
        try {
          const draft = await this.application.loadSetupDraft();
          session.lastUsedAt = this.options.now();
          writeJson(response, 200, { data: draft ?? null });
        } catch (error) {
          throw publicApplicationError(error);
        }
        return;
      }
      if (request.method === "PUT") {
        this.requireCsrf(request, session);
        const parsed = setupDraftSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
        if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
        if (this.application.saveSetupDraft === undefined) {
          throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
        }
        try {
          const draft = await this.application.saveSetupDraft({
            source: parsed.data.source,
            name: parsed.data.name,
            preset: parsed.data.preset,
            stage: parsed.data.stage
          }, parsed.data.expectedRevision);
          session.lastUsedAt = this.options.now();
          writeJson(response, 200, { data: draft });
        } catch (error) {
          throw publicApplicationError(error);
        }
        return;
      }
      if (request.method === "DELETE") {
        this.requireCsrf(request, session);
        const parsed = setupDraftDiscardSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
        if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
        if (this.application.discardSetupDraft === undefined) {
          throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
        }
        try {
          await this.application.discardSetupDraft(parsed.data.revision);
          session.lastUsedAt = this.options.now();
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        } catch (error) {
          throw publicApplicationError(error);
        }
        return;
      }
      throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "GET, PUT, DELETE" });
    }
    if (request.url === "/api/v1/configurations") {
      if (request.method !== "GET") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "GET" });
      }
      try {
        const metadata = await this.application.configMetadata();
        if (metadata.catalog === undefined) {
          throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
        }
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: metadata.catalog });
      } catch (error) {
        if (error instanceof ConsoleHttpError) throw error;
        throw publicApplicationError(error);
      }
      return;
    }
    const configurationSelection = /^\/api\/v1\/configurations\/([A-Za-z0-9_-]{16,128})\/select$/u.exec(request.url ?? "");
    if (configurationSelection !== null) {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = bootstrapSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.selectConfiguration === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const metadata = await this.application.selectConfiguration(configurationSelection[1]!);
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: metadata });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/onboarding/native-oauth/discover") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = discoveredNativeOAuthOnboardingSchema.safeParse(
        await readJsonBody(request, this.options.maximumRequestBytes)
      );
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.onboardDiscoveredNativeOAuth === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.onboardDiscoveredNativeOAuth(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 201, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/onboarding/native-oauth") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = nativeOAuthOnboardingSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      try {
        const result = await this.application.onboardNativeOAuth(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 201, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/onboarding/preset/preview") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = presetOnboardingSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.previewPreset === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.previewPreset(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/onboarding/preset") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = presetOnboardingSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.onboardPreset === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.onboardPreset(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 201, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/onboarding/client-entry") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = clientEntryOnboardingSchema.safeParse(await readJsonBody(request, this.options.maximumClientEntryOnboardingRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.onboardClientEntry === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.onboardClientEntry(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 201, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url?.startsWith("/api/v1/client-snippets")) {
      if (request.method !== "GET") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "GET" });
      }
      let url: URL;
      try {
        url = new URL(request.url, this.url);
      } catch {
        throw new ConsoleHttpError(400, "invalid_request", "The request URL is invalid.");
      }
      if (url.pathname !== "/api/v1/client-snippets" || [...url.searchParams.keys()].some((key) => key !== "client")) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      const client = url.searchParams.get("client") ?? "all";
      if (client !== "all" && !(CLIENT_NAMES as readonly string[]).includes(client)) {
        throw new ConsoleHttpError(422, "validation_error", "The requested MCP client is not supported.");
      }
      try {
        const snippets = await this.application.clientSnippets(client as ClientSelection);
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: snippets });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/profile-readiness") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = profileReadinessSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.profileReadiness === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      const controller = new AbortController();
      const abortReadiness = (): void => {
        if (!response.writableEnded) controller.abort();
      };
      request.once("aborted", abortReadiness);
      response.once("close", abortReadiness);
      try {
        const result = await this.application.profileReadiness({ ...parsed.data, signal: controller.signal });
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      } finally {
        request.off("aborted", abortReadiness);
        response.off("close", abortReadiness);
      }
      return;
    }
    if (request.url === "/api/v1/profiles/default") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = defaultProfileChangeSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.setDefaultProfile === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.setDefaultProfile(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/profiles/description") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = profileDescriptionChangeSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.setProfileDescription === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.setProfileDescription(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/profiles/remove") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = profileRemovalSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.removeProfile === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.removeProfile(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/profiles/rename") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = profileRenameSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.renameProfile === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.renameProfile(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/connections") {
      if (request.method === "GET") {
        try {
          const connections = await this.application.listConnections();
          session.lastUsedAt = this.options.now();
          writeJson(response, 200, { data: connections });
        } catch (error) {
          throw publicApplicationError(error);
        }
        return;
      }
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "GET, POST" });
      }
      this.requireCsrf(request, session);
      const parsed = connectionAddSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      try {
        const result = await this.application.addConnection(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 201, { data: result }, { location: `/api/v1/connections/${encodeURIComponent(result.connectionRef)}` });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/profiles/native-oauth/discover") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = discoveredNativeOAuthAccountSchema.safeParse(
        await readJsonBody(request, this.options.maximumRequestBytes)
      );
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.addDiscoveredNativeOAuthAccount === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.addDiscoveredNativeOAuthAccount(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 201, { data: result }, { location: `/api/v1/connections/${encodeURIComponent(result.connectionRef)}` });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/profiles/provider-account") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = providerAccountAdditionSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.addProviderAccount === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.addProviderAccount(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 201, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url === "/api/v1/profiles/environment-account") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = environmentProfileAdditionSchema.safeParse(
        await readJsonBody(request, this.options.maximumRequestBytes)
      );
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.addEnvironmentProfile === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.addEnvironmentProfile(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 201, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    // This exact route must precede the broad /connections/:reference status route below.
    if (request.url === "/api/v1/connections/discover") {
      if (request.method !== "POST") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "POST" });
      }
      this.requireCsrf(request, session);
      const parsed = discoveredNativeOAuthConnectionSchema.safeParse(
        await readJsonBody(request, this.options.maximumRequestBytes)
      );
      if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      if (this.application.addDiscoveredNativeOAuthConnection === undefined) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      try {
        const result = await this.application.addDiscoveredNativeOAuthConnection(parsed.data);
        session.lastUsedAt = this.options.now();
        writeJson(response, 201, { data: result }, { location: `/api/v1/connections/${encodeURIComponent(result.connectionRef)}` });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    const connectionStatus = /^\/api\/v1\/connections\/([^/]+)$/u.exec(request.url ?? "");
    if (connectionStatus !== null) {
      if (request.method !== "GET") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "GET" });
      }
      const connectionRef = this.decodeConnectionReference(connectionStatus[1]!);
      try {
        const result = await this.application.connectionStatus(connectionRef);
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    const connectionAction = /^\/api\/v1\/connections\/([^/]+)\/(connect|reauth|test|credential)$/u.exec(request.url ?? "");
    if (connectionAction !== null) {
      const action = connectionAction[2] as "connect" | "reauth" | "test" | "credential";
      const requiredMethod = action === "credential" ? "DELETE" : "POST";
      if (request.method !== requiredMethod) {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: requiredMethod });
      }
      this.requireCsrf(request, session);
      const parsedBody = bootstrapSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
      if (!parsedBody.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
      const connectionRef = this.decodeConnectionReference(connectionAction[1]!);
      try {
        const result = action === "connect"
          ? await this.application.connect(connectionRef)
          : action === "reauth"
            ? await this.application.reauth(connectionRef)
            : action === "test"
              ? await this.application.testConnection(connectionRef)
              : await this.application.disconnect(connectionRef);
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: result });
      } catch (error) {
        throw publicApplicationError(error);
      }
      return;
    }
    if (request.url?.startsWith("/api/v1/audit")) {
      if (request.method !== "GET") {
        throw new ConsoleHttpError(405, "method_not_allowed", "Method not allowed.", { allow: "GET" });
      }
      let url: URL;
      try {
        url = new URL(request.url, this.url);
      } catch {
        throw new ConsoleHttpError(400, "invalid_request", "The request URL is invalid.");
      }
      if (url.pathname !== "/api/v1/audit" || [...url.searchParams.keys()].some((key) => key !== "limit")) {
        throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
      }
      const rawLimit = url.searchParams.get("limit") ?? "50";
      if (!/^\d{1,3}$/u.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) {
        throw new ConsoleHttpError(422, "validation_error", "The audit limit must be between 1 and 200.");
      }
      try {
        const records = await this.application.auditRecords(Number(rawLimit));
        session.lastUsedAt = this.options.now();
        writeJson(response, 200, { data: records, meta: { limit: Number(rawLimit), returned: records.length } });
      } catch {
        throw new ConsoleHttpError(503, "audit_unavailable", "The Console audit journal is unavailable.");
      }
      return;
    }
    throw new ConsoleHttpError(404, "not_found", "The requested resource does not exist.");
  }

  private requireTrustedBrowser(request: IncomingMessage): void {
    const host = singleHeader(request, "host");
    const origin = singleHeader(request, "origin");
    const readWithoutOrigin = origin === undefined && (request.method === "GET" || request.method === "HEAD");
    if (host !== this.url.host || origin === null || (!readWithoutOrigin && origin !== this.url.origin)) {
      throw new ConsoleHttpError(403, "forbidden", "The request origin is not trusted.");
    }
  }

  private requireTrustedNavigation(request: IncomingMessage): void {
    const host = singleHeader(request, "host");
    const origin = singleHeader(request, "origin");
    if (host !== this.url.host || origin === null || (origin !== undefined && origin !== this.url.origin)) {
      throw new ConsoleHttpError(403, "forbidden", "The request origin is not trusted.");
    }
  }

  private admitRequest(bootstrap: boolean): void {
    const now = this.options.now();
    if (now - this.rateWindowStartedAt >= rateWindowMs) {
      this.rateWindowStartedAt = now;
      this.requestCount = 0;
      this.bootstrapAttemptCount = 0;
    }
    this.requestCount += 1;
    if (bootstrap) this.bootstrapAttemptCount += 1;
    if (
      this.requestCount > this.options.maximumRequestsPerMinute ||
      this.bootstrapAttemptCount > this.options.maximumBootstrapAttemptsPerMinute
    ) {
      const retryAfter = Math.max(1, Math.ceil((this.rateWindowStartedAt + rateWindowMs - now) / 1_000));
      throw new ConsoleHttpError(
        429,
        "rate_limit_exceeded",
        "The local Console request limit was reached.",
        { "retry-after": String(retryAfter) }
      );
    }
  }

  private async bootstrapSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = singleHeader(request, "authorization");
    if (
      this.bootstrapUsed ||
      this.options.now() - this.bootstrapIssuedAt >= this.options.bootstrapTtlMs ||
      authorization === undefined ||
      authorization === null ||
      !authorization.startsWith("Bootstrap ") ||
      !safeEqual(authorization.slice("Bootstrap ".length), this.bootstrap)
    ) {
      throw new ConsoleHttpError(401, "unauthorized", "Console authentication failed.");
    }
    const parsed = bootstrapSchema.safeParse(await readJsonBody(request, this.options.maximumRequestBytes));
    if (!parsed.success) throw new ConsoleHttpError(422, "validation_error", "The request body is invalid.");
    this.pruneExpiredSessions();
    if (this.sessions.size >= this.options.maximumSessions) {
      throw new ConsoleHttpError(429, "session_limit_exceeded", "The Console session limit was reached.");
    }

    this.bootstrapUsed = true;
    const now = this.options.now();
    const session: BrowserSession = {
      id: randomCredential(),
      csrfToken: randomCredential(),
      createdAt: now,
      lastUsedAt: now
    };
    this.sessions.set(session.id, session);
    writeJson(
      response,
      201,
      { data: { csrfToken: session.csrfToken, expiresInMs: this.options.absoluteSessionMs } },
      {
        "set-cookie": `${sessionCookieName}=${session.id}; HttpOnly; SameSite=Strict; Path=/api/v1`,
        location: "/api/v1/health"
      }
    );
  }

  private requireSession(request: IncomingMessage): BrowserSession {
    this.pruneExpiredSessions();
    const id = cookieValue(request, sessionCookieName);
    const session = id === undefined ? undefined : this.sessions.get(id);
    if (session === undefined) {
      throw new ConsoleHttpError(401, "unauthorized", "A valid Console session is required.");
    }
    return session;
  }

  private requireCsrf(request: IncomingMessage, session: BrowserSession): void {
    const token = singleHeader(request, "x-miftah-csrf");
    if (token === undefined || token === null || !safeEqual(token, session.csrfToken)) {
      throw new ConsoleHttpError(403, "csrf_invalid", "A valid CSRF proof is required.");
    }
  }

  private decodeConnectionReference(segment: string): string {
    let connectionRef: string;
    try {
      connectionRef = decodeURIComponent(segment);
    } catch {
      throw new ConsoleHttpError(400, "invalid_request", "The connection reference is invalid.");
    }
    if (connectionRef.length === 0 || connectionRef.length > 512 || connectionRef.includes("/")) {
      throw new ConsoleHttpError(422, "validation_error", "The connection reference is invalid.");
    }
    return connectionRef;
  }

  private pruneExpiredSessions(): void {
    const now = this.options.now();
    for (const [id, session] of this.sessions) {
      if (
        now - session.lastUsedAt >= this.options.idleSessionMs ||
        now - session.createdAt >= this.options.absoluteSessionMs
      ) {
        this.sessions.delete(id);
      }
    }
  }

  rotateCredential(): string {
    this.sessions.clear();
    this.bootstrap = randomCredential();
    this.bootstrapIssuedAt = this.options.now();
    this.bootstrapUsed = false;
    return this.bootstrap;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.sessions.clear();
    this.bootstrap = "";
    this.closePromise = (async () => {
      const closing = closeListener(this.listener);
      for (const socket of this.sockets) socket.destroy();
      await closing;
    })();
    return this.closePromise;
  }
}

/** Starts the separate Console control plane only when explicitly called. */
export async function startConsoleServer(
  configPath: string,
  options: ConsoleServerOptions = {}
): Promise<ConsoleServer> {
  if (options.deferConfigValidation !== true) {
    try {
      await loadConfig(configPath);
    } catch (error) {
      if (!(options.allowMissingConfig === true && error instanceof MiftahError && error.code === "CONFIG_NOT_FOUND")) {
        throw error;
      }
    }
  } else if (options.application === undefined) {
    throw new Error("Unable to start the Miftah Console server.");
  }
  const bootstrapCredential = options.bootstrapCredential ?? randomCredential();
  if (bootstrapCredential.length < 16 || bootstrapCredential.length > 4_096) {
    throw new Error("Unable to start the Miftah Console server.");
  }
  const listener = createServer({
    requestTimeout: requestTimeoutMs,
    headersTimeout: headersTimeoutMs,
    connectionsCheckingInterval: connectionsCheckingIntervalMs,
    maxHeaderSize: maximumHeaderBytes
  });
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      listener.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      listener.off("error", onError);
      resolve();
    };
    listener.once("error", onError);
    listener.once("listening", onListening);
    listener.listen(port, loopbackHost);
  }).catch((error: unknown) => {
    throw new Error("Unable to start the Miftah Console server.", { cause: error });
  });
  const address = listener.address();
  if (address === null || typeof address === "string" || address.address !== loopbackHost) {
    await closeListener(listener).catch(() => undefined);
    throw new Error("Unable to start the Miftah Console server.");
  }
  const url = new URL(`http://${loopbackHost}:${address.port}/`);
  const maximumRequestBytes = options.maximumRequestBytes ?? defaultMaximumRequestBytes;
  const maximumClientEntryOnboardingBytes = options.maximumRequestBytes === undefined
    ? maximumClientEntryOnboardingRequestBytes
    : Math.min(maximumRequestBytes, maximumClientEntryOnboardingRequestBytes);
  const server = new LocalConsoleServer(
    url,
    bootstrapCredential,
    listener,
    options.application ?? new ConsoleApplicationService(configPath, {
      ...(options.launcher === undefined ? {} : { launcher: options.launcher })
    }),
    {
      maximumRequestBytes,
      maximumClientEntryOnboardingRequestBytes: maximumClientEntryOnboardingBytes,
      maximumSessions: options.maximumSessions ?? defaultMaximumSessions,
      bootstrapTtlMs: options.bootstrapTtlMs ?? defaultBootstrapTtlMs,
      maximumRequestsPerMinute: options.maximumRequestsPerMinute ?? defaultMaximumRequestsPerMinute,
      maximumBootstrapAttemptsPerMinute:
        options.maximumBootstrapAttemptsPerMinute ?? defaultMaximumBootstrapAttemptsPerMinute,
      idleSessionMs: options.idleSessionMs ?? defaultIdleSessionMs,
      absoluteSessionMs: options.absoluteSessionMs ?? defaultAbsoluteSessionMs,
      now: options.now ?? Date.now
    }
  );
  listener.on("request", (request, response) => void server.handle(request, response));
  return server;
}
