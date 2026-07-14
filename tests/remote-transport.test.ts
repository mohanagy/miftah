import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";
import { startFakeRemoteUpstream, type FakeRemoteUpstream } from "./helpers/fake-remote-upstream.js";

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
  return true;
}

describe("remote upstream transports", () => {
  const upstreams: FakeRemoteUpstream[] = [];

  afterEach(async () => {
    await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  });

  it("keeps streamable HTTP profile headers isolated while proxying capabilities", async () => {
    const upstream = await startFakeRemoteUpstream();
    upstreams.push(upstream);
    const config = validateConfig({
      version: "1",
      name: "remote-accounts",
      defaultProfile: "work",
      upstream: {
        transport: "streamable-http",
        url: upstream.streamableHttpUrl,
        headers: { Authorization: "Bearer base-secret", "X-Profile": "base" }
      },
      profiles: {
        work: { headers: { authorization: "Bearer work-secret", "x-profile": "work" } },
        personal: { headers: { AUTHORIZATION: "Bearer personal-secret", "X-PROFILE": "personal" } }
      },
      security: { allowProfileSwitchingFromMcp: true }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles);
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "remote-transport-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("whoami");
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
      expect(await client.readResource({ uri: "account://current" })).toMatchObject({
        contents: [{ text: "work" }]
      });
      expect(await client.getPrompt({ name: "account_prompt" })).toMatchObject({
        messages: [{ content: { text: "work" } }]
      });

      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });

      const workHeaders = upstream.requests().filter((request) => request.headers["x-profile"] === "work");
      const personalHeaders = upstream.requests().filter((request) => request.headers["x-profile"] === "personal");
      expect(workHeaders).not.toHaveLength(0);
      expect(personalHeaders).not.toHaveLength(0);
      expect(workHeaders.map((request) => request.headers.authorization)).toEqual(
        expect.arrayContaining(["Bearer work-secret"])
      );
      expect(personalHeaders.map((request) => request.headers.authorization)).toEqual(
        expect.arrayContaining(["Bearer personal-secret"])
      );
      expect(JSON.stringify(await client.callTool({ name: "miftah_health", arguments: {} }))).not.toContain("secret");
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("forwards cancellation to a streamable HTTP upstream", async () => {
    const upstream = await startFakeRemoteUpstream({ callToolDelayMs: 500 });
    upstreams.push(upstream);
    const config = validateConfig({
      version: "1",
      name: "remote-cancellation",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: upstream.streamableHttpUrl },
      profiles: { work: { headers: { "X-Profile": "work" } } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles);
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "remote-cancellation-test", version: "1.0.0" });
    const controller = new AbortController();

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const pending = client.callTool({ name: "whoami", arguments: {} }, undefined, { signal: controller.signal });
      await expect.poll(() => upstream.toolCallRequests()).toBe(1);
      controller.abort("test cancellation");

      await expect(pending).rejects.toThrow();
      await expect.poll(() => upstream.cancelledNotifications()).toBe(1);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("forwards progress from a streamable HTTP upstream", async () => {
    const upstream = await startFakeRemoteUpstream({ emitCallToolProgress: true });
    upstreams.push(upstream);
    const config = validateConfig({
      version: "1",
      name: "remote-progress",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: upstream.streamableHttpUrl },
      profiles: { work: { headers: { "X-Profile": "work" } } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles);
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "remote-progress-test", version: "1.0.0" });
    const progressUpdates: unknown[] = [];

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(
        await client.callTool(
          { name: "whoami", arguments: {} },
          undefined,
          { onprogress: (progress) => progressUpdates.push(progress) }
        )
      ).toMatchObject({ content: [{ type: "text", text: "work" }] });
      expect(progressUpdates).toEqual([{ progress: 1, total: 2 }]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("terminates streamable HTTP sessions during managed restarts and shutdown", async () => {
    const upstream = await startFakeRemoteUpstream();
    upstreams.push(upstream);
    const manager = new UpstreamProcessManager(
      { transport: "streamable-http", url: upstream.streamableHttpUrl },
      { work: {} }
    );

    try {
      await manager.get("work");
      const [firstSessionId] = upstream.streamableSessionIds();
      expect(firstSessionId).toBeDefined();

      await manager.restart("work");
      expect(upstream.closedStreamableSessionIds()).toContain(firstSessionId);
      expect(upstream.streamableSessionIds()).not.toContain(firstSessionId);

      const [secondSessionId] = upstream.streamableSessionIds();
      expect(secondSessionId).toBeDefined();
      expect(secondSessionId).not.toBe(firstSessionId);

      await manager.close();
      expect(upstream.closedStreamableSessionIds()).toContain(secondSessionId);
    } finally {
      await manager.close();
    }
  });

  it("forces local cleanup when a Streamable HTTP session DELETE hangs", async () => {
    const upstream = await startFakeRemoteUpstream();
    upstreams.push(upstream);
    const manager = new UpstreamProcessManager(
      { transport: "streamable-http", url: upstream.streamableHttpUrl },
      { work: {} },
      { shutdownTimeoutMs: 50 }
    );

    try {
      await manager.get("work");
      upstream.hangStreamableDeletes();

      const closeStartedAt = Date.now();
      await manager.close();
      expect(Date.now() - closeStartedAt).toBeLessThan(500);
      expect(await waitFor(() => upstream.hangingStreamableDeleteClosed())).toBe(true);
    } finally {
      upstream.releaseHangingStreamableDelete();
      await manager.close();
    }
  });

  it("uses the http compatibility alias for Streamable HTTP", async () => {
    const upstream = await startFakeRemoteUpstream();
    upstreams.push(upstream);
    const manager = new UpstreamProcessManager(
      { transport: "http", url: upstream.streamableHttpUrl },
      { work: { headers: { "X-Profile": "work" } } }
    );

    try {
      const session = await manager.get("work");
      expect(await session.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
    } finally {
      await manager.close();
    }
  });

  it("reports remote HTTP startup status without exposing an upstream response body", async () => {
    const upstream = await startFakeRemoteUpstream({
      initializationStatus: 401,
      initializationBody: "Bearer server-secret was rejected"
    });
    upstreams.push(upstream);
    const manager = new UpstreamProcessManager(
      {
        transport: "streamable-http",
        url: upstream.streamableHttpUrl,
        headers: { Authorization: "Bearer configured-secret" }
      },
      { work: {} }
    );

    try {
      const error = await manager.get("work").catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "UPSTREAM_HTTP_ERROR",
        message: "UPSTREAM_HTTP_ERROR: streamable-http upstream for profile 'work' returned HTTP 401",
        details: { profile: "work", transport: "streamable-http", status: 401 }
      });
      expect(`${error instanceof Error ? error.message : ""} ${JSON.stringify(error)}`).not.toContain("secret");
    } finally {
      await manager.close();
    }
  });

  it("reports remote MCP protocol errors without exposing an upstream error message", async () => {
    const upstream = await startFakeRemoteUpstream({
      callToolError: { code: -32603, message: "remote-server-secret must not escape" }
    });
    upstreams.push(upstream);
    const config = validateConfig({
      version: "1",
      name: "remote-errors",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: upstream.streamableHttpUrl },
      profiles: { work: {} }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles);
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "remote-protocol-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "UPSTREAM_PROTOCOL_ERROR: streamable-http upstream for profile 'work' returned MCP error -32603"
          }
        ]
      });
      expect(JSON.stringify(result)).not.toContain("remote-server-secret");
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("reports remote HTTP operation status without exposing an upstream response body", async () => {
    const upstream = await startFakeRemoteUpstream();
    upstreams.push(upstream);
    const config = validateConfig({
      version: "1",
      name: "remote-operation-errors",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: upstream.streamableHttpUrl },
      profiles: { work: {} }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles);
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "remote-operation-error-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();
      upstream.failNextStreamableRequest(503, "server-secret must not escape");

      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "UPSTREAM_HTTP_ERROR: streamable-http upstream for profile 'work' returned HTTP 503"
          }
        ]
      });
      expect(JSON.stringify(result)).not.toContain("server-secret");
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("keeps legacy SSE profile headers isolated while proxying capabilities", async () => {
    const upstream = await startFakeRemoteUpstream();
    upstreams.push(upstream);
    const config = validateConfig({
      version: "1",
      name: "legacy-sse",
      defaultProfile: "work",
      upstream: {
        transport: "sse",
        url: upstream.sseUrl,
        headers: { Authorization: "Bearer base-secret", "X-Profile": "base" }
      },
      profiles: {
        work: { headers: { authorization: "Bearer work-secret", "x-profile": "work" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles);
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "legacy-sse-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("whoami");
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
      expect(await client.readResource({ uri: "account://current" })).toMatchObject({
        contents: [{ text: "work" }]
      });
      expect(await client.getPrompt({ name: "account_prompt" })).toMatchObject({
        messages: [{ content: { text: "work" } }]
      });

      expect(upstream.requests()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "GET",
            path: "/sse",
            headers: expect.objectContaining({
              authorization: "Bearer work-secret",
              "x-profile": "work"
            })
          })
        ])
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("reports legacy SSE HTTP operation status without exposing an upstream response body", async () => {
    const upstream = await startFakeRemoteUpstream();
    upstreams.push(upstream);
    const config = validateConfig({
      version: "1",
      name: "legacy-sse-errors",
      defaultProfile: "work",
      upstream: { transport: "sse", url: upstream.sseUrl },
      profiles: { work: {} }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles);
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "legacy-sse-error-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();
      upstream.failNextSsePost(502, "legacy-sse-server-secret must not escape");

      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "UPSTREAM_HTTP_ERROR: sse upstream for profile 'work' returned HTTP 502"
          }
        ]
      });
      expect(JSON.stringify(result)).not.toContain("legacy-sse-server-secret");
    } finally {
      await client.close();
      await wrapper.close();
    }
  });
});
