import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuditTrail } from "../src/audit/audit-trail.js";
import { validateConfig } from "../src/config/validate-config.js";
import { IdentityManager } from "../src/identity/identity-manager.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { OperationPipeline } from "../src/mcp/server/operation-pipeline.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { RoutingEngine } from "../src/routing/routing-engine.js";
import type { RoutingContextSnapshot } from "../src/routing/routing-types.js";
import { SecretRedactor } from "../src/secrets/redact.js";
import { MultiUpstreamProcessManager } from "../src/upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

describe("operation pipeline", () => {
  it("blocks a configured risky operation before forwarding it when identity mismatches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-identity-mismatch-"));
    const createCountPath = join(directory, "create-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "personal",
            TEST_INCLUDE_IDENTITY_TOOL: "true",
            TEST_IDENTITY_RESPONSE: "personal",
            TEST_CREATE_ITEM_COUNT_PATH: createCountPath
          },
          identity: {
            expected: { login: "work" },
            probe: { tool: "identity", resultFormat: "text" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write"]
          }
        }
      },
      tooling: { toolRiskOverrides: { identity: "read" } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "create_item", arguments: { name: "x" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("IDENTITY_MISMATCH") }]
      });
      await expect(access(createCountPath)).rejects.toThrow();
    } finally {
      try {
        await client.close();
      } finally {
        try {
          await wrapper.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  });

  it("records a safe verified identity status for a protected operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-identity-audit-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_INCLUDE_IDENTITY_TOOL: "true",
            TEST_IDENTITY_RESPONSE: JSON.stringify({ login: "work", untrusted: "must-not-be-audited" })
          },
          identity: {
            expected: { login: "work" },
            probe: { tool: "identity", resultFormat: "json" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write"]
          }
        }
      },
      tooling: { toolRiskOverrides: { identity: "read" } },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "create_item", arguments: { name: "x" } })).toMatchObject({
        content: [{ type: "text", text: "created:x" }]
      });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const operation = events.find((event) => event.kind === "operation" && event.name === "create_item");
      expect(operation).toMatchObject({
        identity: {
          status: "verified",
          profile: "work",
          upstream: "default",
          expected: { login: "work" },
          actual: { login: "work" }
        }
      });
      expect(JSON.stringify(operation)).not.toContain("must-not-be-audited");
    } finally {
      try {
        await client.close();
      } finally {
        try {
          await wrapper.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  });

  it("verifies named upstream writes against their exact override or inherited identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-multi-upstream-identity-"));
    const githubCreateCountPath = join(directory, "github-create-count");
    const sentryCreateCountPath = join(directory, "sentry-create-count");
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          identity: {
            expected: { login: "work" },
            probe: { tool: "identity", resultFormat: "json" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write"]
          },
          upstreams: {
            github: {
              env: {
                TEST_INCLUDE_IDENTITY_TOOL: "true",
                TEST_IDENTITY_RESPONSE: JSON.stringify({ login: "github-work" }),
                TEST_CREATE_ITEM_COUNT_PATH: githubCreateCountPath
              },
              identity: {
                expected: { login: "github-work" },
                probe: { tool: "identity", resultFormat: "json" },
                maxAgeMs: 60_000,
                requiredForRisk: ["write"]
              }
            },
            sentry: {
              env: {
                TEST_INCLUDE_IDENTITY_TOOL: "true",
                TEST_IDENTITY_RESPONSE: JSON.stringify({ login: "work" }),
                TEST_CREATE_ITEM_COUNT_PATH: sentryCreateCountPath
              }
            }
          }
        }
      },
      tooling: { toolRiskOverrides: { identity: "read" } },
      audit: { path: auditPath }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "github__create_item", arguments: { name: "github-item" } })).toMatchObject({
        content: [{ type: "text", text: "created:github-item" }]
      });
      expect(await client.callTool({ name: "sentry__create_item", arguments: { name: "sentry-item" } })).toMatchObject({
        content: [{ type: "text", text: "created:sentry-item" }]
      });
      expect(await readFile(githubCreateCountPath, "utf8")).toBe("1\n");
      expect(await readFile(sentryCreateCountPath, "utf8")).toBe("1\n");

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "operation" && event.operation === "tools/call");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "create_item",
            upstream: "github",
            identity: expect.objectContaining({
              status: "verified",
              expected: { login: "github-work" },
              actual: { login: "github-work" }
            })
          }),
          expect.objectContaining({
            name: "create_item",
            upstream: "sentry",
            identity: expect.objectContaining({
              status: "verified",
              expected: { login: "work" },
              actual: { login: "work" }
            })
          })
        ])
      );
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks confirmation-required proxied operations before forwarding them upstream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-confirm-"));
    const toolCountPath = join(directory, "tool-count");
    const resourceCountPath = join(directory, "resource-count");
    const promptCountPath = join(directory, "prompt-count");
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
            TEST_CALL_TOOL_COUNT_PATH: toolCountPath,
            TEST_READ_RESOURCE_COUNT_PATH: resourceCountPath,
            TEST_GET_PROMPT_COUNT_PATH: promptCountPath
          },
          policy: "confirm"
        }
      },
      policies: {
        confirm: {
          requireConfirmation: ["create_item", "resources/read", "prompts/get"]
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

      expect(await client.callTool({ name: "create_item", arguments: { name: "x" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("POLICY_CONFIRMATION_REQUIRED") }]
      });
      await expect(client.readResource({ uri: "account://current" })).rejects.toThrow(/POLICY_CONFIRMATION_REQUIRED/);
      await expect(client.getPrompt({ name: "account_prompt" })).rejects.toThrow(/POLICY_CONFIRMATION_REQUIRED/);
      await expect(access(toolCountPath)).rejects.toThrow();
      await expect(access(resourceCountPath)).rejects.toThrow();
      await expect(access(promptCountPath)).rejects.toThrow();
      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "operation");
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "tools/call", status: "confirmation-required", policyDecision: "confirm" }),
          expect.objectContaining({ operation: "resources/read", status: "confirmation-required", policyDecision: "confirm" }),
          expect.objectContaining({ operation: "prompts/get", status: "confirmation-required", policyDecision: "confirm" })
        ])
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("records blocked policy decisions for every proxied operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-deny-audit-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: "work" },
          policy: "readonly"
        }
      },
      policies: {
        readonly: {
          deny: ["create_item", "resources/read", "prompts/get"]
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

      await client.callTool({ name: "create_item", arguments: { name: "x" } });
      await expect(client.readResource({ uri: "account://current" })).rejects.toThrow(/POLICY_BLOCKED/);
      await expect(client.getPrompt({ name: "account_prompt" })).rejects.toThrow(/POLICY_BLOCKED/);

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "operation");
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "tools/call",
            status: "denied",
            policyDecision: "deny",
            routingReason: "active-profile"
          }),
          expect.objectContaining({
            operation: "resources/read",
            status: "denied",
            policyDecision: "deny",
            routingReason: "active-profile"
          }),
          expect.objectContaining({
            operation: "prompts/get",
            status: "denied",
            policyDecision: "deny",
            routingReason: "active-profile"
          })
        ])
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("rejects ambiguous resource and prompt routes before forwarding them upstream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-ambiguous-"));
    const oneToolCountPath = join(directory, "one-tool-count");
    const twoToolCountPath = join(directory, "two-tool-count");
    const oneResourceCountPath = join(directory, "one-resource-count");
    const twoResourceCountPath = join(directory, "two-resource-count");
    const onePromptCountPath = join(directory, "one-prompt-count");
    const twoPromptCountPath = join(directory, "two-prompt-count");
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "one",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        one: {
          env: {
            TEST_ACCOUNT_NAME: "one",
            TEST_CALL_TOOL_COUNT_PATH: oneToolCountPath,
            TEST_READ_RESOURCE_COUNT_PATH: oneResourceCountPath,
            TEST_GET_PROMPT_COUNT_PATH: onePromptCountPath
          }
        },
        two: {
          env: {
            TEST_ACCOUNT_NAME: "two",
            TEST_CALL_TOOL_COUNT_PATH: twoToolCountPath,
            TEST_READ_RESOURCE_COUNT_PATH: twoResourceCountPath,
            TEST_GET_PROMPT_COUNT_PATH: twoPromptCountPath
          }
        }
      },
      routing: {
        rules: [
          { name: "tool-one", when: { "args.target": "ambiguous" }, profile: "one" },
          { name: "tool-two", when: { "args.target": "ambiguous" }, profile: "two" },
          { name: "resource-one", when: { "args.uri": "account://current" }, profile: "one" },
          { name: "resource-two", when: { "args.uri": "account://current" }, profile: "two" },
          { name: "prompt-one", when: { "args.name": "account_prompt" }, profile: "one" },
          { name: "prompt-two", when: { "args.name": "account_prompt" }, profile: "two" }
        ]
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "whoami", arguments: { target: "ambiguous" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("ROUTING_AMBIGUOUS") }]
      });
      await expect(client.readResource({ uri: "account://current" })).rejects.toThrow(/ROUTING_AMBIGUOUS/);
      await expect(client.getPrompt({ name: "account_prompt" })).rejects.toThrow(/ROUTING_AMBIGUOUS/);
      await expect(access(oneToolCountPath)).rejects.toThrow();
      await expect(access(twoToolCountPath)).rejects.toThrow();
      await expect(access(oneResourceCountPath)).rejects.toThrow();
      await expect(access(twoResourceCountPath)).rejects.toThrow();
      await expect(access(onePromptCountPath)).rejects.toThrow();
      await expect(access(twoPromptCountPath)).rejects.toThrow();
      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "operation");
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "tools/call", status: "ambiguous", errorCode: "ROUTING_AMBIGUOUS" }),
          expect.objectContaining({ operation: "resources/read", status: "ambiguous", errorCode: "ROUTING_AMBIGUOUS" }),
          expect.objectContaining({ operation: "prompts/get", status: "ambiguous", errorCode: "ROUTING_AMBIGUOUS" })
        ])
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("does not forward destructive calls when project context profile hints conflict", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-context-ambiguous-"));
    const toolCountPath = join(directory, "tool-count");
    const auditPath = join(directory, "audit.jsonl");
    const snapshot: RoutingContextSnapshot = {
      context: {},
      evidence: {
        cwd: join(directory, "project"),
        fileRoots: [],
        marker: { path: join(directory, "project", ".miftahrc.json") }
      },
      profileHints: [
        {
          profile: "work",
          source: "project-marker",
          evidence: { kind: "marker", path: join(directory, "work", ".miftahrc.json") }
        },
        {
          profile: "personal",
          source: "project-marker",
          evidence: { kind: "marker", path: join(directory, "personal", ".miftahrc.json") }
        }
      ]
    };
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_CALL_TOOL_COUNT_PATH: toolCountPath
          }
        },
        personal: {
          env: {
            TEST_ACCOUNT_NAME: "personal",
            TEST_CALL_TOOL_COUNT_PATH: toolCountPath
          }
        }
      },
      tooling: { toolRiskOverrides: { create_item: "destructive" } },
      security: { requireExplicitProfileForDestructive: true },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager, async () => snapshot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "create_item", arguments: { name: "x" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("ROUTING_AMBIGUOUS") }]
      });
      await expect(access(toolCountPath)).rejects.toThrow();

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.find((event) => event.kind === "operation" && event.operation === "tools/call")).toMatchObject({
        status: "ambiguous",
        errorCode: "ROUTING_AMBIGUOUS",
        routingEvidence: snapshot.evidence
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("routes resource reads and prompt retrieval to the selected profile", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      routing: {
        rules: [
          { name: "personal-resource", when: { "args.uri": "account://current" }, profile: "personal" },
          { name: "personal-prompt", when: { "args.name": "account_prompt" }, profile: "personal" }
        ]
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.readResource({ uri: "account://current" })).toMatchObject({
        contents: [{ text: "personal" }]
      });
      expect(await client.getPrompt({ name: "account_prompt" })).toMatchObject({
        messages: [{ content: { text: "personal" } }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("records consistent routing and policy metadata for successful proxied operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-audit-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } }
      },
      audit: { path: auditPath, includeArguments: true }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.callTool({ name: "whoami", arguments: {} });
      await client.readResource({ uri: "account://current" });
      await client.getPrompt({ name: "account_prompt" });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "operation");
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "tools/call",
            name: "whoami",
            status: "success",
            profile: "work",
            upstream: "default",
            routingReason: "active-profile",
            policyDecision: "allow",
            risk: "read",
            arguments: {}
          }),
          expect.objectContaining({
            operation: "resources/read",
            name: "account://current",
            status: "success",
            profile: "work",
            upstream: "default",
            routingReason: "active-profile",
            policyDecision: "allow",
            risk: "read",
            arguments: { uri: "account://current" }
          }),
          expect.objectContaining({
            operation: "prompts/get",
            name: "account_prompt",
            status: "success",
            profile: "work",
            upstream: "default",
            routingReason: "active-profile",
            policyDecision: "allow",
            risk: "read",
            arguments: { name: "account_prompt" }
          })
        ])
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("redacts secret output from tools, resources, and prompts", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            API_TOKEN: "hidden-token",
            TEST_INCLUDE_RESPONSE_TOKEN: "true"
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

      expect(await client.callTool({ name: "echo", arguments: { message: "hidden-token" } })).toMatchObject({
        content: [{ type: "text", text: "[REDACTED]" }]
      });
      expect(await client.readResource({ uri: "account://current" })).toMatchObject({
        contents: [{ text: "work:[REDACTED]" }]
      });
      expect(await client.getPrompt({ name: "account_prompt" })).toMatchObject({
        messages: [{ content: { text: "work:[REDACTED]" } }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("redacts and audits upstream failures for every proxied operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-failure-"));
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
            API_TOKEN: "hidden-token",
            TEST_FAIL_CALL_TOOL: "true",
            TEST_FAIL_READ_RESOURCE: "true",
            TEST_FAIL_GET_PROMPT: "true"
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

      const toolFailure = await client.callTool({ name: "whoami", arguments: {} });
      expect(toolFailure).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("UPSTREAM_CALL_FAILED") }]
      });
      expect(JSON.stringify(toolFailure)).not.toContain("hidden-token");
      await expect(client.readResource({ uri: "account://current" })).rejects.toThrow(
        /UPSTREAM_CALL_FAILED.*\[REDACTED\]/
      );
      await expect(client.getPrompt({ name: "account_prompt" })).rejects.toThrow(
        /UPSTREAM_CALL_FAILED.*\[REDACTED\]/
      );

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "operation");
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "tools/call", status: "failure", errorCode: "UPSTREAM_CALL_FAILED" }),
          expect.objectContaining({
            operation: "resources/read",
            status: "failure",
            errorCode: "UPSTREAM_CALL_FAILED"
          }),
          expect.objectContaining({ operation: "prompts/get", status: "failure", errorCode: "UPSTREAM_CALL_FAILED" })
        ])
      );
      expect(JSON.stringify(events)).not.toContain("hidden-token");
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("keeps in-flight resource and prompt operations bound to their captured profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-switch-race-"));
    const resourceStartedPath = join(directory, "resource-started");
    const promptStartedPath = join(directory, "prompt-started");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_READ_RESOURCE_STARTED_PATH: resourceStartedPath,
            TEST_READ_RESOURCE_DELAY_MS: "100",
            TEST_GET_PROMPT_STARTED_PATH: promptStartedPath,
            TEST_GET_PROMPT_DELAY_MS: "100"
          }
        },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const resource = client.readResource({ uri: "account://current" });
      await expect
        .poll(async () => {
          try {
            await access(resourceStartedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      expect(await resource).toMatchObject({ contents: [{ text: "work" }] });

      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "work" } });
      const prompt = client.getPrompt({ name: "account_prompt" });
      await expect
        .poll(async () => {
          try {
            await access(promptStartedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      expect(await prompt).toMatchObject({ messages: [{ content: { text: "work" } }] });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("completes in-flight aggregate reads and prompts after a profile switch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-aggregate-switch-race-"));
    const resourceStartedPath = join(directory, "resource-started");
    const promptStartedPath = join(directory, "prompt-started");
    const config = validateConfig({
      version: "1",
      name: "accounts",
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
                TEST_READ_RESOURCE_STARTED_PATH: resourceStartedPath,
                TEST_READ_RESOURCE_DELAY_MS: "100",
                TEST_ADDITIONAL_RESOURCE_URI: "account://linked",
                TEST_GET_PROMPT_STARTED_PATH: promptStartedPath,
                TEST_GET_PROMPT_DELAY_MS: "100"
              }
            },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work" } }
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

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const resources = await client.listResources();
      const githubResource = resources.resources.find((resource) => resource.name === "github__Current account");
      if (!githubResource) throw new Error("Expected a namespaced GitHub resource.");
      await client.listPrompts();

      const resource = client.readResource({ uri: githubResource.uri });
      await expect
        .poll(async () => {
          try {
            await access(resourceStartedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      const resourceResult = await resource;
      expect(resourceResult.contents[0]).toMatchObject({ uri: githubResource.uri, text: "github-work" });
      const linkedResource = resourceResult.contents[1];
      if (!linkedResource) throw new Error("Expected a linked resource.");

      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "work" } });
      await expect(client.readResource({ uri: linkedResource.uri })).rejects.toThrow(/RESOURCE_NOT_FOUND/);
      const prompt = client.getPrompt({ name: "github__account_prompt" });
      await expect
        .poll(async () => {
          try {
            await access(promptStartedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      expect(await prompt).toMatchObject({
        messages: [{ content: { text: "github-work" } }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("retries cold aggregate route discovery against the captured profile after a switch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-cold-aggregate-switch-race-"));
    const resourceListStartedPath = join(directory, "resource-list-started");
    const promptListStartedPath = join(directory, "prompt-list-started");
    const config = validateConfig({
      version: "1",
      name: "accounts",
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
                TEST_LIST_RESOURCES_STARTED_PATH: resourceListStartedPath,
                TEST_LIST_RESOURCES_DELAY_MS: "100",
                TEST_LIST_PROMPTS_STARTED_PATH: promptListStartedPath,
                TEST_LIST_PROMPTS_DELAY_MS: "100"
              }
            },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work" } }
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

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const resource = client.readResource({
        uri: "miftah://resource/github?uri=account%3A%2F%2Fcurrent"
      });
      await expect
        .poll(async () => {
          try {
            await access(resourceListStartedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      expect(await resource).toMatchObject({
        contents: [{ text: "github-work" }]
      });

      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "work" } });
      const prompt = client.getPrompt({ name: "github__account_prompt" });
      await expect
        .poll(async () => {
          try {
            await access(promptListStartedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      expect(await prompt).toMatchObject({
        messages: [{ content: { text: "github-work" } }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("checks aggregate resource and prompt policy before discovering upstream routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-aggregate-deny-"));
    const githubResourceListPath = join(directory, "github-resource-list");
    const sentryResourceListPath = join(directory, "sentry-resource-list");
    const githubPromptListPath = join(directory, "github-prompt-list");
    const sentryPromptListPath = join(directory, "sentry-prompt-list");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          policy: "readonly",
          upstreams: {
            github: {
              env: {
                TEST_ACCOUNT_NAME: "github",
                TEST_LIST_RESOURCES_COUNT_PATH: githubResourceListPath,
                TEST_LIST_PROMPTS_COUNT_PATH: githubPromptListPath
              }
            },
            sentry: {
              env: {
                TEST_ACCOUNT_NAME: "sentry",
                TEST_LIST_RESOURCES_COUNT_PATH: sentryResourceListPath,
                TEST_LIST_PROMPTS_COUNT_PATH: sentryPromptListPath
              }
            }
          }
        }
      },
      policies: {
        readonly: { deny: ["resources/read", "prompts/get"] }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.readResource({ uri: "miftah://resource/github?uri=account%3A%2F%2Fcurrent" })).rejects.toThrow(
        /POLICY_BLOCKED/
      );
      await expect(client.getPrompt({ name: "github__account_prompt" })).rejects.toThrow(/POLICY_BLOCKED/);
      await expect(access(githubResourceListPath)).rejects.toThrow();
      await expect(access(sentryResourceListPath)).rejects.toThrow();
      await expect(access(githubPromptListPath)).rejects.toThrow();
      await expect(access(sentryPromptListPath)).rejects.toThrow();
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("redacts credential-bearing resource URIs before writing audit metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-uri-audit-"));
    const auditPath = join(directory, "audit.jsonl");
    const username = "audit-uri-user";
    const password = "audit-uri-password";
    const queryValue = "audit-uri-query";
    const fragment = "audit-uri-fragment";
    const credentialUri = `account://${username}:${password}@current?access_token=hidden-token&state=${queryValue}#${fragment}`;
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work", API_TOKEN: "hidden-token" } }
      },
      audit: { path: auditPath, includeArguments: true }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.readResource({ uri: credentialUri });

      const audit = await readFile(auditPath, "utf8");
      for (const value of [username, password, "hidden-token", queryValue, fragment]) {
        expect(audit).not.toContain(value);
      }
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("redacts credential-bearing unknown resource URIs in diagnostics", async () => {
    const username = "diagnostic-uri-user";
    const password = "diagnostic-uri-password";
    const queryValue = "diagnostic-uri-query";
    const fragment = "diagnostic-uri-fragment";
    const credentialUri = `account://${username}:${password}@current?access_token=hidden-token&state=${queryValue}#${fragment}`;
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry" } }
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

      let failure: unknown;
      try {
        await client.readResource({ uri: credentialUri });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      const message = String(failure);
      expect(message).toContain("RESOURCE_NOT_FOUND");
      for (const value of [username, password, "hidden-token", queryValue, fragment]) {
        expect(message).not.toContain(value);
      }
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("redacts sensitive URI components from direct resource and prompt metadata", async () => {
    const username = "direct-uri-user";
    const password = "direct-uri-password";
    const token = "direct-uri-token";
    const queryValue = "direct-uri-query";
    const fragment = "direct-uri-fragment";
    const credentialUri = `account://${username}:${password}@current?access_token=${token}&state=${queryValue}#${fragment}`;
    const iconUri = `https://${username}:${password}@icons.example?access_token=${token}&state=${queryValue}#${fragment}`;
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_URI: credentialUri,
            TEST_RESOURCE_ICON_URI: iconUri,
            TEST_PROMPT_ICON_URI: iconUri,
            TEST_PROMPT_RESOURCE_URI: credentialUri
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

      const resources = await client.listResources();
      const read = await client.readResource({ uri: credentialUri });
      const prompts = await client.listPrompts();
      const prompt = await client.getPrompt({ name: "account_prompt" });
      const publicOutput = JSON.stringify({ resources, read, prompts, prompt });
      for (const value of [username, password, token, queryValue, fragment]) {
        expect(publicOutput).not.toContain(value);
      }
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("redacts credential-bearing URIs from direct resource and prompt errors", async () => {
    const username = "direct-error-user";
    const password = "direct-error-password";
    const token = "direct-error-token";
    const queryValue = "direct-error-query";
    const fragment = "direct-error-fragment";
    const credentialUri = `account://${username}:${password}@current?access_token=${token}&state=${queryValue}#${fragment}`;
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_FAIL_READ_RESOURCE: "true",
            TEST_FAIL_GET_PROMPT: "true",
            TEST_ERROR_URI: credentialUri
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

      for (const operation of [
        () => client.readResource({ uri: "account://current" }),
        () => client.getPrompt({ name: "account_prompt" })
      ]) {
        let failure: unknown;
        try {
          await operation();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        const message = String(failure);
        expect(message).toContain("REDACTED");
        for (const value of [username, password, token, queryValue, fragment]) {
          expect(message).not.toContain(value);
        }
      }
    } finally {
      await client.close();
      await wrapper.close();
    }
  });
});

describe("operation pipeline routed risk", () => {
  it("uses cached target metadata before policy without resolving the target", async () => {
    const profiles = new ProfileManager({
      defaultProfile: "source",
      profiles: { source: { policy: "readonly" }, target: { policy: "readonly" } }
    });
    let targetResolved = false;
    let upstreamRequested = false;
    const pipeline = new OperationPipeline({
      profiles,
      routing: new RoutingEngine({ rules: [{ when: { "args.account": "target" }, profile: "target" }] }, "source"),
      policy: new PolicyEngine({ readonly: { allowRisk: ["read"] } }),
      upstreams: {
        get: async () => {
          upstreamRequested = true;
          throw new Error("The untrusted routed target must be blocked before it is contacted.");
        }
      } as unknown as UpstreamProcessManager,
      redactor: new SecretRedactor(),
      routingContext: async () => ({ context: {}, evidence: { cwd: "", fileRoots: [] }, profileHints: [] }),
      identities: { requiresVerification: () => false } as unknown as IdentityManager
    });
    const audit = new AuditTrail("test").beginOperation({
      operation: "tools/call",
      name: "create_item",
      sourceProfile: "source"
    });

    await expect(
      pipeline.execute(
        {
          source: profiles.current(),
          operation: "tools/call",
          routingName: "create_item",
          policyName: "create_item",
          name: "create_item",
          args: { account: "target" },
          riskMetadata: { trusted: true, annotations: { readOnlyHint: true } },
          riskMetadataForProfile: () => ({ trusted: false, annotations: { readOnlyHint: true } }),
          resolveTarget: async () => {
            targetResolved = true;
            throw new Error("The target must not be resolved before policy blocks it.");
          }
        },
        audit
      )
    ).rejects.toMatchObject({ code: "POLICY_BLOCKED" });

    expect(targetResolved).toBe(false);
    expect(upstreamRequested).toBe(false);
  });
});
