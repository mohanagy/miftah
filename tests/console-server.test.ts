import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startConsoleServer,
  type ConsoleControlApplication
} from "../src/console/console-server.js";
import { MiftahError } from "../src/utils/errors.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-console-server-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "miftah.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "1",
      name: "console-test",
      defaultProfile: "personal",
      upstream: { transport: "stdio", command: process.execPath, args: ["provider.mjs"] },
      profiles: { personal: { description: "Personal account" }, work: {} }
    })
  );
  return path;
}

async function writeOAuthConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-console-oauth-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "miftah.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "2",
      name: "console-oauth-test",
      defaultProfile: "personal",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { personal: { description: "Personal account" }, work: {} }
    }, null, 2)
  );
  return path;
}

async function rawPost(
  url: URL,
  headers: Readonly<Record<string, string>>,
  body: string
): Promise<{ readonly status: number; readonly body: string; readonly headers: NodeJS.Dict<string | string[]> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers
        }));
      }
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function bootstrapSession(server: Awaited<ReturnType<typeof startConsoleServer>>): Promise<{
  readonly cookie: string;
  readonly csrfToken: string;
}> {
  const response = await fetch(new URL("/api/v1/sessions", server.url), {
    method: "POST",
    headers: {
      origin: server.url.origin,
      authorization: `Bootstrap ${server.bootstrapCredential}`,
      "content-type": "application/json"
    },
    body: "{}"
  });
  expect(response.status).toBe(201);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const body = await response.json() as { readonly data: { readonly csrfToken: string } };
  if (cookie === undefined) throw new Error("Expected a Console session cookie.");
  return { cookie, csrfToken: body.data.csrfToken };
}

describe("local Console control server", () => {
  it("serves a navigation-safe local dashboard shell without exposing bootstrap credentials", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("content-security-policy")).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
        "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      );
      const html = await page.text();
      expect(html).toContain("Miftah Console");
      expect(html).toContain('src="/app.js"');
      expect(html).toContain('href="/app.css"');
      expect(html).toContain("Remote native OAuth");
      expect(html).toContain("Provider adapter");
      expect(html).toContain("Upstream-owned auth");
      expect(html).toContain("Unsupported state");
      expect(html).toContain("Active vs durable:");
      expect(html).not.toContain("test-only-bootstrap-credential");
      expect(html).not.toContain("localStorage");

      const script = await fetch(new URL("/app.js", server.url));
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      const javascript = await script.text();
      expect(javascript).toContain("/api/v1/sessions");
      expect(javascript).toContain("/api/v1/onboarding/native-oauth");
      expect(javascript).toContain("/api/v1/client-snippets");
      expect(javascript).toContain('action === "credential" ? "DELETE" : "POST"');
      expect(javascript).toContain("statusErrorCode");
      expect(javascript).toContain("restoreUnlock");
      expect(javascript).not.toMatch(/innerHTML|localStorage|sessionStorage|\beval\s*\(/u);

      const stylesheet = await fetch(new URL("/app.css", server.url));
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(await stylesheet.text()).toContain("prefers-reduced-motion");

      const hostileHost = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: server.url.hostname,
            port: server.url.port,
            path: "/",
            method: "GET",
            headers: { host: "attacker.example.test" }
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          }
        );
        request.once("error", reject);
        request.end();
      });
      expect(hostileHost).toBe(403);

      const mutation = await fetch(server.url, { method: "POST" });
      expect(mutation.status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("supports a CSRF-protected first-run native OAuth setup and copy-only client snippets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const server = await startConsoleServer(configPath, {
      bootstrapCredential: "test-only-bootstrap-credential",
      allowMissingConfig: true,
      launcher: { command: process.execPath, args: [join(process.cwd(), "dist", "cli", "main.js"), "serve"] }
    });

    try {
      const session = await bootstrapSession(server);
      const metadata = await fetch(new URL("/api/v1/config", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toEqual({
        data: { initialized: false, restartRequiredForExistingClients: true }
      });

      const endpoint = new URL("/api/v1/onboarding/native-oauth", server.url);
      const request = {
        name: "posthog-work",
        profile: "production",
        description: "Production account",
        resource: "https://mcp.example.test/mcp",
        issuer: "https://auth.example.test",
        clientRegistration: "dynamic",
        scopes: ["openid", "analytics:read"]
      };
      const missingCsrf = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(missingCsrf.status).toBe(403);
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const secretBearing = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ...request, accessToken: "must-not-be-accepted" })
      });
      expect(secretBearing.status).toBe(422);
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const created = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        data: { profile: "production", upstream: "default", resource: "https://mcp.example.test/mcp" }
      });

      const snippets = await fetch(new URL("/api/v1/client-snippets?client=claude-desktop", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(snippets.status).toBe(200);
      const snippetBody = await snippets.json() as {
        data: Array<{ client: string; json: string }>;
      };
      expect(snippetBody).toMatchObject({ data: [{ client: "claude-desktop" }] });
      const snippetConfig = JSON.parse(snippetBody.data[0]?.json ?? "") as {
        mcpServers: Record<string, { args: string[] }>;
      };
      expect(snippetConfig.mcpServers["posthog-work"]?.args).toContain(configPath);
      expect(JSON.stringify(snippetBody)).not.toContain("auth.example.test");
    } finally {
      await server.close();
    }
  });

  it("reports an unavailable local client launcher as a stable service-availability error", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const session = await bootstrapSession(server);
      const response = await fetch(new URL("/api/v1/client-snippets?client=claude-desktop", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "console_launcher_unavailable",
          message: "Client snippets are unavailable because the Console launcher is not configured."
        }
      });
    } finally {
      await server.close();
    }
  });

  it("requires an invocation-bound bootstrap before returning redacted control metadata", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      expect(server.url.hostname).toBe("127.0.0.1");
      expect(server.url.pathname).toBe("/");

      const unauthenticated = await fetch(new URL("/api/v1/health", server.url), {
        headers: { origin: server.url.origin }
      });
      expect(unauthenticated.status).toBe(401);

      const missingOrigin = await fetch(new URL("/api/v1/health", server.url));
      expect(missingOrigin.status).toBe(401);

      const bootstrapUrl = new URL("/api/v1/sessions", server.url);
      const hostileHost = await rawPost(
        bootstrapUrl,
        {
          host: "attacker.example.test",
          origin: server.url.origin,
          authorization: "Bootstrap test-only-bootstrap-credential",
          "content-type": "application/json"
        },
        "{}"
      );
      expect(hostileHost.status).toBe(403);

      const hostileOrigin = await fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          origin: "https://attacker.example.test",
          authorization: "Bootstrap test-only-bootstrap-credential",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(hostileOrigin.status).toBe(403);

      const mcpBearer = await fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          authorization: "Bearer test-only-bootstrap-credential",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(mcpBearer.status).toBe(401);

      const bootstrap = await fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          authorization: "Bootstrap test-only-bootstrap-credential",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(bootstrap.status).toBe(201);
      const cookie = bootstrap.headers.get("set-cookie");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      const bootstrapBody = await bootstrap.json() as { readonly data: { readonly csrfToken: string } };
      expect(bootstrapBody.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
      expect(JSON.stringify(bootstrapBody)).not.toContain("test-only-bootstrap-credential");
      expect(bootstrap.headers.get("x-frame-options")).toBe("DENY");

      const health = await fetch(new URL("/api/v1/health", server.url), {
        headers: { cookie: cookie!.split(";", 1)[0]! }
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        data: {
          status: "ok",
          config: { name: "console-test", version: "1" },
          audit: { enabled: true, state: "healthy" },
          restartRequiredForExistingClients: true
        }
      });
    } finally {
      await server.close();
    }
  });

  it("requires CSRF proof and schema validation before an atomic audited connection mutation", async () => {
    const configPath = await writeOAuthConfig();
    const server = await startConsoleServer(configPath, { bootstrapCredential: "test-only-bootstrap-credential" });
    const connectionRef = "oauthconn:31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c";

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/connections", server.url);
      const request = {
        connectionRef,
        profile: "personal",
        upstream: "default",
        issuer: "https://auth.example.test",
        clientRegistration: "dynamic",
        scopes: ["read"]
      };
      const missingCsrf = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(missingCsrf.status).toBe(403);
      expect(await readFile(configPath, "utf8")).not.toContain(connectionRef);

      const invalid = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ...request, scopes: "read", unexpected: true })
      });
      expect(invalid.status).toBe(422);
      expect(await readFile(configPath, "utf8")).not.toContain(connectionRef);

      const created = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json();
      expect(createdBody).toMatchObject({
        data: { changed: true, write: true, connectionRef }
      });
      expect(JSON.stringify(createdBody)).not.toContain(configPath);
      expect(JSON.stringify(createdBody)).not.toContain("miftah-backup");
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        oauth: { connections: { [connectionRef]: { profile: "personal", scopes: ["read"] } } }
      });

      const audit = await fetch(new URL("/api/v1/audit?limit=10", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(audit.status).toBe(200);
      const auditBody = await audit.json() as { readonly data: readonly Record<string, unknown>[] };
      expect(auditBody.data).toContainEqual(expect.objectContaining({
        operation: "console/oauth-connection-add",
        status: "success",
        profile: "personal",
        upstream: "default"
      }));
      expect(JSON.stringify(auditBody)).not.toContain("dynamic");
      expect(JSON.stringify(auditBody)).not.toContain("auth.example.test");

      const metadata = await fetch(new URL("/api/v1/config", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({
        data: {
          name: "console-oauth-test",
          version: "3",
          defaultProfile: "personal",
          profiles: [
            { name: "personal", description: "Personal account" },
            { name: "work" }
          ],
          upstreams: [{ name: "default", transport: "streamable-http" }],
          restartRequiredForExistingClients: true
        }
      });

      const profiles = await fetch(new URL("/api/v1/profiles", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(profiles.status).toBe(200);
      expect(await profiles.json()).toMatchObject({ data: [{ name: "personal" }, { name: "work" }] });

      const connections = await fetch(new URL("/api/v1/connections", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(connections.status).toBe(200);
      const connectionsBody = await connections.json() as { readonly data: unknown };
      expect(connectionsBody.data).toEqual([
        expect.objectContaining({ connectionRef, profile: "personal", upstream: "default" })
      ]);
      expect(JSON.stringify(connectionsBody)).not.toContain("accessToken");
      expect(JSON.stringify(connectionsBody)).not.toContain("refreshToken");

      const mcpRoute = await fetch(new URL("/mcp", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(mcpRoute.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("audits exact connection lifecycle mutations only after CSRF validation", async () => {
    const calls: string[] = [];
    const application: ConsoleControlApplication = {
      health: async () => ({
        status: "ok",
        config: { name: "console-test", version: "1" },
        audit: { enabled: true, state: "healthy" },
        restartRequiredForExistingClients: true
      }),
      configMetadata: async () => ({
        initialized: true,
        name: "console-test",
        version: "1",
        defaultProfile: "personal",
        profiles: [],
        upstreams: [],
        oauthConnectionCount: 0,
        restartRequiredForExistingClients: true
      }),
      listConnections: async () => [],
      onboardNativeOAuth: async () => {
        throw new MiftahError("CONFIG_CREATE_FAILED", "CONFIG_CREATE_FAILED: test fixture");
      },
      clientSnippets: async () => [],
      connectionStatus: async (connectionRef) => ({ connectionRef, credentialState: "missing" }),
      addConnection: async () => { throw new Error("not used"); },
      connect: async (connectionRef) => {
        calls.push(`connect:${connectionRef}`);
        return { ok: true, connectionRef };
      },
      reauth: async (connectionRef) => {
        calls.push(`reauth:${connectionRef}`);
        return { ok: true, connectionRef };
      },
      disconnect: async (connectionRef) => {
        calls.push(`disconnect:${connectionRef}`);
        return { connectionRef, credentialState: "missing" };
      },
      testConnection: async (connectionRef) => {
        calls.push(`test:${connectionRef}`);
        return { ok: true, connectionRef };
      },
      auditRecords: async () => []
    };
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential",
      application
    });

    try {
      const session = await bootstrapSession(server);
      const createFailure = await fetch(new URL("/api/v1/onboarding/native-oauth", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "service",
          profile: "work",
          resource: "https://mcp.example.test/mcp",
          issuer: "https://auth.example.test",
          clientRegistration: "dynamic",
          scopes: []
        })
      });
      expect(createFailure.status).toBe(503);
      expect(await createFailure.json()).toEqual({
        error: {
          code: "config_create_failed",
          message: "The initial configuration could not be created."
        }
      });

      const reference = "oauthconn:31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c";
      const status = await fetch(
        new URL(`/api/v1/connections/${encodeURIComponent(reference)}`, server.url),
        { headers: { origin: server.url.origin, cookie: session.cookie } }
      );
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ data: { connectionRef: reference, credentialState: "missing" } });
      const connectUrl = new URL(`/api/v1/connections/${encodeURIComponent(reference)}/connect`, server.url);
      const rejected = await fetch(connectUrl, {
        method: "POST",
        headers: { origin: server.url.origin, cookie: session.cookie, "content-type": "application/json" },
        body: "{}"
      });
      expect(rejected.status).toBe(403);
      expect(calls).toEqual([]);

      for (const [action, method] of [
        ["connect", "POST"],
        ["reauth", "POST"],
        ["test", "POST"],
        ["credential", "DELETE"]
      ] as const) {
        const response = await fetch(
          new URL(`/api/v1/connections/${encodeURIComponent(reference)}/${action}`, server.url),
          {
            method,
            headers: {
              origin: server.url.origin,
              cookie: session.cookie,
              "x-miftah-csrf": session.csrfToken,
              "content-type": "application/json"
            },
            body: "{}"
          }
        );
        expect(response.status).toBe(200);
      }
      expect(calls).toEqual([
        `connect:${reference}`,
        `reauth:${reference}`,
        `test:${reference}`,
        `disconnect:${reference}`
      ]);
    } finally {
      await server.close();
    }
  });

  it("bounds requests, expires sessions, rotates local credentials, and shuts down cleanly", async () => {
    let now = 10_000;
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "first-test-bootstrap-credential",
      maximumRequestBytes: 32,
      bootstrapTtlMs: 100,
      idleSessionMs: 100,
      absoluteSessionMs: 1_000,
      now: () => now
    });

    const firstUrl = new URL("/api/v1/sessions", server.url);
    const oversized = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: "Bootstrap first-test-bootstrap-credential",
        "content-type": "application/json"
      },
      body: JSON.stringify({ padding: "x".repeat(64) })
    });
    expect(oversized.status).toBe(413);

    now += 101;
    const staleBootstrap = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: "Bootstrap first-test-bootstrap-credential",
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(staleBootstrap.status).toBe(401);

    const activeBootstrap = server.rotateCredential();
    const activeBootstrapResponse = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: `Bootstrap ${activeBootstrap}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(activeBootstrapResponse.status).toBe(201);
    const activeBody = await activeBootstrapResponse.json() as { readonly data: { readonly csrfToken: string } };
    const activeCookie = activeBootstrapResponse.headers.get("set-cookie")?.split(";", 1)[0];
    if (activeCookie === undefined) throw new Error("Expected an active Console session cookie.");
    const session = { cookie: activeCookie, csrfToken: activeBody.data.csrfToken };
    const replay = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: `Bootstrap ${activeBootstrap}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(replay.status).toBe(401);

    now += 101;
    const expired = await fetch(new URL("/api/v1/health", server.url), {
      headers: { origin: server.url.origin, cookie: session.cookie }
    });
    expect(expired.status).toBe(401);

    const replacement = server.rotateCredential();
    expect(replacement).not.toBe(activeBootstrap);
    const replacementSession = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: `Bootstrap ${replacement}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(replacementSession.status).toBe(201);

    await server.close();
    await expect(fetch(new URL("/api/v1/health", server.url), {
      headers: { origin: server.url.origin }
    })).rejects.toThrow();
  });

  it("rate-limits the local API and applies a stricter bootstrap-attempt budget", async () => {
    let now = 50_000;
    const requestLimited = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "request-rate-bootstrap-credential",
      maximumRequestsPerMinute: 2,
      now: () => now
    });
    try {
      const session = await bootstrapSession(requestLimited);
      const first = await fetch(new URL("/api/v1/health", requestLimited.url), {
        headers: { origin: requestLimited.url.origin, cookie: session.cookie }
      });
      expect(first.status).toBe(200);
      const limited = await fetch(new URL("/api/v1/health", requestLimited.url), {
        headers: { origin: requestLimited.url.origin, cookie: session.cookie }
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
    } finally {
      await requestLimited.close();
    }

    const bootstrapLimited = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "bootstrap-rate-test-credential",
      maximumRequestsPerMinute: 100,
      maximumBootstrapAttemptsPerMinute: 2,
      now: () => now
    });
    try {
      const url = new URL("/api/v1/sessions", bootstrapLimited.url);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const rejected = await fetch(url, {
          method: "POST",
          headers: {
            origin: bootstrapLimited.url.origin,
            authorization: "Bootstrap invalid-bootstrap-credential",
            "content-type": "application/json"
          },
          body: "{}"
        });
        expect(rejected.status).toBe(401);
      }
      const limited = await fetch(url, {
        method: "POST",
        headers: {
          origin: bootstrapLimited.url.origin,
          authorization: "Bootstrap bootstrap-rate-test-credential",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(limited.status).toBe(429);

      now += 60_000;
      const recovered = await fetch(url, {
        method: "POST",
        headers: {
          origin: bootstrapLimited.url.origin,
          authorization: "Bootstrap bootstrap-rate-test-credential",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(recovered.status).toBe(201);
    } finally {
      await bootstrapLimited.close();
    }
  });
});
