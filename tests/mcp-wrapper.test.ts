import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectExactlyOneNotification } from "./helpers/notifications.js";
import { validateConfig } from "../src/config/validate-config.js";
import type { MiftahConfig } from "../src/config/types.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");
const toolCollisionPattern = /TOOL_COLLISION/;

describe("Miftah MCP wrapper", () => {
  it("exposes management and upstream capabilities while routing calls by active profile", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work", API_TOKEN: "hidden-token" }, policy: "readonly" },
        personal: { env: { TEST_ACCOUNT_NAME: "personal", API_TOKEN: "hidden-token" } }
      },
      policies: { readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] } },
      security: { allowProfileSwitchingFromMcp: true },
      audit: { enabled: false }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["miftah_list_profiles", "miftah_use_profile", "whoami", "create_item"])
    );
    expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "work" }]
    });
    expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("personal") }]
    });
    expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "personal" }]
    });
    expect(await client.callTool({ name: "echo", arguments: { message: "hidden-token" } })).toMatchObject({
      content: [{ type: "text", text: "[REDACTED]" }]
    });
    expect(await client.readResource({ uri: "account://current" })).toMatchObject({
      contents: [{ text: "personal" }]
    });
    expect(await client.getPrompt({ name: "account_prompt" })).toMatchObject({
      messages: [{ content: { text: "personal" } }]
    });

    await client.callTool({ name: "miftah_use_profile", arguments: { profile: "work" } });
    const blocked = await client.callTool({ name: "create_item", arguments: { name: "x" } });
    expect(blocked).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("POLICY_BLOCKED") }] });

    await client.close();
    await wrapper.close();
  });

  it("blocks destructive calls when runtime policy lookup misses an explicitly named policy", async () => {
    const config: MiftahConfig = {
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work", API_TOKEN: "hidden-token" }, policy: "missing-policy" }
      },
      audit: { enabled: false }
    };

    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config);
    const wrapper = new MiftahServer(config, profiles, manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
    const blocked = await client.callTool({ name: "create_item", arguments: { name: "x" } });
    expect(blocked).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("POLICY_BLOCKED") }]
    });

    await client.close();
    await wrapper.close();
  });

  it("advertises and emits tool list changes after a profile switch", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true } });
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      await expectExactlyOneNotification(() => notifications);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("keeps the internal profile revision out of the management response", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { env: { TEST_ACCOUNT_NAME: "work" } } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const result = CallToolResultSchema.parse(
        await client.callTool({ name: "miftah_current_profile", arguments: {} }, CallToolResultSchema)
      );
      const content = result.content[0];
      expect(content).toMatchObject({ type: "text" });
      if (content?.type !== "text") throw new Error("Expected a text result.");
      expect(JSON.parse(content.text)).toEqual({
        activeProfile: "work",
        defaultProfile: "work",
        routingMode: "hybrid"
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("refreshes the advertised tool schema after a profile switch", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: {
          env: {
            TEST_ACCOUNT_NAME: "personal",
            TEST_WHOAMI_SCHEMA: "account"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const before = await client.listTools();
      expect(before.tools.find((tool) => tool.name === "whoami")).toMatchObject({
        inputSchema: { properties: {} }
      });
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });

      const after = await client.listTools();
      expect(after.tools.find((tool) => tool.name === "whoami")).toMatchObject({
        inputSchema: {
          properties: { account: { type: "string" } },
          required: ["account"]
        }
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("retries tool discovery when the active profile changes during listing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-tool-list-race-"));
    const startedPath = join(directory, "tools-list-started");
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_LIST_TOOLS_STARTED_PATH: startedPath,
            TEST_LIST_TOOLS_DELAY_MS: "100"
          }
        },
        personal: {
          env: {
            TEST_ACCOUNT_NAME: "personal",
            TEST_WHOAMI_SCHEMA: "account"
          }
        }
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const listing = client.listTools();
      await expect
        .poll(async () => {
          try {
            await access(startedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });

      const tools = await listing;
      expect(tools.tools.find((tool) => tool.name === "whoami")).toMatchObject({
        inputSchema: {
          properties: { account: { type: "string" } },
          required: ["account"]
        }
      });
      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.find((event) => event.kind === "operation" && event.operation === "tools/list")).toMatchObject({
        sourceProfile: "work",
        profile: "personal"
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("rejects routing to a profile with a different advertised tool schema", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: {
          env: {
            TEST_ACCOUNT_NAME: "personal",
            TEST_WHOAMI_SCHEMA: "account"
          }
        }
      },
      routing: {
        rules: [{ when: { "args.target": "personal" }, profile: "personal" }]
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "whoami", arguments: { target: "personal" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("TOOL_SCHEMA_MISMATCH") }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("fails strict discovery when configured profiles expose different tool schemas", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: {
          env: {
            TEST_ACCOUNT_NAME: "personal",
            TEST_WHOAMI_SCHEMA: "account"
          }
        }
      },
      tooling: { toolDiscoveryMode: "strict" }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.listTools()).rejects.toThrow(
        /TOOL_SCHEMA_MISMATCH: strict tools discovery found different client-visible schemas.*personal.*work.*whoami/
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("invalidates strict discovery when a non-active profile becomes unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-strict-profile-failure-"));
    const personalCrashPath = join(directory, "personal-crash");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: {
          env: {
            TEST_ACCOUNT_NAME: "personal",
            TEST_CRASH_ON_CALL_TOOL_PATH: personalCrashPath
          }
        }
      },
      routing: {
        rules: [{ when: { "args.target": "personal" }, profile: "personal" }]
      },
      tooling: { toolDiscoveryMode: "strict" }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();

      await writeFile(personalCrashPath, "crash");
      expect(await client.callTool({ name: "whoami", arguments: { target: "personal" } })).toMatchObject({
        isError: true
      });
      await expect
        .poll(() => manager.listHealth().find((health) => health.profile === "personal")?.state)
        .toBe("failed");

      await expect(client.listTools()).rejects.toThrow(
        /UPSTREAM_DISCOVERY_FAILED: strict tools discovery failed for profile 'work'.*profile 'personal'/
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("rejects unknown tool calls without forwarding them upstream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-unknown-tool-"));
    const callCountPath = join(directory, "upstream-call-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_CALL_TOOL_COUNT_PATH: callCountPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(access(callCountPath)).rejects.toThrow();
      expect(await client.callTool({ name: "not_an_upstream_tool", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("TOOL_NOT_FOUND") }]
      });
      await expect(access(callCountPath)).rejects.toThrow();
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("resolves unregistered miftah-prefixed names through the tool registry", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { env: { TEST_ACCOUNT_NAME: "work" } } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "miftah_not_registered", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("TOOL_NOT_FOUND") }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("routes registered miftah-prefixed upstream tools through the registry", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_INCLUDE_MIFTAH_PREFIX_TOOL: "true"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "miftah_custom", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "created:" }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("does not publish partial routes when discovery finds a tool collision", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_INCLUDE_MANAGEMENT_TOOL: "true"
          }
        }
      },
      tooling: { collisionStrategy: "fail" }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.listTools()).rejects.toThrow(toolCollisionPattern);
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("TOOL_COLLISION") }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("shares controlled discovery between a list request and a cold call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-tool-discovery-"));
    const startedPath = join(directory, "tools-list-started");
    const countPath = join(directory, "tools-list-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_LIST_TOOLS_STARTED_PATH: startedPath,
            TEST_LIST_TOOLS_COUNT_PATH: countPath,
            TEST_LIST_TOOLS_DELAY_MS: "100"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const listing = client.listTools();
      await expect
        .poll(async () => {
          try {
            await access(startedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      const calling = client.callTool({ name: "whoami", arguments: {} });

      expect(await calling).toMatchObject({ content: [{ type: "text", text: "work" }] });
      expect((await listing).tools.map((tool) => tool.name)).toContain("whoami");
      expect((await readFile(countPath, "utf8")).trim().split("\n")).toEqual(["1"]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("invalidates a profile tool snapshot after an explicit restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-tool-restart-"));
    const countPath = join(directory, "tools-list-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_LIST_TOOLS_COUNT_PATH: countPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.listTools();
      await client.callTool({ name: "miftah_restart_profile", arguments: { profile: "work" } });
      await client.listTools();

      expect((await readFile(countPath, "utf8")).trim().split("\n")).toEqual(["1", "1"]);
      await expectExactlyOneNotification(() => notifications);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("linearizes a cold tool call before a concurrent profile switch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-tool-call-race-"));
    const startedPath = join(directory, "tools-list-started");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_LIST_TOOLS_STARTED_PATH: startedPath,
            TEST_LIST_TOOLS_DELAY_MS: "100"
          }
        },
        personal: {
          env: {
            TEST_ACCOUNT_NAME: "personal",
            TEST_WHOAMI_SCHEMA: "account"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const call = client.callTool({ name: "whoami", arguments: {} });
      await expect
        .poll(async () => {
          try {
            await access(startedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });

      expect(await call).toMatchObject({ content: [{ type: "text", text: "work" }] });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("blocks denied resource reads before forwarding them upstream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-resource-policy-deny-"));
    const readCountPath = join(directory, "resource-read-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_READ_RESOURCE_COUNT_PATH: readCountPath
          },
          policy: "readonly"
        }
      },
      policies: {
        readonly: { deny: ["resources/read"] }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.readResource({ uri: "account://current" })).rejects.toThrow(/POLICY_BLOCKED/);
      await expect(access(readCountPath)).rejects.toThrow();
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("blocks denied prompt retrieval before forwarding it upstream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-prompt-policy-deny-"));
    const getCountPath = join(directory, "prompt-get-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_GET_PROMPT_COUNT_PATH: getCountPath
          },
          policy: "readonly"
        }
      },
      policies: {
        readonly: { deny: ["prompts/get"] }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.getPrompt({ name: "account_prompt" })).rejects.toThrow(/POLICY_BLOCKED/);
      await expect(access(getCountPath)).rejects.toThrow();
    } finally {
      await client.close();
      await wrapper.close();
    }
  });
});
