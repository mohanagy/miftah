import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function configPath(upstream?: { readonly url: string }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-v2-serving-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "miftah.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "1",
      name: "v2-serving-test",
      defaultProfile: "work",
      upstream: upstream === undefined
        ? { transport: "stdio", command: process.execPath, args: [fixture] }
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

  it("preserves the legacy initialized Streamable HTTP session path", async () => {
    const server = await startMiftahHttpServer(await configPath());
    httpServers.push(server);
    const transport = new StreamableHTTPClientTransport(server.url);
    const client = new Client({ name: "miftah-legacy-http-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect(transport.protocolVersion).toBe("2025-11-25");
      expect(transport.sessionId).toEqual(expect.any(String));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("whoami");
    } finally {
      await client.close();
    }
  });

  it.each([
    ["modern", { versionNegotiation: { mode: "auto" as const } }, "modern"],
    ["legacy", undefined, "legacy"]
  ])("serves %s clients through the SDK v2 stdio entry", async (_era, clientOptions, expectedEra) => {
    const path = await configPath();
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
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("whoami");
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
