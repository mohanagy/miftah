import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { startMiftahHttpServer } from "../src/http/miftah-http-server.js";
import { createHttpSessionRuntime } from "../src/runtime/create-miftah-runtime.js";
import { startFakeRemoteUpstream, type FakeRemoteUpstream } from "./helpers/fake-remote-upstream.js";

const temporaryDirectories: string[] = [];
const remoteUpstreams: FakeRemoteUpstream[] = [];
const fixture = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  await Promise.all(remoteUpstreams.splice(0).map((upstream) => upstream.close()));
});

async function writeHttpConfig(
  options: { maxSessions?: number; sessionIdleTimeoutMs?: number; maxRequestBytes?: number } = {}
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-http-server-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "miftah.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: "1",
      name: "http-server-test",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { default: {}, personal: {} },
      security: { allowProfileSwitchingFromMcp: true },
      state: { persistActiveProfile: true, scope: "workspace" },
      server: {
        http: {
          port: 0,
          maxSessions: options.maxSessions ?? 3,
          sessionIdleTimeoutMs: options.sessionIdleTimeoutMs ?? 1_000,
          maxRequestBytes: options.maxRequestBytes
        }
      }
    })
  );
  return configPath;
}

async function writeRemoteHttpConfig(upstreamUrl: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-http-server-remote-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "miftah.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: "1",
      name: "http-server-remote-test",
      defaultProfile: "default",
      upstream: { transport: "streamable-http", url: upstreamUrl },
      profiles: { default: {} },
      server: { http: { port: 0, maxSessions: 2, sessionIdleTimeoutMs: 1_000 } }
    })
  );
  return configPath;
}

async function writeAuthenticatedHttpConfig(
  token: string,
  options: { host?: string; allowNonLoopback?: true; allowedHosts?: string[] } = {}
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-http-server-auth-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "miftah.json");
  await writeFile(join(directory, ".env"), `MIFTAH_HTTP_TOKEN=${token}\n`);
  await writeFile(
    configPath,
    JSON.stringify({
      version: "1",
      name: "http-server-auth-test",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { default: {} },
      server: { http: { port: 0, authToken: "${MIFTAH_HTTP_TOKEN}", ...options } },
      secrets: { envFiles: [".env"] }
    })
  );
  return configPath;
}

async function writeProcessEnvironmentAuthenticatedHttpConfig(environmentName: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-http-server-process-auth-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "miftah.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: "1",
      name: "http-server-process-auth-test",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { default: {} },
      server: { http: { port: 0, authToken: `\${${environmentName}}` } }
    })
  );
  return configPath;
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

async function postWithHeaders(
  url: URL,
  headers: Record<string, string>,
  body: string,
  path = url.pathname
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path, method: "POST", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function profileName(result: unknown): string {
  const parsed = CallToolResultSchema.parse(result);
  const content = parsed.content[0];
  if (content?.type !== "text") throw new Error("Expected a text tool result.");
  const value: unknown = JSON.parse(content.text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a profile state object.");
  }
  const activeProfile = (value as { activeProfile?: unknown }).activeProfile;
  if (typeof activeProfile !== "string") throw new Error("Expected an active profile.");
  return activeProfile;
}

async function connectClient(url: URL, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

describe("Miftah Streamable HTTP server", () => {
  it("binds the literal loopback default and rejects browser origins before session creation", async () => {
    const server = await startMiftahHttpServer(await writeHttpConfig());

    try {
      expect(server.url.hostname).toBe("127.0.0.1");
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://untrusted.example.test" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden");
    } finally {
      await server.close();
    }
  });

  it("rejects an untrusted Host header before allocating an MCP session", async () => {
    const server = await startMiftahHttpServer(await writeHttpConfig());

    try {
      const response = await postWithHeaders(
        server.url,
        { host: "untrusted.example.test", "content-type": "application/json" },
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      );

      expect(response).toEqual({ status: 403, body: "Forbidden" });
    } finally {
      await server.close();
    }
  });

  it("rejects a path that normalizes to the MCP endpoint", async () => {
    const server = await startMiftahHttpServer(await writeHttpConfig());

    try {
      const response = await postWithHeaders(
        server.url,
        { "content-type": "application/json" },
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        "/other/../mcp"
      );
      expect(response).toEqual({ status: 404, body: "Not Found" });
    } finally {
      await server.close();
    }
  });

  it("bounds oversized JSON requests before they can reserve a session", async () => {
    const server = await startMiftahHttpServer(await writeHttpConfig({ maxSessions: 1, maxRequestBytes: 1_024 }));

    try {
      const rejected = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(1_025)
      });
      expect(rejected.status).toBe(413);
      expect(await rejected.text()).toBe("Payload Too Large");

      const client = await connectClient(server.url, "http-body-limit-client");
      try {
        expect(profileName(await client.callTool({ name: "miftah_current_profile", arguments: {} }))).toBe("default");
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
  });

  it("keeps profile selection isolated across concurrent HTTP client sessions", async () => {
    const server = await startMiftahHttpServer(await writeHttpConfig());
    const first = await connectClient(server.url, "http-first-client");
    const second = await connectClient(server.url, "http-second-client");

    try {
      expect(profileName(await first.callTool({ name: "miftah_current_profile", arguments: {} }))).toBe("default");
      expect(profileName(await second.callTool({ name: "miftah_current_profile", arguments: {} }))).toBe("default");

      await first.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });

      expect(profileName(await first.callTool({ name: "miftah_current_profile", arguments: {} }))).toBe("personal");
      expect(profileName(await second.callTool({ name: "miftah_current_profile", arguments: {} }))).toBe("default");
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await server.close();
    }
  });

  it("reconnects an interrupted SSE stream to the existing session without creating another runtime", async () => {
    const server = await startMiftahHttpServer(await writeHttpConfig({ maxSessions: 1 }));
    let sseRequests = 0;
    const fetchWithInterruptedFirstSse = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await fetch(input, init);
      if (init?.method?.toUpperCase() !== "GET") return response;

      sseRequests += 1;
      if (sseRequests !== 1) return response;

      const source = response.body;
      let interruption: ReturnType<typeof setTimeout> | undefined;
      const interruptedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          interruption = setTimeout(() => {
            controller.close();
            void source?.cancel().then(undefined, () => undefined);
          }, 10);
        },
        cancel() {
          if (interruption !== undefined) clearTimeout(interruption);
          return source?.cancel();
        }
      });
      return new Response(interruptedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    };
    const transport = new StreamableHTTPClientTransport(server.url, {
      fetch: fetchWithInterruptedFirstSse,
      reconnectionOptions: {
        initialReconnectionDelay: 25,
        maxReconnectionDelay: 25,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 2
      }
    });
    const client = new Client({ name: "http-reconnect-client", version: "1.0.0" });

    try {
      await client.connect(transport);
      const sessionId = transport.sessionId;
      expect(sessionId).toBeTypeOf("string");

      expect(await waitFor(() => sseRequests >= 2)).toBe(true);

      expect(profileName(await client.callTool({ name: "miftah_current_profile", arguments: {} }))).toBe("default");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires an exact bearer token without exposing it in HTTP errors", async () => {
    const token = "http-secret-token-not-for-output";
    const environmentName = "MIFTAH_HTTP_SESSION_AUTH_TOKEN";
    const previous = process.env[environmentName];
    process.env[environmentName] = token;
    let server: Awaited<ReturnType<typeof startMiftahHttpServer>> | undefined;

    try {
      server = await startMiftahHttpServer(await writeProcessEnvironmentAuthenticatedHttpConfig(environmentName));
      const rejected = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      });
      const rejectedBody = await rejected.text();
      expect(rejected.status).toBe(401);
      expect(rejectedBody).toBe("Unauthorized");
      expect(rejectedBody).not.toContain(token);

      delete process.env[environmentName];

      const transport = new StreamableHTTPClientTransport(server.url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      });
      const client = new Client({ name: "http-authenticated-client", version: "1.0.0" });
      await client.connect(transport);
      try {
        expect(profileName(await client.callTool({ name: "miftah_current_profile", arguments: {} }))).toBe("default");
      } finally {
        await client.close();
      }
    } finally {
      await server?.close();
      if (previous === undefined) delete process.env[environmentName];
      else process.env[environmentName] = previous;
    }
  });

  it("emits a fixed warning for an explicitly secured non-literal bind", async () => {
    const token = "nonliteral-bind-test-token";
    const warnings: string[] = [];
    const server = await startMiftahHttpServer(
      await writeAuthenticatedHttpConfig(token, {
        host: "0.0.0.0",
        allowNonLoopback: true,
        allowedHosts: ["mcp.example.test"]
      }),
      { onWarning: (message) => warnings.push(message) }
    );

    try {
      expect(server.url.hostname).toBe("0.0.0.0");
      expect(warnings).toEqual([
        "WARNING: Miftah HTTP serving is bound to a non-loopback host with bearer authentication enabled."
      ]);
    } finally {
      await server.close();
    }
  });

  it("expires idle sessions and releases their retained upstream transport", async () => {
    const upstream = await startFakeRemoteUpstream();
    remoteUpstreams.push(upstream);
    const server = await startMiftahHttpServer(await writeRemoteHttpConfig(upstream.streamableHttpUrl));
    const client = await connectClient(server.url, "http-expiry-client");

    try {
      await client.callTool({ name: "whoami", arguments: {} });
      const closedBeforeExpiry = upstream.closedStreamableSessionIds().length;

      expect(await waitFor(() => upstream.closedStreamableSessionIds().length > closedBeforeExpiry)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("stops admissions and closes retained upstream sessions during graceful shutdown", async () => {
    const upstream = await startFakeRemoteUpstream();
    remoteUpstreams.push(upstream);
    const server = await startMiftahHttpServer(await writeRemoteHttpConfig(upstream.streamableHttpUrl));
    const client = await connectClient(server.url, "http-shutdown-client");

    try {
      await client.callTool({ name: "whoami", arguments: {} });
      const closedBeforeShutdown = upstream.closedStreamableSessionIds().length;

      await server.close();

      expect(await waitFor(() => upstream.closedStreamableSessionIds().length > closedBeforeShutdown)).toBe(true);
      await expect(fetch(server.url)).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps capacity reserved until a deleted session runtime has finished closing", async () => {
    let closeStarted = false;
    let closeFinished = false;
    let releaseClose: () => void = () => undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const server = await startMiftahHttpServer(await writeHttpConfig({ maxSessions: 1 }), {
      sessionRuntimeFactory: async (configPath) => {
        const runtime = await createHttpSessionRuntime(configPath);
        return {
          config: runtime.config,
          connect: runtime.connect,
          close: async () => {
            closeStarted = true;
            await closeGate;
            closeFinished = true;
            await runtime.close();
          }
        };
      }
    });
    const firstTransport = new StreamableHTTPClientTransport(server.url);
    const first = new Client({ name: "http-closing-capacity-first", version: "1.0.0" });
    const blockedTransport = new StreamableHTTPClientTransport(server.url);
    const blocked = new Client({ name: "http-closing-capacity-blocked", version: "1.0.0" });
    let retry: Client | undefined;

    try {
      await first.connect(firstTransport);
      await firstTransport.terminateSession();
      expect(await waitFor(() => closeStarted)).toBe(true);
      expect(closeFinished).toBe(false);

      await expect(blocked.connect(blockedTransport)).rejects.toThrow();

      releaseClose();
      expect(await waitFor(() => closeFinished)).toBe(true);
      retry = await connectClient(server.url, "http-closing-capacity-retry");
      expect(profileName(await retry.callTool({ name: "miftah_current_profile", arguments: {} }))).toBe("default");
    } finally {
      releaseClose();
      await Promise.allSettled([first.close(), blocked.close(), retry?.close(), server.close()]);
    }
  });

  it("reports an asynchronous session cleanup failure when the host shuts down", async () => {
    const failures: string[] = [];
    const server = await startMiftahHttpServer(await writeHttpConfig({ maxSessions: 1 }), {
      sessionRuntimeFactory: async (configPath) => {
        const runtime = await createHttpSessionRuntime(configPath);
        return {
          config: runtime.config,
          connect: runtime.connect,
          close: async () => {
            await runtime.close();
            throw new Error("test cleanup failure");
          }
        };
      },
      onBackgroundFailure: (message) => failures.push(message)
    });
    const transport = new StreamableHTTPClientTransport(server.url);
    const client = new Client({ name: "http-cleanup-failure-client", version: "1.0.0" });

    try {
      await client.connect(transport);
      await transport.terminateSession();
      expect(await waitFor(() => failures.length === 1)).toBe(true);
      expect(failures).toEqual(["Miftah HTTP session cleanup failed."]);
      await expect(connectClient(server.url, "http-cleanup-failure-blocked")).rejects.toThrow();

      await expect(server.close()).rejects.toThrow("Miftah HTTP server shutdown failed.");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("reserves capacity during concurrent initialization and releases it after DELETE", async () => {
    const server = await startMiftahHttpServer(await writeHttpConfig({ maxSessions: 1 }));
    const firstTransport = new StreamableHTTPClientTransport(server.url);
    const secondTransport = new StreamableHTTPClientTransport(server.url);
    const first = new Client({ name: "http-capacity-first", version: "1.0.0" });
    const second = new Client({ name: "http-capacity-second", version: "1.0.0" });

    try {
      const initializations = await Promise.allSettled([first.connect(firstTransport), second.connect(secondTransport)]);
      const fulfilled = initializations
        .map((result, index) => ({ result, index }))
        .filter((entry): entry is { result: PromiseFulfilledResult<void>; index: number } => entry.result.status === "fulfilled");
      const rejected = initializations.filter((result) => result.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = fulfilled[0]!.index;
      const winnerTransport = winner === 0 ? firstTransport : secondTransport;
      const winnerClient = winner === 0 ? first : second;
      await winnerTransport.terminateSession();
      await winnerClient.close();

      const retry = await connectClient(server.url, "http-capacity-retry");
      try {
        expect(profileName(await retry.callTool({ name: "miftah_current_profile", arguments: {} }))).toBe("default");
      } finally {
        await retry.close();
      }
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await server.close();
    }
  });
});
