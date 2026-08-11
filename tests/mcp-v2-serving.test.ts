import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { startMiftahHttpServer, type MiftahHttpServer } from "../src/http/miftah-http-server.js";
import { createMiftahServerFactory } from "../src/runtime/create-miftah-runtime.js";
import { startFakeRemoteUpstream, type FakeRemoteUpstream } from "./helpers/fake-remote-upstream.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-upstream.mjs", import.meta.url));
const temporaryDirectories: string[] = [];
const httpServers: MiftahHttpServer[] = [];
const remoteUpstreams: FakeRemoteUpstream[] = [];

afterEach(async () => {
  await Promise.all(httpServers.splice(0).map((server) => server.close()));
  await Promise.all(remoteUpstreams.splice(0).map((upstream) => upstream.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function configPath(upstream?: {
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-v2-serving-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "miftah.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "1",
      name: "v2-serving-test",
      defaultProfile: "work",
      upstream: upstream?.url === undefined
        ? {
            transport: "stdio",
            command: process.execPath,
            args: [fixture],
            ...(upstream?.env === undefined ? {} : { env: upstream.env })
          }
        : { transport: "streamable-http", url: upstream.url },
      profiles: { work: {} },
      server: { http: { port: 0, maxSessions: 4, sessionIdleTimeoutMs: 1_000 } }
    })
  );
  return path;
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the protocol condition.");
    await delay(25);
  }
}

function mutateRequestHeaders(
  targetMethod: string,
  mutate: (headers: Headers) => void,
  observeResponse?: (responseBody: string) => void
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.get("mcp-method") !== targetMethod) return fetch(request);
    const headers = new Headers(request.headers);
    mutate(headers);
    const response = await fetch(new Request(request, { headers }));
    if (observeResponse !== undefined) observeResponse(await response.clone().text());
    return response;
  };
}

describe("MCP SDK v2 serving interoperability", () => {
  it("negotiates modern Streamable HTTP without initialize or a session id", async () => {
    const server = await startMiftahHttpServer(await configPath());
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url);
    const client = new Client(
      { name: "miftah-modern-http-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    try {
      await client.connect(transport);
      expect(transport.protocolVersion).toBe("2026-07-28");
      expect(transport.sessionId).toBeUndefined();
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("whoami");
      expect(transport.sessionId).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("publishes truthful private no-cache catalog hints for request-scoped modern HTTP", async () => {
    const server = await startMiftahHttpServer(await configPath());
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url);
    const client = new Client(
      { name: "miftah-modern-cache-hint-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const resources = await client.listResources();
      const prompts = await client.listPrompts();
      const resource = resources.resources[0];
      if (resource === undefined) throw new Error("Expected the cache-hint fixture to expose a resource.");
      const read = await client.readResource({ uri: resource.uri });

      for (const result of [tools, resources, prompts, read]) {
        expect(result).toMatchObject({ ttlMs: 0, cacheScope: "private" });
      }
    } finally {
      await client.close();
    }
  });

  it.each([
    ["missing", (headers: Headers) => headers.delete("mcp-method")],
    ["mismatched", (headers: Headers) => headers.set("mcp-method", "tools/call")],
    ["duplicated", (headers: Headers) => headers.append("mcp-method", "tools/list")]
  ])("fails closed on a %s Mcp-Method before starting an upstream", async (_case, mutate) => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-v2-method-header-"));
    temporaryDirectories.push(directory);
    const startCountPath = join(directory, "upstream-start-count");
    const server = await startMiftahHttpServer(await configPath({
      env: { TEST_START_COUNT_PATH: startCountPath }
    }));
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url, {
      fetch: mutateRequestHeaders("tools/list", mutate)
    });
    const client = new Client(
      { name: "miftah-modern-method-header-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    try {
      await client.connect(transport);
      await expect(client.listTools()).rejects.toMatchObject({ code: -32020 });
      await expect(access(startCountPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
    }
  });

  it.each([
    ["missing", (headers: Headers) => headers.delete("mcp-name")],
    ["mismatched", (headers: Headers) => headers.set("mcp-name", "other_tool")],
    ["malformed encoded", (headers: Headers) => headers.set("mcp-name", "=?base64?%%%?=")],
    ["duplicated", (headers: Headers) => headers.append("mcp-name", "whoami")]
  ])("fails closed on a %s Mcp-Name before executing a tool", async (_case, mutate) => {
    const upstream = await startFakeRemoteUpstream();
    remoteUpstreams.push(upstream);
    const server = await startMiftahHttpServer(await configPath({ url: upstream.streamableHttpUrl }));
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url, {
      fetch: mutateRequestHeaders("tools/call", mutate)
    });
    const client = new Client(
      { name: "miftah-modern-name-header-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    try {
      await client.connect(transport);
      await expect(client.callTool({ name: "whoami", arguments: {} })).rejects.toMatchObject({ code: -32020 });
      expect(upstream.toolCallRequests()).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("accepts an encoded Mcp-Name only when it decodes to the executed tool", async () => {
    const upstream = await startFakeRemoteUpstream();
    remoteUpstreams.push(upstream);
    const server = await startMiftahHttpServer(await configPath({ url: upstream.streamableHttpUrl }));
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url, {
      fetch: mutateRequestHeaders("tools/call", (headers) => {
        headers.set("mcp-name", `=?base64?${Buffer.from("whoami").toString("base64")}?=`);
      })
    });
    const client = new Client(
      { name: "miftah-modern-encoded-name-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    try {
      await client.connect(transport);
      await expect(client.callTool({ name: "whoami", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "unknown" }]
      });
      expect(upstream.toolCallRequests()).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("does not advertise, accept, or leak unsupported Mcp-Param headers on modern HTTP", async () => {
    const secretHeaderValue = "must-not-reach-the-upstream";
    const rejectionBodies: string[] = [];
    const upstream = await startFakeRemoteUpstream({ exposeMcpParameterHeader: true });
    remoteUpstreams.push(upstream);
    const server = await startMiftahHttpServer(await configPath({ url: upstream.streamableHttpUrl }));
    httpServers.push(server);
    const modernTransport = new StreamableHTTPClientTransport(server.url, {
      fetch: mutateRequestHeaders(
        "tools/call",
        (headers) => headers.set("mcp-param-account", secretHeaderValue),
        (body) => rejectionBodies.push(body)
      )
    });
    const modernClient = new Client(
      { name: "miftah-modern-parameter-header-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );
    const legacyTransport = new StreamableHTTPClientTransport(server.url);
    const legacyClient = new Client({ name: "miftah-legacy-parameter-header-test", version: "1.0.0" });

    try {
      await modernClient.connect(modernTransport);
      const modernTool = (await modernClient.listTools()).tools.find((tool) => tool.name === "whoami");
      expect(JSON.stringify(modernTool?.inputSchema)).not.toContain("x-mcp-header");
      await expect(modernClient.callTool({ name: "whoami", arguments: { account: "work" } }))
        .rejects.toMatchObject({ code: -32020 });
      expect(upstream.toolCallRequests()).toBe(0);
      expect(rejectionBodies.join("\n")).not.toContain(secretHeaderValue);
      expect(rejectionBodies.join("\n")).not.toContain("mcp-param-account");

      await legacyClient.connect(legacyTransport);
      const legacyTool = (await legacyClient.listTools()).tools.find((tool) => tool.name === "whoami");
      expect(JSON.stringify(legacyTool?.inputSchema)).toContain("x-mcp-header");
    } finally {
      await modernClient.close();
      await legacyClient.close();
    }
  });

  it("continues a modern HTTP form approval across request-scoped server instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-v2-approval-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "miftah.json");
    const auditPath = join(directory, "audit.jsonl");
    const createCountPath = join(directory, "create-count");
    const secretArgument = "modern-approval-secret";
    await writeFile(
      path,
      JSON.stringify({
        version: "1",
        name: "v2-approval-test",
        defaultProfile: "work",
        upstream: {
          transport: "stdio",
          command: process.execPath,
          args: [fixture]
        },
        profiles: {
          work: {
            policy: "confirm",
            env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath }
          }
        },
        policies: { confirm: { requireConfirmation: ["create_item"] } },
        audit: { path: auditPath },
        server: { http: { port: 0, maxSessions: 4, sessionIdleTimeoutMs: 1_000 } }
      })
    );
    const server = await startMiftahHttpServer(path);
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url);
    const client = new Client(
      { name: "miftah-modern-approval-test", version: "1.0.0" },
      {
        versionNegotiation: { mode: "auto" },
        capabilities: { elicitation: { form: {} } }
      }
    );
    const elicitationRequests: unknown[] = [];
    client.setRequestHandler('elicitation/create', async (request) => {
      elicitationRequests.push(request);
      return { action: "accept", content: { approved: true } };
    });

    try {
      await client.connect(transport);
      expect(await client.callTool({ name: "create_item", arguments: { name: secretArgument } })).toMatchObject({
        content: [{ type: "text", text: `created:${secretArgument}` }]
      });
      expect(elicitationRequests).toHaveLength(1);
      expect(JSON.stringify(elicitationRequests)).not.toContain(secretArgument);
      expect(await readFile(createCountPath, "utf8")).toBe("1\n");
      const approvalActions = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "approval")
        .map((event) => event.approvalAction);
      expect(approvalActions).toEqual(["requested", "approved", "consumed"]);
    } finally {
      await client.close();
    }
  });

  it("does not probe or advertise connection-bound resource subscriptions for modern HTTP requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-v2-serving-probe-"));
    temporaryDirectories.push(directory);
    const startCountPath = join(directory, "upstream-start-count");
    const server = await startMiftahHttpServer(await configPath({
      env: {
        TEST_RESOURCE_SUBSCRIPTIONS: "true",
        TEST_START_COUNT_PATH: startCountPath
      }
    }));
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url);
    const client = new Client(
      { name: "miftah-modern-http-subscription-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    try {
      await client.connect(transport);
      expect(client.getServerCapabilities()?.resources?.subscribe).not.toBe(true);
      await expect(access(startCountPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("whoami");
      await expect.poll(async () => access(startCountPath).then(() => true, () => false)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("preserves the legacy initialized Streamable HTTP session path", async () => {
    const server = await startMiftahHttpServer(await configPath());
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url);
    const client = new Client({ name: "miftah-legacy-http-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect(transport.protocolVersion).toBe("2025-11-25");
      expect(transport.sessionId).toEqual(expect.any(String));
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("whoami");
      expect(tools).not.toHaveProperty("ttlMs");
      expect(tools).not.toHaveProperty("cacheScope");
    } finally {
      await client.close();
    }
  });

  it.each([
    ["modern", { versionNegotiation: { mode: "auto" as const } }, "modern"],
    ["legacy", undefined, "legacy"]
  ])("serves %s clients through the SDK v2 stdio entry", async (_era, clientOptions, expectedEra) => {
    const path = await configPath({ env: { TEST_RESOURCE_SUBSCRIPTIONS: "true" } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const baseFactory = createMiftahServerFactory(path);
    const eras: string[] = [];
    const handle = serveStdio((context) => {
      eras.push(context.era);
      return baseFactory(context);
    }, { transport: serverTransport });
    const client = new Client(
      { name: `miftah-${_era}-stdio-test`, version: "1.0.0" },
      clientOptions
    );

    try {
      await client.connect(clientTransport);
      expect([...new Set(eras)]).toEqual([expectedEra]);
      if (expectedEra === "legacy") {
        expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
      } else {
        expect(client.getServerCapabilities()?.resources?.subscribe).not.toBe(true);
      }
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("whoami");
      if (expectedEra === "legacy") {
        expect(tools).not.toHaveProperty("ttlMs");
        expect(tools).not.toHaveProperty("cacheScope");
      } else {
        expect(tools).toMatchObject({ ttlMs: 0, cacheScope: "private" });
      }
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it("returns an explicit supported-version diagnostic for a pinned unsupported revision", async () => {
    const server = await startMiftahHttpServer(await configPath());
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url);
    const client = new Client(
      { name: "miftah-unsupported-http-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2099-01-01" } } }
    );

    try {
      await expect(client.connect(transport)).rejects.toMatchObject({
        data: { requested: "2099-01-01", supported: ["2026-07-28"] }
      });
    } finally {
      await client.close();
    }
  });

  it("propagates modern HTTP request cancellation to the selected upstream", async () => {
    const upstream = await startFakeRemoteUpstream({ callToolDelayMs: 5_000 });
    remoteUpstreams.push(upstream);
    const server = await startMiftahHttpServer(await configPath({ url: upstream.streamableHttpUrl }));
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url);
    const client = new Client(
      { name: "miftah-modern-http-cancellation-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    try {
      await client.connect(transport);
      const controller = new AbortController();
      const pending = client.callTool({ name: "whoami", arguments: {} }, { signal: controller.signal });
      await waitFor(() => upstream.toolCallRequests() === 1);
      controller.abort();
      await expect(pending).rejects.toBeDefined();
      await waitFor(() => upstream.cancelledNotifications() === 1);
    } finally {
      await client.close();
    }
  });
});
