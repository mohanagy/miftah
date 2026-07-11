import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema
} from "@modelcontextprotocol/sdk/types.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { MultiUpstreamProcessManager } from "../src/upstream/multi-upstream-process-manager.js";
import { MiftahError } from "../src/utils/errors.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

describe("multi-upstream wrapper", () => {
  it("does not proxy resources or prompts when no upstream is configured", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {},
      profiles: { work: {} }
    });
    const manager = new MultiUpstreamProcessManager(config);
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(client.getServerCapabilities()).not.toHaveProperty("resources");
      expect(client.getServerCapabilities()).not.toHaveProperty("prompts");
      expect(client.getInstructions()).toContain("No upstream is configured");
      expect(client.getInstructions()).not.toContain("multi-upstream");

      for (const { request, resultSchema } of [
        { request: { method: "resources/list", params: {} }, resultSchema: ListResourcesResultSchema },
        {
          request: { method: "resources/read", params: { uri: "account://current" } },
          resultSchema: ReadResourceResultSchema
        },
        { request: { method: "prompts/list", params: {} }, resultSchema: ListPromptsResultSchema },
        {
          request: { method: "prompts/get", params: { name: "account_prompt" } },
          resultSchema: GetPromptResultSchema
        }
      ]) {
        await expect(client.request(request, resultSchema)).rejects.toMatchObject({ code: -32601 });
      }

      const health = await client.callTool({ name: "miftah_health", arguments: {} }, CallToolResultSchema);
      const text = CallToolResultSchema.parse(health).content[0];
      expect(text?.type).toBe("text");
      if (text?.type !== "text") throw new Error("Expected a text health result");
      const status = JSON.parse(text.text);
      expect(status).toMatchObject({
        resourcePromptProxy: {
          available: false,
          reason: expect.stringContaining("No upstream is configured")
        },
        upstreams: []
      });
      expect(client.getInstructions()).toContain(status.resourcePromptProxy.reason);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("does not proxy resources or prompts from an ambiguous multi-upstream bundle", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-work" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(client.getServerCapabilities()).not.toHaveProperty("resources");
      expect(client.getServerCapabilities()).not.toHaveProperty("prompts");
      expect(client.getInstructions()).toContain("multi-upstream");

      for (const { request, resultSchema } of [
        { request: { method: "resources/list", params: {} }, resultSchema: ListResourcesResultSchema },
        {
          request: { method: "resources/read", params: { uri: "account://current" } },
          resultSchema: ReadResourceResultSchema
        },
        { request: { method: "prompts/list", params: {} }, resultSchema: ListPromptsResultSchema },
        {
          request: { method: "prompts/get", params: { name: "account_prompt" } },
          resultSchema: GetPromptResultSchema
        }
      ]) {
        await expect(client.request(request, resultSchema)).rejects.toMatchObject({ code: -32601 });
      }

      const health = await client.callTool({ name: "miftah_health", arguments: {} }, CallToolResultSchema);
      const text = CallToolResultSchema.parse(health).content[0];
      expect(text?.type).toBe("text");
      if (text?.type !== "text") throw new Error("Expected a text health result");
      expect(JSON.parse(text.text)).toMatchObject({
        resourcePromptProxy: {
          available: false,
          reason: expect.stringContaining("multi-upstream")
        },
        upstreams: []
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("proxies resources and prompts through the explicitly selected sole upstream", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-work" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(client.getServerCapabilities()).toMatchObject({ resources: {}, prompts: {} });
      expect(await client.listResources()).toMatchObject({
        resources: [{ uri: "account://current" }]
      });
      expect(await client.readResource({ uri: "account://current" })).toMatchObject({
        contents: [{ text: "github-work" }]
      });
      expect(await client.listPrompts()).toMatchObject({
        prompts: [{ name: "account_prompt" }]
      });
      expect(await client.getPrompt({ name: "account_prompt" })).toMatchObject({
        messages: [{ content: { text: "github-work" } }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("redacts secrets from successful upstream resource and prompt discovery", async () => {
    const secret = "discovery-success-secret";
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          upstreams: {
            github: {
              env: {
                API_TOKEN: secret,
                TEST_INCLUDE_DISCOVERY_TOKEN: "true"
              }
            }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const resources = await client.listResources();
      const prompts = await client.listPrompts();
      const discovery = JSON.stringify({ resources, prompts });

      expect(resources.resources[0]?.name).toContain("[REDACTED]");
      expect(prompts.prompts[0]?.description).toContain("[REDACTED]");
      expect(discovery).not.toContain(secret);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("redacts secrets from all upstream resource and prompt failures", async () => {
    const secret = "resource-list-secret";
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          upstreams: {
            github: {
              env: {
                API_TOKEN: secret,
                TEST_FAIL_LIST_RESOURCES: "true",
                TEST_FAIL_READ_RESOURCE: "true",
                TEST_FAIL_LIST_PROMPTS: "true",
                TEST_FAIL_GET_PROMPT: "true"
              }
            }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const errors = await Promise.all(
        [
          () => client.listResources(),
          () => client.readResource({ uri: "account://current" }),
          () => client.listPrompts(),
          () => client.getPrompt({ name: "account_prompt" })
        ].map((operation) => operation().catch((error: unknown) => error))
      );
      const messages = errors.map((error) => {
        expect(error).toBeInstanceOf(Error);
        return (error as Error).message;
      });
      expect(messages).toEqual([
        expect.stringContaining("[REDACTED]"),
        expect.stringContaining("[REDACTED]"),
        expect.stringContaining("[REDACTED]"),
        expect.stringContaining("[REDACTED]")
      ]);
      expect(messages).toEqual([
        expect.not.stringContaining(secret),
        expect.not.stringContaining(secret),
        expect.not.stringContaining(secret),
        expect.not.stringContaining(secret)
      ]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("rejects omitted upstream selection when multiple upstreams are configured", () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: { work: {} }
    });
    const manager = new MultiUpstreamProcessManager(config);

    let thrown: unknown;
    try {
      manager.get("work");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MiftahError);
    expect(thrown).toMatchObject({ code: "UPSTREAM_SELECTION_AMBIGUOUS" });
  });

  it("routes a namespaced tool call before tools are listed", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-work" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "github__whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "github-work" }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("lists namespaced upstream tools through the deterministic registry", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-work" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "miftah_list_upstream_tools", arguments: { profile: "work" } })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("github__whoami") }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("namespaces and routes tools from multiple upstream servers", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-work" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["github__whoami", "sentry__whoami"])
    );
    expect(await client.callTool({ name: "github__whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "github-work" }]
    });
    expect(await client.callTool({ name: "sentry__whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "sentry-work" }]
    });

    await client.close();
    await wrapper.close();
  });
});
