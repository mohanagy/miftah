import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  PromptListChangedNotificationSchema,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";
import { access, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectExactlyOneNotification } from "./helpers/notifications.js";
import { validateConfig } from "../src/config/validate-config.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { MultiUpstreamProcessManager } from "../src/upstream/multi-upstream-process-manager.js";
import { MiftahError } from "../src/utils/errors.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");
const promptCollisionPattern = /PROMPT_COLLISION/;
const resourceCollisionPattern = /RESOURCE_COLLISION/;
const resourceCursorInvalidPattern = /RESOURCE_CURSOR_INVALID/;
const promptCursorInvalidPattern = /PROMPT_CURSOR_INVALID/;
const githubResourceRoutePattern = /^miftah:\/\/resource\/github\?/;
const resourceNotFoundPattern = /RESOURCE_NOT_FOUND/;
const promptNotFoundPattern = /PROMPT_NOT_FOUND/;

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

  it("advertises resources and prompts for a multi-upstream bundle", async () => {
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

      expect(client.getServerCapabilities()).toMatchObject({ resources: {}, prompts: {} });
      expect(client.getInstructions()).not.toContain("multi-upstream");

      const health = await client.callTool({ name: "miftah_health", arguments: {} }, CallToolResultSchema);
      const text = CallToolResultSchema.parse(health).content[0];
      expect(text?.type).toBe("text");
      if (text?.type !== "text") throw new Error("Expected a text health result");
      expect(JSON.parse(text.text)).toMatchObject({
        resourcePromptProxy: { available: true },
        upstreams: []
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("keeps healthy aggregate capabilities available when a bundled upstream cannot start", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] }
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

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("github__whoami");
      expect(tools.tools.map((tool) => tool.name)).not.toContain("sentry__whoami");

      expect((await client.listResources()).resources.map((resource) => resource.name)).toEqual([
        "github__Current account"
      ]);
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(["github__account_prompt"]);

      const health = CallToolResultSchema.parse(
        await client.callTool({ name: "miftah_health", arguments: {} }, CallToolResultSchema)
      );
      const content = health.content[0];
      expect(content).toMatchObject({ type: "text" });
      if (content?.type !== "text") throw new Error("Expected a text health result");
      expect(JSON.parse(content.text).upstreams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            profile: "work",
            upstreamName: "github",
            state: "running",
            lastTransition: expect.any(String),
            restartCount: 0
          }),
          expect.objectContaining({
            profile: "work",
            upstreamName: "sentry",
            state: "failed",
            lastTransition: expect.any(String),
            restartCount: expect.any(Number),
            error: expect.any(String)
          })
        ])
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("reports redacted capability discovery failures as degraded upstream health", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-health-discovery-failure-"));
    const sentryFailurePath = join(directory, "sentry-resource-failure");
    const secret = "health-discovery-secret";
    await writeFile(sentryFailurePath, "fail");
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
            sentry: {
              env: {
                API_TOKEN: secret,
                TEST_ACCOUNT_NAME: "sentry-work",
                TEST_FAIL_LIST_RESOURCES_PATH: sentryFailurePath
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

      expect((await client.listResources()).resources.map((resource) => resource.name)).toEqual([
        "github__Current account"
      ]);
      const health = CallToolResultSchema.parse(
        await client.callTool({ name: "miftah_health", arguments: {} }, CallToolResultSchema)
      );
      const content = health.content[0];
      expect(content).toMatchObject({ type: "text" });
      if (content?.type !== "text") throw new Error("Expected a text health result");
      const sentry = JSON.parse(content.text).upstreams.find((upstream: { upstreamName: string }) => upstream.upstreamName === "sentry");
      expect(sentry).toMatchObject({
        profile: "work",
        upstreamName: "sentry",
        state: "degraded",
        processState: "running",
        lastTransition: expect.any(String),
        restartCount: 0,
        capabilities: {
          resources: {
            state: "failed",
            lastTransition: expect.any(String),
            error: expect.stringContaining("[REDACTED]")
          }
        }
      });
      expect(JSON.stringify(sentry)).not.toContain(secret);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("fails strict tool discovery with a complete unavailable-upstream diagnostic", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] }
      },
      profiles: {
        work: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-work" } }
          }
        }
      },
      tooling: { toolDiscoveryMode: "strict" }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.listTools()).rejects.toThrow(
        /UPSTREAM_DISCOVERY_FAILED: strict tools discovery failed for profile 'work': upstream 'sentry'/
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("fails permissive tool discovery when no bundled upstream is healthy", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] },
        sentry: { transport: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] }
      },
      profiles: { work: {} }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.listTools()).rejects.toThrow(
        /UPSTREAM_DISCOVERY_FAILED: no healthy upstream completed tools discovery for profile 'work': upstream 'github'.*upstream 'sentry'/
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("fails strict resource discovery with a complete unavailable-upstream diagnostic", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] }
      },
      profiles: { work: { upstreams: { github: { env: { TEST_ACCOUNT_NAME: "github-work" } } } } },
      tooling: { toolDiscoveryMode: "strict" }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.listResources()).rejects.toThrow(
        /UPSTREAM_DISCOVERY_FAILED: strict resources discovery failed for profile 'work': upstream 'sentry'/
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("fails strict prompt discovery with a complete unavailable-upstream diagnostic", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] }
      },
      profiles: { work: { upstreams: { github: { env: { TEST_ACCOUNT_NAME: "github-work" } } } } },
      tooling: { toolDiscoveryMode: "strict" }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.listPrompts()).rejects.toThrow(
        /UPSTREAM_DISCOVERY_FAILED: strict prompts discovery failed for profile 'work': upstream 'sentry'/
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("aggregates namespaced resources and routes each read to its originating upstream", async () => {
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

      expect(client.getServerCapabilities()).toMatchObject({ resources: {}, prompts: {} });
      const resources = await client.listResources();
      expect(resources.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "github__Current account",
            uri: "miftah://resource/github?uri=account%3A%2F%2Fcurrent"
          }),
          expect.objectContaining({
            name: "sentry__Current account",
            uri: "miftah://resource/sentry?uri=account%3A%2F%2Fcurrent"
          })
        ])
      );

      const githubResource = resources.resources.find((resource) => resource.name === "github__Current account");
      const sentryResource = resources.resources.find((resource) => resource.name === "sentry__Current account");
      expect(githubResource).toBeDefined();
      expect(sentryResource).toBeDefined();
      if (!githubResource || !sentryResource) throw new Error("Expected namespaced resources.");

      expect(await client.readResource({ uri: githubResource.uri })).toMatchObject({
        contents: [{ uri: githubResource.uri, text: "github-work" }]
      });
      expect(await client.readResource({ uri: sentryResource.uri })).toMatchObject({
        contents: [{ uri: sentryResource.uri, text: "sentry-work" }]
      });

      const prompts = await client.listPrompts();
      expect(prompts.prompts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "github__account_prompt" }),
          expect.objectContaining({ name: "sentry__account_prompt" })
        ])
      );
      expect(await client.getPrompt({ name: "github__account_prompt" })).toMatchObject({
        messages: [{ content: { text: "github-work" } }]
      });
      expect(await client.getPrompt({ name: "sentry__account_prompt" })).toMatchObject({
        messages: [{ content: { text: "sentry-work" } }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("removes stale routes when a bundled upstream fails resource discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-resource-discovery-failure-"));
    const sentryFailurePath = join(directory, "sentry-resource-failure");
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
            sentry: {
              env: {
                TEST_ACCOUNT_NAME: "sentry-work",
                TEST_FAIL_LIST_RESOURCES_PATH: sentryFailurePath
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

      const initial = await client.listResources();
      const sentryResource = initial.resources.find((resource) => resource.name === "sentry__Current account");
      if (!sentryResource) throw new Error("Expected a Sentry resource route.");

      await writeFile(sentryFailurePath, "fail");
      const partial = await client.listResources();
      expect(partial.resources.map((resource) => resource.name)).toEqual(["github__Current account"]);
      await expect(client.readResource({ uri: sentryResource.uri })).rejects.toThrow(resourceNotFoundPattern);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("removes stale routes when a bundled upstream fails prompt discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-prompt-discovery-failure-"));
    const sentryFailurePath = join(directory, "sentry-prompt-failure");
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
            sentry: {
              env: {
                TEST_ACCOUNT_NAME: "sentry-work",
                TEST_FAIL_LIST_PROMPTS_PATH: sentryFailurePath
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

      const initial = await client.listPrompts();
      expect(initial.prompts.map((prompt) => prompt.name)).toContain("sentry__account_prompt");

      await writeFile(sentryFailurePath, "fail");
      const partial = await client.listPrompts();
      expect(partial.prompts.map((prompt) => prompt.name)).toEqual(["github__account_prompt"]);
      await expect(client.getPrompt({ name: "sentry__account_prompt" })).rejects.toThrow(promptNotFoundPattern);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("notifies clients when partial resource and prompt discovery recovers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-capability-recovery-"));
    const sentryResourceFailurePath = join(directory, "sentry-resource-failure");
    const sentryPromptFailurePath = join(directory, "sentry-prompt-failure");
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
            sentry: {
              env: {
                TEST_ACCOUNT_NAME: "sentry-work",
                TEST_FAIL_LIST_RESOURCES_PATH: sentryResourceFailurePath,
                TEST_FAIL_LIST_PROMPTS_PATH: sentryPromptFailurePath
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
    let resourceNotifications = 0;
    let promptNotifications = 0;
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      resourceNotifications += 1;
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      promptNotifications += 1;
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listResources();
      await client.listPrompts();

      await writeFile(sentryResourceFailurePath, "fail");
      await writeFile(sentryPromptFailurePath, "fail");
      expect((await client.listResources()).resources.map((resource) => resource.name)).toEqual([
        "github__Current account"
      ]);
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(["github__account_prompt"]);
      await expectExactlyOneNotification(() => resourceNotifications);
      await expectExactlyOneNotification(() => promptNotifications);

      resourceNotifications = 0;
      promptNotifications = 0;
      await unlink(sentryResourceFailurePath);
      await unlink(sentryPromptFailurePath);
      expect((await client.listResources()).resources.map((resource) => resource.name)).toEqual([
        "github__Current account",
        "sentry__Current account"
      ]);
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual([
        "github__account_prompt",
        "sentry__account_prompt"
      ]);
      await expectExactlyOneNotification(() => resourceNotifications);
      await expectExactlyOneNotification(() => promptNotifications);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("rejects ambiguous namespaced resource and prompt collisions atomically", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        github__sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          upstreams: {
            github: {
              env: {
                TEST_RESOURCE_NAME: "sentry__Current account",
                TEST_PROMPT_NAME: "sentry__account_prompt"
              }
            },
            github__sentry: {
              env: {
                TEST_RESOURCE_NAME: "Current account",
                TEST_PROMPT_NAME: "account_prompt"
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

      await expect(client.listResources()).rejects.toThrow(resourceCollisionPattern);
      await expect(client.listPrompts()).rejects.toThrow(promptCollisionPattern);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("preserves independent upstream pagination through opaque aggregate cursors", async () => {
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
            github: { env: { TEST_PAGINATE_CAPABILITIES: "true" } },
            sentry: { env: { TEST_PAGINATE_CAPABILITIES: "true" } }
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

      const firstResources = await client.listResources();
      expect(firstResources.resources.map((resource) => resource.name)).toEqual([
        "github__Current account",
        "sentry__Current account"
      ]);
      expect(firstResources.nextCursor).toEqual(expect.any(String));
      expect(firstResources.nextCursor).not.toBe("next");
      if (!firstResources.nextCursor) throw new Error("Expected an aggregate resource cursor.");

      const secondResources = await client.listResources({ cursor: firstResources.nextCursor });
      expect(secondResources.resources.map((resource) => resource.name)).toEqual([
        "github__Second account",
        "sentry__Second account"
      ]);
      expect(secondResources.nextCursor).toBeUndefined();

      const firstPrompts = await client.listPrompts();
      expect(firstPrompts.prompts.map((prompt) => prompt.name)).toEqual([
        "github__account_prompt",
        "sentry__account_prompt"
      ]);
      expect(firstPrompts.nextCursor).toEqual(expect.any(String));
      expect(firstPrompts.nextCursor).not.toBe("next");
      if (!firstPrompts.nextCursor) throw new Error("Expected an aggregate prompt cursor.");

      const secondPrompts = await client.listPrompts({ cursor: firstPrompts.nextCursor });
      expect(secondPrompts.prompts.map((prompt) => prompt.name)).toEqual([
        "github__second_prompt",
        "sentry__second_prompt"
      ]);
      expect(secondPrompts.nextCursor).toBeUndefined();
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("notifies clients to re-list aggregated resources and prompts after a profile change", async () => {
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
            github: { env: { TEST_ACCOUNT_NAME: "github-work", TEST_PAGINATE_CAPABILITIES: "true" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work", TEST_PAGINATE_CAPABILITIES: "true" } }
          }
        },
        personal: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-personal" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-personal" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    let resourceNotifications = 0;
    let promptNotifications = 0;
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      resourceNotifications += 1;
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      promptNotifications += 1;
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(client.getServerCapabilities()).toMatchObject({
        resources: { listChanged: true },
        prompts: { listChanged: true }
      });
      const workResources = await client.listResources();
      const workPrompts = await client.listPrompts();
      if (!workResources.nextCursor || !workPrompts.nextCursor) {
        throw new Error("Expected work-profile aggregate cursors.");
      }
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      await expectExactlyOneNotification(() => resourceNotifications);
      await expectExactlyOneNotification(() => promptNotifications);

      const resources = await client.listResources();
      const githubResource = resources.resources.find((resource) => resource.name === "github__Current account");
      expect(githubResource).toBeDefined();
      if (!githubResource) throw new Error("Expected a namespaced GitHub resource.");
      expect(await client.readResource({ uri: githubResource.uri })).toMatchObject({
        contents: [{ uri: githubResource.uri, text: "github-personal" }]
      });
      expect(await client.getPrompt({ name: "github__account_prompt" })).toMatchObject({
        messages: [{ content: { text: "github-personal" } }]
      });
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "work" } });
      await expect(client.listResources({ cursor: workResources.nextCursor })).rejects.toThrow(resourceCursorInvalidPattern);
      await expect(client.listPrompts({ cursor: workPrompts.nextCursor })).rejects.toThrow(promptCursorInvalidPattern);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("redacts configured and URI-embedded credentials before publishing a namespaced resource URI", async () => {
    const secret = "resource-uri-secret";
    const username = "resource-uri-user";
    const password = "resource-uri-password";
    const queryValue = "resource-uri-query-value";
    const fragment = "resource-uri-fragment";
    const credentialUri = `account://${username}:${password}@current?access_token=${secret}&state=${queryValue}#${fragment}`;
    const iconUri = `https://${username}:${password}@icons.example?access_token=${secret}&state=${queryValue}#${fragment}`;
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
            github: {
              env: {
                API_TOKEN: secret,
                TEST_ACCOUNT_NAME: "github-work",
                TEST_RESOURCE_URI: credentialUri,
                TEST_ADDITIONAL_RESOURCE_URI: credentialUri.replace("@current", "@secondary"),
                TEST_RESOURCE_ICON_URI: iconUri,
                TEST_PROMPT_ICON_URI: iconUri,
                TEST_PROMPT_RESOURCE_URI: credentialUri
              }
            },
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

      const resources = await client.listResources();
      const githubResource = resources.resources.find((resource) => resource.name === "github__Current account");
      expect(githubResource).toBeDefined();
      if (!githubResource) throw new Error("Expected a namespaced GitHub resource.");
      const publicResources = JSON.stringify(resources);
      for (const value of [secret, username, password, queryValue, fragment]) {
        expect(publicResources).not.toContain(value);
      }
      const encodedUpstreamUri = new URL(githubResource.uri).searchParams.get("uri");
      expect(encodedUpstreamUri).toBeDefined();
      expect(decodeURIComponent(encodedUpstreamUri ?? "")).toContain("[REDACTED]");
      const read = await client.readResource({ uri: githubResource.uri });
      expect(read.contents[0]).toMatchObject({ uri: githubResource.uri, text: "github-work" });
      const additionalResourceUri = read.contents[1]?.uri;
      expect(additionalResourceUri).toMatch(githubResourceRoutePattern);
      const publicRead = JSON.stringify(read);
      for (const value of [secret, username, password, queryValue, fragment]) {
        expect(publicRead).not.toContain(value);
      }
      const prompts = await client.listPrompts();
      const publicPrompts = JSON.stringify(prompts);
      for (const value of [secret, username, password, queryValue, fragment]) {
        expect(publicPrompts).not.toContain(value);
      }
      const prompt = await client.getPrompt({ name: "github__account_prompt" });
      const publicPrompt = JSON.stringify(prompt);
      for (const value of [secret, username, password, queryValue, fragment]) {
        expect(publicPrompt).not.toContain(value);
      }
      const linkedResource = prompt.messages.find((message) => message.content.type === "resource_link")?.content;
      expect(linkedResource).toMatchObject({ uri: githubResource.uri });
      if (!linkedResource || linkedResource.type !== "resource_link") {
        throw new Error("Expected a resource link in the prompt result.");
      }
      const linkedRead = await client.readResource({ uri: linkedResource.uri });
      expect(linkedRead.contents[0]).toMatchObject({ uri: linkedResource.uri, text: "github-work" });
      if (!additionalResourceUri) throw new Error("Expected an additional resource URI.");
      const additionalRead = await client.readResource({ uri: additionalResourceUri });
      expect(additionalRead.contents[0]).toMatchObject({ uri: githubResource.uri, text: "github-work" });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("uses controlled discovery to route cold namespaced reads and prompt gets exactly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-cold-resource-prompt-"));
    const githubReadPath = join(directory, "github-read-count");
    const sentryReadPath = join(directory, "sentry-read-count");
    const githubPromptPath = join(directory, "github-prompt-count");
    const sentryPromptPath = join(directory, "sentry-prompt-count");
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
            github: {
              env: {
                TEST_ACCOUNT_NAME: "github-work",
                TEST_READ_RESOURCE_COUNT_PATH: githubReadPath,
                TEST_GET_PROMPT_COUNT_PATH: githubPromptPath
              }
            },
            sentry: {
              env: {
                TEST_ACCOUNT_NAME: "sentry-work",
                TEST_READ_RESOURCE_COUNT_PATH: sentryReadPath,
                TEST_GET_PROMPT_COUNT_PATH: sentryPromptPath
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
    const githubResourceUri = "miftah://resource/github?uri=account%3A%2F%2Fcurrent";

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.readResource({ uri: githubResourceUri })).toMatchObject({
        contents: [{ uri: githubResourceUri, text: "github-work" }]
      });
      expect(await client.getPrompt({ name: "github__account_prompt" })).toMatchObject({
        messages: [{ content: { text: "github-work" } }]
      });
      await expect(client.readResource({ uri: "miftah://resource/github?uri=account%3A%2F%2Funknown" })).rejects.toThrow(
        resourceNotFoundPattern
      );
      await expect(client.getPrompt({ name: "github__unknown_prompt" })).rejects.toThrow(promptNotFoundPattern);
      expect((await readFile(githubReadPath, "utf8")).trim().split("\n")).toEqual(["1"]);
      expect((await readFile(githubPromptPath, "utf8")).trim().split("\n")).toEqual(["1"]);
      await expect(access(sentryReadPath)).rejects.toThrow();
      await expect(access(sentryPromptPath)).rejects.toThrow();
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
            github: { env: { TEST_ACCOUNT_NAME: "github-work", TEST_PAGINATE_CAPABILITIES: "true" } }
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
      const firstResources = await client.listResources();
      expect(firstResources).toMatchObject({
        resources: [{ uri: "account://current" }],
        nextCursor: "next"
      });
      expect(await client.listResources({ cursor: firstResources.nextCursor })).toMatchObject({
        resources: [{ uri: "account://second" }]
      });
      expect(await client.readResource({ uri: "account://current" })).toMatchObject({
        contents: [{ text: "github-work" }]
      });
      const firstPrompts = await client.listPrompts();
      expect(firstPrompts).toMatchObject({
        prompts: [{ name: "account_prompt" }],
        nextCursor: "next"
      });
      expect(await client.listPrompts({ cursor: firstPrompts.nextCursor })).toMatchObject({
        prompts: [{ name: "second_prompt" }]
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

  it("restarts every upstream in a profile bundle and invalidates its tool snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-bundle-restart-"));
    const githubCountPath = join(directory, "github-tools-list-count");
    const sentryCountPath = join(directory, "sentry-tools-list-count");
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
            github: {
              env: {
                TEST_ACCOUNT_NAME: "github-work",
                TEST_LIST_TOOLS_COUNT_PATH: githubCountPath
              }
            },
            sentry: {
              env: {
                TEST_ACCOUNT_NAME: "sentry-work",
                TEST_LIST_TOOLS_COUNT_PATH: sentryCountPath
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
    let notifications = 0;
    let resourceNotifications = 0;
    let promptNotifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      resourceNotifications += 1;
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      promptNotifications += 1;
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.listTools();
      const beforePids = manager.listHealth().map((health) => health.pid);
      expect(beforePids).toHaveLength(2);
      expect(beforePids.every((pid): pid is number => typeof pid === "number")).toBe(true);

      const restarted = CallToolResultSchema.parse(
        await client.callTool({ name: "miftah_restart_profile", arguments: { profile: "work" } }, CallToolResultSchema)
      );
      expect(restarted.isError).not.toBe(true);
      await client.listTools();

      const afterPids = manager.listHealth().map((health) => health.pid);
      expect(afterPids).toHaveLength(2);
      expect(afterPids.every((pid): pid is number => typeof pid === "number")).toBe(true);
      expect(afterPids.every((pid, index) => pid !== beforePids[index])).toBe(true);
      expect((await readFile(githubCountPath, "utf8")).trim().split("\n")).toEqual(["1", "1"]);
      expect((await readFile(sentryCountPath, "utf8")).trim().split("\n")).toEqual(["1", "1"]);
      await expectExactlyOneNotification(() => notifications);
      await expectExactlyOneNotification(() => resourceNotifications);
      await expectExactlyOneNotification(() => promptNotifications);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("recovers healthy tool discovery after a partial multi-upstream restart failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-bundle-restart-failure-"));
    const githubFailurePath = join(directory, "github-restart-failure");
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
            github: {
              env: {
                TEST_ACCOUNT_NAME: "github-work",
                TEST_FAIL_ON_RESTART_PATH: githubFailurePath
              }
            },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
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
      const restarted = CallToolResultSchema.parse(
        await client.callTool({ name: "miftah_restart_profile", arguments: { profile: "work" } }, CallToolResultSchema)
      );
      expect(restarted.isError).toBe(true);
      const partial = await client.listTools();
      expect(partial.tools.map((tool) => tool.name)).toContain("sentry__whoami");
      expect(partial.tools.map((tool) => tool.name)).not.toContain("github__whoami");
      await expectExactlyOneNotification(() => notifications);

      notifications = 0;
      await unlink(githubFailurePath);
      expect(await client.callTool({ name: "sentry__whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "sentry-work" }]
      });
      await expectExactlyOneNotification(() => notifications);
      const recovered = await client.listTools();
      expect(recovered.tools.map((tool) => tool.name)).toContain("github__whoami");
      expect(recovered.tools.map((tool) => tool.name)).toContain("sentry__whoami");
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("refreshes the tool registry after an upstream crashes and later recovers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-upstream-crash-recovery-"));
    const sentryCrashPath = join(directory, "sentry-crash");
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
            sentry: {
              env: {
                TEST_ACCOUNT_NAME: "sentry-work",
                TEST_CRASH_ON_CALL_TOOL_PATH: sentryCrashPath
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
    let notifications = 0;
    let resourceNotifications = 0;
    let promptNotifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      resourceNotifications += 1;
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      promptNotifications += 1;
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();
      await client.listResources();
      await client.listPrompts();

      await writeFile(sentryCrashPath, "crash");
      expect(await client.callTool({ name: "sentry__whoami", arguments: {} })).toMatchObject({ isError: true });
      await expect
        .poll(() => manager.listHealth().find((health) => health.upstreamName === "sentry")?.state)
        .toBe("failed");

      const partial = await client.listTools();
      expect(partial.tools.map((tool) => tool.name)).toContain("github__whoami");
      expect(partial.tools.map((tool) => tool.name)).not.toContain("sentry__whoami");
      expect((await client.listResources()).resources.map((resource) => resource.name)).toEqual([
        "github__Current account"
      ]);
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(["github__account_prompt"]);
      await expectExactlyOneNotification(() => notifications);
      await expectExactlyOneNotification(() => resourceNotifications);
      await expectExactlyOneNotification(() => promptNotifications);

      notifications = 0;
      resourceNotifications = 0;
      promptNotifications = 0;
      await unlink(sentryCrashPath);
      const recovered = await client.listTools();
      expect(recovered.tools.map((tool) => tool.name)).toContain("github__whoami");
      expect(recovered.tools.map((tool) => tool.name)).toContain("sentry__whoami");
      expect((await client.listResources()).resources.map((resource) => resource.name)).toEqual([
        "github__Current account",
        "sentry__Current account"
      ]);
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual([
        "github__account_prompt",
        "sentry__account_prompt"
      ]);
      expect(manager.listHealth().find((health) => health.upstreamName === "sentry")).toMatchObject({
        state: "running",
        processState: "running",
        restartCount: expect.any(Number)
      });
      await expectExactlyOneNotification(() => notifications);
      await expectExactlyOneNotification(() => resourceNotifications);
      await expectExactlyOneNotification(() => promptNotifications);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("waits for every bundled restart to settle before returning a restart failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-bundle-restart-settle-"));
    const githubFailurePath = join(directory, "github-restart-failure");
    const sentryBlockPath = join(directory, "sentry-restart-block");
    const sentryReadyPath = join(directory, "sentry-restart-ready");
    const sentryReleasePath = join(directory, "sentry-restart-release");
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
            github: {
              env: {
                TEST_ACCOUNT_NAME: "github-work",
                TEST_FAIL_ON_RESTART_PATH: githubFailurePath
              }
            },
            sentry: {
              env: {
                TEST_ACCOUNT_NAME: "sentry-work",
                TEST_BLOCK_ON_RESTART_PATH: sentryBlockPath,
                TEST_BLOCK_ON_RESTART_READY_PATH: sentryReadyPath,
                TEST_BLOCK_ON_RESTART_RELEASE_PATH: sentryReleasePath
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

      await client.listTools();
      const restart = client.callTool(
        { name: "miftah_restart_profile", arguments: { profile: "work" } },
        CallToolResultSchema
      );
      await expect
        .poll(async () => {
          try {
            await access(sentryReadyPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);

      const restartState = await Promise.race([
        restart.then(() => "settled"),
        delay(50).then(() => "pending")
      ]);
      expect(restartState).toBe("pending");

      await writeFile(sentryReleasePath, "release");
      const result = CallToolResultSchema.parse(await restart);
      expect(result.isError).toBe(true);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("sentry__whoami");
      expect(tools.tools.map((tool) => tool.name)).not.toContain("github__whoami");
    } finally {
      await writeFile(sentryReleasePath, "release");
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
