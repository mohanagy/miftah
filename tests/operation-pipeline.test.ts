import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { MultiUpstreamProcessManager } from "../src/upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

describe("operation pipeline", () => {
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
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "tools/call", status: "blocked", policyDecision: "confirm" }),
          expect.objectContaining({ operation: "resources/read", status: "blocked", policyDecision: "confirm" }),
          expect.objectContaining({ operation: "prompts/get", status: "blocked", policyDecision: "confirm" })
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
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "tools/call",
            status: "blocked",
            policyDecision: "deny",
            routingReason: "active-profile"
          }),
          expect.objectContaining({
            operation: "resources/read",
            status: "blocked",
            policyDecision: "deny",
            routingReason: "active-profile"
          }),
          expect.objectContaining({
            operation: "prompts/get",
            status: "blocked",
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
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "tools/call", status: "failure", errorCode: "ROUTING_AMBIGUOUS" }),
          expect.objectContaining({ operation: "resources/read", status: "failure", errorCode: "ROUTING_AMBIGUOUS" }),
          expect.objectContaining({ operation: "prompts/get", status: "failure", errorCode: "ROUTING_AMBIGUOUS" })
        ])
      );
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
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toHaveLength(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "tools/call",
            name: "whoami",
            status: "success",
            profile: "work",
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
        .map((line) => JSON.parse(line) as Record<string, unknown>);
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
});
