import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { resolveExecutablePath } from "../secrets/executable-resolver.js";
import { MiftahError } from "../utils/errors.js";
import type { OAuthAuthorizationHandoff } from "./remote-oauth-client-provider.js";

const callbackPath = "/oauth/callback";
const defaultTimeoutMs = 5 * 60_000;
const maximumTimeoutMs = 10 * 60_000;
const maximumRequestTargetBytes = 8 * 1_024;
const successPage = "<!doctype html><meta charset=utf-8><title>Miftah authorization complete</title><p>Authorization complete. You can close this window.</p>";
const failurePage = "<!doctype html><meta charset=utf-8><title>Miftah authorization failed</title><p>Authorization could not be completed. Return to Miftah and try again.</p>";

export interface LoopbackOAuthAuthorizationHandoffOptions {
  readonly openExternal?: (url: URL) => Promise<void>;
  readonly timeoutMs?: number;
}

interface PendingAuthorization {
  readonly state: string;
  readonly issuer: string;
  readonly resolve: (code: string) => void;
  readonly reject: (error: MiftahError) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

function authorizationFailed(): MiftahError {
  return new MiftahError(
    "OAUTH_AUTHORIZATION_FAILED",
    "OAUTH_AUTHORIZATION_FAILED: OAuth authorization could not be completed"
  );
}

function timeoutValue(value: number | undefined): number {
  const selected = value ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximumTimeoutMs) throw authorizationFailed();
  return selected;
}

function singleParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function rawHeaderValues(request: IncomingMessage, name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? "");
  }
  return values;
}

function exactHost(request: IncomingMessage, expected: string): boolean {
  const hosts = rawHeaderValues(request, "host");
  return hosts.length === 1 && hosts[0] === expected;
}

function fixedPage(response: ServerResponse, status: number, page: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  });
  response.end(page);
}

class LoopbackOAuthAuthorizationHandoff implements OAuthAuthorizationHandoff {
  private pending?: PendingAuthorization;
  private used = false;
  private closed = false;

  constructor(
    private readonly server: Server,
    readonly redirectUrl: URL,
    private readonly openExternal: (url: URL) => Promise<void>,
    private readonly timeoutMs: number
  ) {}

  authorize(
    authorizationUrl: URL,
    expected: { readonly state: string; readonly issuer: string }
  ): Promise<string> {
    if (this.closed || this.used || this.pending !== undefined || authorizationUrl.protocol !== "https:") {
      return Promise.reject(authorizationFailed());
    }
    this.used = true;
    const authorization = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending?.timeout !== timeout) return;
        this.pending = undefined;
        reject(authorizationFailed());
        void this.closeServer();
      }, this.timeoutMs);
      this.pending = {
        state: expected.state,
        issuer: expected.issuer,
        resolve,
        reject,
        timeout
      };
    });
    void this.openExternal(new URL(authorizationUrl)).catch(() => {
      this.rejectPending();
    });
    return authorization;
  }

  handle(request: IncomingMessage, response: ServerResponse): void {
    const target = request.url ?? "";
    if (
      this.closed ||
      this.pending === undefined ||
      request.method !== "GET" ||
      Buffer.byteLength(target, "utf8") > maximumRequestTargetBytes ||
      !exactHost(request, this.redirectUrl.host) ||
      rawHeaderValues(request, "origin").length > 0
    ) {
      fixedPage(response, 400, failurePage);
      return;
    }

    let callback: URL;
    try {
      callback = new URL(target, this.redirectUrl);
    } catch {
      fixedPage(response, 400, failurePage);
      return;
    }
    if (callback.pathname !== callbackPath || callback.hash.length > 0) {
      fixedPage(response, 400, failurePage);
      return;
    }

    const state = singleParameter(callback, "state");
    const issuer = singleParameter(callback, "iss");
    const code = singleParameter(callback, "code");
    const providerError = singleParameter(callback, "error");
    if (state !== this.pending.state || issuer !== this.pending.issuer) {
      fixedPage(response, 400, failurePage);
      return;
    }
    if (providerError !== undefined || code === undefined || code.length === 0 || code.length > 4_096) {
      fixedPage(response, 400, failurePage);
      this.rejectPending();
      return;
    }

    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timeout);
    fixedPage(response, 200, successPage);
    pending.resolve(code);
    setImmediate(() => void this.closeServer());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.rejectPending();
    await this.closeServer();
  }

  private rejectPending(): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    clearTimeout(pending.timeout);
    pending.reject(authorizationFailed());
    void this.closeServer();
  }

  private async closeServer(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

/** Starts a single-use literal-loopback callback before an authorization URL is opened. */
export async function createLoopbackOAuthAuthorizationHandoff(
  options: LoopbackOAuthAuthorizationHandoffOptions = {}
): Promise<OAuthAuthorizationHandoff> {
  const timeoutMs = timeoutValue(options.timeoutMs);
  const owner: { handoff?: LoopbackOAuthAuthorizationHandoff } = {};
  const server = createServer({ maxHeaderSize: maximumRequestTargetBytes }, (request, response) => {
    owner.handoff?.handle(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      resolve();
    });
  }).catch(() => {
    throw authorizationFailed();
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw authorizationFailed();
  }
  const redirectUrl = new URL(`http://127.0.0.1:${address.port}${callbackPath}`);
  const handoff = new LoopbackOAuthAuthorizationHandoff(
    server,
    redirectUrl,
    options.openExternal ?? openSystemBrowser,
    timeoutMs
  );
  owner.handoff = handoff;
  return handoff;
}

/** Opens the system browser without invoking a command shell or logging the authorization URL. */
export async function openSystemBrowser(url: URL): Promise<void> {
  let executable: string | undefined;
  let arguments_: string[];
  if (process.platform === "darwin") {
    executable = "/usr/bin/open";
    arguments_ = [url.toString()];
  } else if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    if (!win32.isAbsolute(root)) throw authorizationFailed();
    executable = win32.join(win32.resolve(root), "System32", "rundll32.exe");
    try {
      await access(executable, constants.X_OK);
    } catch {
      throw authorizationFailed();
    }
    arguments_ = ["url.dll,FileProtocolHandler", url.toString()];
  } else {
    executable = await resolveExecutablePath("xdg-open");
    arguments_ = [url.toString()];
  }
  if (executable === undefined) throw authorizationFailed();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", () => reject(authorizationFailed()));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
