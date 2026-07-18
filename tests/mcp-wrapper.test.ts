import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CallToolResultSchema,
  ListRootsRequestSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  RootsListChangedNotificationSchema,
  ToolListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { expectExactlyOneNotification } from "./helpers/notifications.js";
import { validateConfig } from "../src/config/validate-config.js";
import type { MiftahConfig } from "../src/config/types.js";
import type { AuditScope } from "../src/audit/audit-trail.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import {
  hasCompatibleCachedToolTarget,
  MiftahServer,
  resolveClientVisibleToolName
} from "../src/mcp/server/miftah-server.js";
import { MANAGEMENT_TOOL_NAMES, managementToolDescriptors } from "../src/mcp/server/management-tools.js";
import type { RegisteredTool } from "../src/mcp/server/tool-registry.js";
import { createMiftahRuntime } from "../src/runtime/create-miftah-runtime.js";
import type { RoutingContextSnapshot } from "../src/routing/routing-types.js";
import { MultiUpstreamProcessManager } from "../src/upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");
const toolCollisionPattern = /TOOL_COLLISION/;
const managementToolNames = managementToolDescriptors({ delegatedAgentApproval: false }).map((descriptor) => descriptor.name);

function registeredTool(originalName: string): RegisteredTool {
  return {
    exposedName: "trusted__shared_tool",
    originalName,
    upstreamName: "trusted",
    profile: "work",
    fingerprint: "same-client-contract"
  };
}

describe("cached routed-tool compatibility", () => {
  it("requires the original upstream tool name in addition to client shape and upstream identity", () => {
    const source = registeredTool("source_tool");

    expect(hasCompatibleCachedToolTarget(source, registeredTool("source_tool"))).toBe(true);
    expect(hasCompatibleCachedToolTarget(source, registeredTool("different_tool"))).toBe(false);
  });
});

describe("client-visible tool compatibility", () => {
  it("keeps management reservation and upstream namespace rules stable", () => {
    expect(resolveClientVisibleToolName("search", "github", "prefix-upstream")).toBe("github__search");
    for (const managementToolName of MANAGEMENT_TOOL_NAMES) {
      expect(resolveClientVisibleToolName(managementToolName, undefined, "prefix-upstream")).toBe(
        `upstream_${managementToolName}`
      );
      expect(() => resolveClientVisibleToolName(managementToolName, undefined, "fail")).toThrow(toolCollisionPattern);
    }
    expect(resolveClientVisibleToolName("miftah_custom", undefined, "fail")).toBe("miftah_custom");
  });
});

interface RuntimeRoutingFixture {
  readonly directory: string;
  readonly configPath: string;
  readonly matchingRoot: string;
  readonly changedRoot: string;
}

async function createRuntimeRoutingFixture(workEnvironment: Record<string, string> = {}): Promise<RuntimeRoutingFixture> {
  const directory = await mkdtemp(join(process.cwd(), ".miftah-routing-context-"));
  const matchingRoot = pathToFileURL(join(directory, "matching-root")).toString();
  const changedRoot = pathToFileURL(join(directory, "changed-root")).toString();
  const configPath = join(directory, "miftah.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work", ...workEnvironment } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      routing: {
        rules: [
          {
            name: "matching-root",
            when: { "context.fileRoots": matchingRoot },
            profile: "personal"
          }
        ]
      }
    })
  );
  return { directory, configPath, matchingRoot, changedRoot };
}

function withoutMiftahProfile(): () => void {
  const profile = process.env.MIFTAH_PROFILE;
  delete process.env.MIFTAH_PROFILE;
  return () => {
    if (profile === undefined) delete process.env.MIFTAH_PROFILE;
    else process.env.MIFTAH_PROFILE = profile;
  };
}

function parseJsonToolResult(result: unknown): Record<string, unknown> {
  const parsed = CallToolResultSchema.parse(result);
  const content = parsed.content[0];
  if (content?.type !== "text") throw new Error("Expected a text tool result.");
  const value: unknown = JSON.parse(content.text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object tool result.");
  return value as Record<string, unknown>;
}

class DropInitializedNotificationTransport implements Transport {
  constructor(private readonly delegate: Transport) {}

  get onclose(): Transport["onclose"] {
    return this.delegate.onclose;
  }

  set onclose(handler: Transport["onclose"]) {
    this.delegate.onclose = handler;
  }

  get onerror(): Transport["onerror"] {
    return this.delegate.onerror;
  }

  set onerror(handler: Transport["onerror"]) {
    this.delegate.onerror = handler;
  }

  get onmessage(): Transport["onmessage"] {
    return this.delegate.onmessage;
  }

  set onmessage(handler: Transport["onmessage"]) {
    this.delegate.onmessage = handler;
  }

  get sessionId(): string | undefined {
    return this.delegate.sessionId;
  }

  get setProtocolVersion(): Transport["setProtocolVersion"] {
    return this.delegate.setProtocolVersion;
  }

  async start(): Promise<void> {
    await this.delegate.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if ("method" in message && message.method === "notifications/initialized") return;
    await this.delegate.send(message, options);
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.()
  };
}

class DelayedProfileManager extends ProfileManager {
  readonly firstSwitchEntered = deferred();
  readonly releaseFirstSwitch = deferred();
  private firstSwitch = true;

  override async switchPersisted(profile: string) {
    if (this.firstSwitch) {
      this.firstSwitch = false;
      this.firstSwitchEntered.resolve();
      await this.releaseFirstSwitch.promise;
    }
    return super.switchPersisted(profile);
  }
}

interface ProfileManagementHost {
  handleManagement: (
    name: string,
    args: Record<string, unknown>,
    audit: AuditScope,
    source: { activeProfile: string; revision: number }
  ) => Promise<unknown>;
  routing: {
    resolve(input: { toolName: string; args: Record<string, unknown>; context: Record<string, unknown> }): {
      profile: string;
    };
  };
}

describe("Miftah MCP wrapper", () => {
  it("uses explicitly trusted tool annotations and records risk provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-risk-annotations-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture], trustToolAnnotations: true },
      profiles: {
        work: {
          policy: "readonly",
          env: {
            TEST_CREATE_ITEM_ANNOTATIONS: JSON.stringify({
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true
            })
          }
        }
      },
      policies: { readonly: { allowRisk: ["read"] } },
      audit: { path: auditPath }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), upstreams);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "risk-annotation-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();

      expect(parseJsonToolResult(await client.callTool({ name: "miftah_route_preview", arguments: { toolName: "create_item" } }))).toMatchObject({
        policy: { action: "allow", risk: "read", riskSource: "trusted-upstream-annotation", riskConfidence: "medium" }
      });
      expect(await client.callTool({ name: "create_item", arguments: { name: "x" } })).not.toMatchObject({ isError: true });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.find((event) => event.operation === "tools/call" && event.name === "create_item")).toMatchObject({
        risk: "read",
        riskSource: "trusted-upstream-annotation",
        riskConfidence: "medium"
      });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("scopes annotation trust to each named base upstream", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstreams: {
        trusted: { transport: "stdio", command: process.execPath, args: [fixture], trustToolAnnotations: true },
        untrusted: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          policy: "readonly",
          upstreams: {
            trusted: {
              env: { TEST_CREATE_ITEM_ANNOTATIONS: JSON.stringify({ readOnlyHint: true, destructiveHint: false }) }
            },
            untrusted: {
              env: { TEST_CREATE_ITEM_ANNOTATIONS: JSON.stringify({ readOnlyHint: true, destructiveHint: false }) }
            }
          }
        }
      },
      policies: { readonly: { allowRisk: ["read"] } }
    });
    const upstreams = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), upstreams);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "named-risk-annotation-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();

      expect(parseJsonToolResult(await client.callTool({ name: "miftah_route_preview", arguments: { toolName: "trusted__create_item" } }))).toMatchObject({
        policy: { action: "allow", risk: "read", riskSource: "trusted-upstream-annotation", riskConfidence: "medium" }
      });
      expect(await client.callTool({ name: "trusted__create_item", arguments: { name: "x" } })).not.toMatchObject({ isError: true });
      expect(parseJsonToolResult(await client.callTool({ name: "miftah_route_preview", arguments: { toolName: "untrusted__create_item" } }))).toMatchObject({
        policy: { action: "deny", risk: "write", riskSource: "name-heuristic", riskConfidence: "low" }
      });
      expect(await client.callTool({ name: "untrusted__create_item", arguments: { name: "x" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("POLICY_BLOCKED") }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("reports configured identity status without probing upstreams from management surfaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-identity-management-"));
    const callCountPath = join(directory, "tool-call-count");
    const listCountPath = join(directory, "tool-list-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_CALL_TOOL_COUNT_PATH: callCountPath, TEST_LIST_TOOLS_COUNT_PATH: listCountPath },
          identity: {
            expected: { provider: "github", login: "work" },
            probe: { tool: "whoami", resultFormat: "text", provider: "github" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write"]
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

      const current = parseJsonToolResult(await client.callTool({ name: "miftah_current_profile", arguments: {} }));
      const health = parseJsonToolResult(await client.callTool({ name: "miftah_health", arguments: {} }));
      const preview = parseJsonToolResult(
        await client.callTool({ name: "miftah_route_preview", arguments: { toolName: "create_item" } })
      );

      const expectedStatus = {
        status: "not-verified",
        profile: "work",
        upstream: "default",
        expected: { provider: "github", login: "work" }
      };
      expect(current.identity).toEqual([expectedStatus]);
      expect(health.identity).toEqual([expectedStatus]);
      expect(preview.identity).toEqual([expectedStatus]);
      await expect(access(callCountPath)).rejects.toThrow();
      await expect(access(listCountPath)).rejects.toThrow();
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("explicitly verifies the active profile identity through a management tool", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: "work" },
          identity: {
            expected: { provider: "github", login: "work" },
            probe: { tool: "whoami", resultFormat: "text", provider: "github" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write"]
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

      const verification = parseJsonToolResult(await client.callTool({ name: "miftah_verify_identity", arguments: {} }));

      expect(verification).toEqual({
        profile: "work",
        identity: [
          {
            status: "verified",
            profile: "work",
            upstream: "default",
            expected: { provider: "github", login: "work" },
            actual: { provider: "github", login: "work" },
            verifiedAt: expect.any(String)
          }
        ]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("verifies requested named upstreams alone and all configured upstreams in sorted order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-multi-upstream-identity-management-"));
    const githubCallCountPath = join(directory, "github-tool-call-count");
    const sentryCallCountPath = join(directory, "sentry-tool-call-count");
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
                TEST_CALL_TOOL_COUNT_PATH: githubCallCountPath
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
                TEST_CALL_TOOL_COUNT_PATH: sentryCallCountPath
              }
            }
          }
        }
      },
      tooling: { toolRiskOverrides: { identity: "read" } }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(
        parseJsonToolResult(await client.callTool({ name: "miftah_verify_identity", arguments: { upstream: "sentry" } }))
      ).toMatchObject({
        profile: "work",
        identity: [
          {
            status: "verified",
            profile: "work",
            upstream: "sentry",
            expected: { login: "work" },
            actual: { login: "work" }
          }
        ]
      });
      await expect(access(githubCallCountPath)).rejects.toThrow();
      expect(await readFile(sentryCallCountPath, "utf8")).toBe("1\n");

      expect(parseJsonToolResult(await client.callTool({ name: "miftah_verify_identity", arguments: {} }))).toMatchObject({
        profile: "work",
        identity: [
          {
            status: "verified",
            profile: "work",
            upstream: "github",
            expected: { login: "github-work" },
            actual: { login: "github-work" }
          },
          {
            status: "verified",
            profile: "work",
            upstream: "sentry",
            expected: { login: "work" },
            actual: { login: "work" }
          }
        ]
      });
      expect(await readFile(githubCallCountPath, "utf8")).toBe("1\n");
      expect(await readFile(sentryCallCountPath, "utf8")).toBe("1\n1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records a failed manual identity verification with only safe status evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-identity-management-audit-"));
    const auditPath = join(directory, "audit.jsonl");
    const secret = "manual-identity-response-secret";
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_INCLUDE_IDENTITY_TOOL: "true",
            TEST_IDENTITY_RESPONSE: JSON.stringify({ login: "personal", ignored: { secret } })
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

      const verification = await client.callTool({ name: "miftah_verify_identity", arguments: {} });
      expect(verification.isError).toBeUndefined();
      expect(parseJsonToolResult(verification)).toMatchObject({
        profile: "work",
        identity: [
          {
            status: "mismatch",
            expected: { login: "work" },
            actual: { login: "personal" },
            errorCode: "IDENTITY_MISMATCH"
          }
        ]
      });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const event = events.find((entry) => entry.operation === "management/verify-identity");
      expect(event).toMatchObject({
        status: "failure",
        errorCode: "IDENTITY_MISMATCH",
        identity: [
          {
            status: "mismatch",
            expected: { login: "work" },
            actual: { login: "personal" }
          }
        ]
      });
      expect(JSON.stringify({ verification, event })).not.toContain(secret);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a safe unsupported status and failure audit when the probe requires input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-identity-unsupported-audit-"));
    const auditPath = join(directory, "audit.jsonl");
    const rawResponse = "manual-unsupported-identity-secret";
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: rawResponse, TEST_WHOAMI_SCHEMA: "account" },
          identity: {
            expected: { provider: "github", login: "work" },
            probe: { tool: "whoami", resultFormat: "text", provider: "github" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write"]
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

      const verification = await client.callTool({ name: "miftah_verify_identity", arguments: {} });
      expect(verification.isError).toBeUndefined();
      expect(parseJsonToolResult(verification)).toMatchObject({
        profile: "work",
        identity: [
          {
            status: "unsupported",
            profile: "work",
            upstream: "default",
            expected: { provider: "github", login: "work" },
            errorCode: "IDENTITY_PROBE_UNSUPPORTED"
          }
        ]
      });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "operation");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        operation: "management/verify-identity",
        status: "failure",
        errorCode: "IDENTITY_PROBE_UNSUPPORTED",
        identity: [
          {
            status: "unsupported",
            expected: { provider: "github", login: "work" },
            errorCode: "IDENTITY_PROBE_UNSUPPORTED"
          }
        ]
      });
      expect(JSON.stringify({ verification, events })).not.toContain(rawResponse);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns and audits a safe status when a selected identity upstream cannot start", async () => {
    const secret = "identity-acquisition-error-secret";
    const missingExecutable = join(process.cwd(), `.missing-${secret}`);
    const auditPath = join(process.cwd(), `.miftah-identity-acquisition-${randomUUID()}.jsonl`);
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstreams: {
        broken: {
          transport: "stdio",
          command: missingExecutable,
          env: { API_TOKEN: secret }
        }
      },
      profiles: {
        work: {
          upstreams: {
            broken: {
              identity: {
                expected: { login: "work" },
                probe: { tool: "whoami", resultFormat: "text" },
                maxAgeMs: 60_000,
                requiredForRisk: ["write"]
              }
            }
          }
        }
      },
      audit: { path: auditPath }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const verification = await client.callTool({
        name: "miftah_verify_identity",
        arguments: { profile: "work", upstream: "broken" }
      });

      expect(verification.isError).toBeUndefined();
      expect(parseJsonToolResult(verification)).toEqual({
        profile: "work",
        identity: [
          {
            status: "failed",
            profile: "work",
            upstream: "broken",
            expected: { login: "work" },
            errorCode: "IDENTITY_VERIFICATION_FAILED"
          }
        ]
      });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "operation");
      expect(events).toEqual([
        expect.objectContaining({
          operation: "management/verify-identity",
          name: "broken",
          profile: "work",
          upstream: "broken",
          status: "failure",
          errorCode: "IDENTITY_VERIFICATION_FAILED",
          identity: [
            {
              status: "failed",
              profile: "work",
              upstream: "broken",
              expected: { login: "work" },
              errorCode: "IDENTITY_VERIFICATION_FAILED"
            }
          ]
        })
      ]);
      expect(JSON.stringify({ verification, events })).not.toContain(missingExecutable);
      expect(JSON.stringify({ verification, events })).not.toContain(secret);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(auditPath, { force: true });
    }
  });

  it("invalidates passive identity status when a verified upstream profile restarts", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: "work" },
          identity: {
            expected: { login: "work" },
            probe: { tool: "whoami", resultFormat: "text" },
            maxAgeMs: 60_000,
            requiredForRisk: ["write"]
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

      expect(
        parseJsonToolResult(await client.callTool({ name: "miftah_verify_identity", arguments: {} })).identity
      ).toMatchObject([{ status: "verified" }]);
      await client.callTool({ name: "miftah_restart_profile", arguments: { profile: "work" } });

      expect(
        parseJsonToolResult(await client.callTool({ name: "miftah_current_profile", arguments: {} })).identity
      ).toMatchObject([{ status: "not-verified" }]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

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
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames.filter((name) => name.startsWith("miftah_")).sort()).toEqual([...managementToolNames].sort());
    expect(toolNames).toEqual(expect.arrayContaining(["whoami", "create_item"]));
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

  it("routes a standard resource read through a canonical provider URI matcher", async () => {
    const resourceUri = "https://github.com/acme/miftah/issues/30";
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "personal",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_ACCOUNT_NAME: "work", TEST_RESOURCE_URI: resourceUri },
          routing: { match: { github: { repositories: ["acme/miftah"] } } }
        },
        personal: { env: { TEST_ACCOUNT_NAME: "personal", TEST_RESOURCE_URI: resourceUri } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "matcher-resource-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect((await client.listResources()).resources).toEqual(
        expect.arrayContaining([expect.objectContaining({ uri: resourceUri })])
      );
      expect(await client.readResource({ uri: resourceUri })).toMatchObject({ contents: [{ text: "work" }] });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("uses the collector snapshot for matching redacted preview and audit evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-route-evidence-"));
    const auditPath = join(directory, "audit.jsonl");
    const rawProject = "private-project-identity";
    const rawToken = "collector-secret-token";
    const contextPath = join(directory, "project");
    const snapshot: RoutingContextSnapshot = {
      context: {
        package: { name: "@example/personal-project" },
        environment: { project: rawProject }
      },
      evidence: {
        cwd: contextPath,
        fileRoots: [`${pathToFileURL(contextPath).toString()}?token=${rawToken}`],
        environment: { hasProject: true },
        package: {
          path: join(contextPath, "package.json"),
          name: "@example/personal-project",
          repository: `https://${rawToken}@github.com/example/personal-project.git?token=${rawToken}`
        }
      },
      profileHints: []
    };
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
        rules: [{ name: "personal-project", when: { "context.package.name": "@example/personal-project" }, profile: "personal" }]
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager, async () => snapshot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const previewResult = CallToolResultSchema.parse(
        await client.callTool({
          name: "miftah_route_preview",
          arguments: { toolName: "whoami" }
        })
      );
      const previewContent = previewResult.content[0];
      if (previewContent?.type !== "text") throw new Error("Expected route preview text.");
      const preview = JSON.parse(previewContent.text) as Record<string, unknown>;
      expect(preview).toMatchObject({ profile: "personal", reason: "rule:personal-project" });
      expect(JSON.stringify(preview.evidence)).not.toContain(rawProject);
      expect(JSON.stringify(preview.evidence)).not.toContain(rawToken);

      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const operation = events.find((event) => event.kind === "operation" && event.operation === "tools/call" && event.name === "whoami");
      expect(operation).toMatchObject({ profile: "personal", routingReason: "rule:personal-project" });
      expect(operation?.routingEvidence).toEqual(preview.evidence);
      expect(JSON.stringify(operation?.routingEvidence)).not.toContain(rawProject);
      expect(JSON.stringify(operation?.routingEvidence)).not.toContain(rawToken);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("routes a client-visible multi-upstream GitHub tool through its static matcher binding", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "personal",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          routing: { match: { github: { repositories: ["acme/miftah"] } } },
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-work" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work" } }
          }
        },
        personal: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-personal" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-personal" } }
          }
        }
      },
      audit: { enabled: false }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "provider-matcher-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "github__whoami", arguments: { repo: "acme/miftah" } })).toMatchObject({
        content: [{ type: "text", text: "github-work" }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("records bounded canonical matcher evidence for an ambiguous proxied operation without forwarding it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-matcher-ambiguous-"));
    const auditPath = join(directory, "audit.jsonl");
    const workCallPath = join(directory, "work-call-count");
    const personalCallPath = join(directory, "personal-call-count");
    const secret = "must-not-reach-operation-matcher-audit";
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
          routing: { match: { github: { repositories: ["acme/miftah"] } } },
          upstreams: {
            github: { env: { TEST_CALL_TOOL_COUNT_PATH: workCallPath } },
            sentry: { env: {} }
          }
        },
        personal: {
          routing: { match: { github: { repositories: ["acme/miftah"] } } },
          upstreams: {
            github: { env: { TEST_CALL_TOOL_COUNT_PATH: personalCallPath } },
            sentry: { env: {} }
          }
        }
      },
      audit: { path: auditPath }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "matcher-operation-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(
        await client.callTool({ name: "github__whoami", arguments: { repo: "acme/miftah", accessToken: secret } })
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("ROUTING_AMBIGUOUS") }]
      });
      await expect(access(workCallPath)).rejects.toThrow();
      await expect(access(personalCallPath)).rejects.toThrow();

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const event = events.find((candidate) => candidate.kind === "operation" && candidate.operation === "tools/call");
      expect(event).toMatchObject({
        status: "ambiguous",
        errorCode: "ROUTING_AMBIGUOUS",
        routingMatcherEvidence: [
          { profile: "personal", provider: "github", kind: "repository", value: "acme/miftah" },
          { profile: "work", provider: "github", kind: "repository", value: "acme/miftah" }
        ]
      });
      expect(JSON.stringify(event)).not.toContain(secret);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the same canonical matcher evidence for preview and successful proxied operation audits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-operation-matcher-evidence-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "personal",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          routing: { match: { github: { repositories: ["acme/miftah"] } } },
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-work" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work" } }
          }
        },
        personal: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-personal" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-personal" } }
          }
        }
      },
      audit: { path: auditPath }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "matcher-evidence-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const preview = parseJsonToolResult(
        await client.callTool({
          name: "miftah_route_preview",
          arguments: { toolName: "github__whoami", args: { repo: "acme/miftah" } }
        })
      );
      expect(preview).toMatchObject({
        profile: "work",
        reason: "matcher:github",
        matcherEvidence: [{ profile: "work", provider: "github", kind: "repository", value: "acme/miftah" }]
      });
      expect(await client.callTool({ name: "github__whoami", arguments: { repo: "acme/miftah" } })).toMatchObject({
        content: [{ type: "text", text: "github-work" }]
      });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const expectedEvidence = preview.matcherEvidence;
      expect(events.find((event) => event.operation === "management/route-preview")).toMatchObject({
        routingMatcherEvidence: expectedEvidence
      });
      expect(events.find((event) => event.operation === "tools/call")).toMatchObject({
        routingSource: "matcher",
        routingMatcherEvidence: expectedEvidence
      });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not treat a static matcher as the explicit rule required for destructive operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-destructive-matcher-"));
    const workCallPath = join(directory, "work-call-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "personal",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          routing: { match: { github: { repositories: ["acme/miftah"] } } },
          upstreams: {
            github: { env: { TEST_CALL_TOOL_COUNT_PATH: workCallPath } },
            sentry: { env: {} }
          }
        },
        personal: {
          upstreams: {
            github: { env: {} },
            sentry: { env: {} }
          }
        }
      },
      tooling: { toolRiskOverrides: { create_item: "destructive" } },
      security: { requireExplicitProfileForDestructive: true },
      audit: { enabled: false }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "matcher-destructive-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(
        await client.callTool({ name: "github__create_item", arguments: { repo: "acme/miftah", name: "danger" } })
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("POLICY_BLOCKED") }]
      });
      await expect(access(workCallPath)).rejects.toThrow();
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records collector evidence when route preview context is ambiguous", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-preview-ambiguous-"));
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
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager, async () => snapshot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "miftah_route_preview", arguments: { toolName: "whoami" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("ROUTING_AMBIGUOUS") }]
      });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.find((event) => event.kind === "operation" && event.operation === "management/route-preview")).toMatchObject({
        status: "ambiguous",
        errorCode: "ROUTING_AMBIGUOUS",
        routingEvidence: snapshot.evidence
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("records bounded canonical matcher evidence when a route preview is ambiguous", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-preview-matcher-ambiguous-"));
    const auditPath = join(directory, "audit.jsonl");
    const secret = "must-not-reach-matcher-audit";
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { routing: { match: { github: { repositories: ["acme/miftah"] } } } },
        personal: { routing: { match: { github: { repositories: ["acme/miftah"] } } } }
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "matcher-preview-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(
        await client.callTool({
          name: "miftah_route_preview",
          arguments: { toolName: "github__whoami", args: { repo: "acme/miftah", accessToken: secret } }
        })
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("ROUTING_AMBIGUOUS") }]
      });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const event = events.find((candidate) => candidate.kind === "operation" && candidate.operation === "management/route-preview");
      expect(event).toMatchObject({
        status: "ambiguous",
        errorCode: "ROUTING_AMBIGUOUS",
        routingMatcherEvidence: [
          { profile: "personal", provider: "github", kind: "repository", value: "acme/miftah" },
          { profile: "work", provider: "github", kind: "repository", value: "acme/miftah" }
        ]
      });
      expect(JSON.stringify(event)).not.toContain(secret);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a route preview bound to its captured fallback profile", async () => {
    let resolveSnapshotStarted: () => void = () => undefined;
    const snapshotStarted = new Promise<void>((resolve) => {
      resolveSnapshotStarted = resolve;
    });
    let releaseSnapshot: () => void = () => undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const snapshot: RoutingContextSnapshot = {
      context: {},
      evidence: { cwd: process.cwd(), fileRoots: [] },
      profileHints: []
    };
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      audit: { enabled: false }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager, async () => {
      resolveSnapshotStarted();
      await snapshotGate;
      return snapshot;
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const preview = client.callTool({ name: "miftah_route_preview", arguments: { toolName: "whoami" } });
      await snapshotStarted;
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      releaseSnapshot();

      const previewResult = CallToolResultSchema.parse(await preview);
      const previewContent = previewResult.content[0];
      if (previewContent?.type !== "text") throw new Error("Expected route preview text.");
      expect(JSON.parse(previewContent.text)).toMatchObject({ profile: "work", reason: "active-profile" });
    } finally {
      await client.close();
      await wrapper.close();
    }
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

  it("propagates a cancelled tool call to the selected stdio upstream and records one terminal audit outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-cancelled-tool-call-"));
    const startedPath = join(directory, "call-started");
    const cancelledPath = join(directory, "cancelled");
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
            TEST_CALL_TOOL_STARTED_PATH: startedPath,
            TEST_CALL_TOOL_DELAY_MS: "500",
            TEST_CANCELLED_PATH: cancelledPath
          }
        }
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cancellation-test-client", version: "1.0.0" });
    const controller = new AbortController();

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const pending = client.callTool({ name: "whoami", arguments: {} }, undefined, { signal: controller.signal });
      await expect.poll(async () => access(startedPath).then(() => true, () => false)).toBe(true);
      controller.abort("test cancellation");

      await expect(pending).rejects.toThrow();
      await expect.poll(async () => access(cancelledPath).then(() => true, () => false)).toBe(true);

      const toolCallOperations = async (): Promise<Record<string, unknown>[]> => {
        const journal = await readFile(auditPath, "utf8").catch(() => "");
        return journal
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((event) => event.kind === "operation" && event.operation === "tools/call");
      };
      await expect.poll(toolCallOperations).toHaveLength(1);
      const operations = await toolCallOperations();
      expect(operations).toEqual([
        expect.objectContaining({ status: "failure", errorCode: "UPSTREAM_CALL_FAILED", name: "whoami" })
      ]);
      expect((await readFile(cancelledPath, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates cancellation through initial tool discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-cancelled-tool-discovery-"));
    const startedPath = join(directory, "tools-started");
    const cancelledPath = join(directory, "cancelled");
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
            TEST_LIST_TOOLS_DELAY_MS: "500",
            TEST_CANCELLED_PATH: cancelledPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tool-discovery-cancellation-test-client", version: "1.0.0" });
    const controller = new AbortController();

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const pending = client.listTools(undefined, { signal: controller.signal });
      await expect.poll(async () => access(startedPath).then(() => true, () => false)).toBe(true);
      controller.abort("test cancellation");

      await expect(pending).rejects.toThrow();
      await expect.poll(async () => access(cancelledPath).then(() => true, () => false)).toBe(true);
      await delay(100);
      const health = parseJsonToolResult(await client.callTool({ name: "miftah_health", arguments: {} }));
      expect(health.upstreams).not.toMatchObject([
        { capabilities: { tools: { state: "failed" } } }
      ]);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates cancellation through management tool discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-cancelled-management-discovery-"));
    const startedPath = join(directory, "tools-started");
    const cancelledPath = join(directory, "cancelled");
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
            TEST_LIST_TOOLS_DELAY_MS: "500",
            TEST_CANCELLED_PATH: cancelledPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "management-discovery-cancellation-test-client", version: "1.0.0" });
    const controller = new AbortController();

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const pending = client.callTool(
        { name: "miftah_list_upstream_tools", arguments: {} },
        undefined,
        { signal: controller.signal }
      );
      await expect.poll(async () => access(startedPath).then(() => true, () => false)).toBe(true);
      controller.abort("test cancellation");

      await expect(pending).rejects.toThrow();
      await expect.poll(async () => access(cancelledPath).then(() => true, () => false)).toBe(true);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps shared tool discovery alive when one downstream caller cancels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-shared-tool-discovery-cancellation-"));
    const startedPath = join(directory, "tools-started");
    const cancelledPath = join(directory, "cancelled");
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
            TEST_LIST_TOOLS_DELAY_MS: "500",
            TEST_CANCELLED_PATH: cancelledPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "shared-tool-discovery-cancellation-test-client", version: "1.0.0" });
    const controller = new AbortController();

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const cancelled = client.listTools(undefined, { signal: controller.signal });
      await expect.poll(async () => access(startedPath).then(() => true, () => false)).toBe(true);
      const completed = client.listTools();
      // Allow the second downstream request to join the in-flight shared snapshot
      // before cancelling the first caller.
      await delay(25);
      controller.abort("test cancellation");

      await expect(cancelled).rejects.toThrow();
      await expect(completed).resolves.toMatchObject({ tools: expect.any(Array) });
      await delay(75);
      await expect(access(cancelledPath)).rejects.toThrow();
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts fresh tool discovery when a prior sole caller has cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-restarted-tool-discovery-cancellation-"));
    const startedPath = join(directory, "tools-started");
    const cancelledPath = join(directory, "cancelled");
    const countPath = join(directory, "tools-count");
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
            TEST_LIST_TOOLS_DELAY_MS: "500",
            TEST_CANCELLED_PATH: cancelledPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "restarted-tool-discovery-cancellation-test-client", version: "1.0.0" });
    const controller = new AbortController();

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const cancelled = client.listTools(undefined, { signal: controller.signal });
      await expect.poll(async () => access(startedPath).then(() => true, () => false)).toBe(true);
      controller.abort("test cancellation");
      // Start a new downstream request before the cancelled upstream request has
      // settled. It must not join the aborted shared discovery.
      const recovered = client.listTools();

      await expect(cancelled).rejects.toThrow();
      await expect(recovered).resolves.toMatchObject({ tools: expect.any(Array) });
      await expect.poll(async () => readFile(countPath, "utf8")).toBe("1\n1\n");
      await expect.poll(async () => access(cancelledPath).then(() => true, () => false)).toBe(true);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fans shared tool discovery progress out to every downstream caller", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-shared-tool-discovery-progress-"));
    const startedPath = join(directory, "tools-started");
    const countPath = join(directory, "tools-count");
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
            TEST_LIST_TOOLS_DELAY_MS: "200",
            TEST_LIST_TOOLS_PROGRESS: "true"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "shared-tool-discovery-progress-test-client", version: "1.0.0" });
    const firstProgress: unknown[] = [];
    const secondProgress: unknown[] = [];

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const first = client.listTools(undefined, { onprogress: (progress) => firstProgress.push(progress) });
      await expect.poll(async () => access(startedPath).then(() => true, () => false)).toBe(true);
      const second = client.listTools(undefined, { onprogress: (progress) => secondProgress.push(progress) });

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      await expect.poll(() => firstProgress).toEqual([{ progress: 1, total: 2 }]);
      await expect.poll(() => secondProgress).toEqual([{ progress: 1, total: 2 }]);
      expect(await readFile(countPath, "utf8")).toBe("1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates cancellation through resource discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-cancelled-resource-discovery-"));
    const startedPath = join(directory, "resources-started");
    const cancelledPath = join(directory, "cancelled");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_LIST_RESOURCES_STARTED_PATH: startedPath,
            TEST_LIST_RESOURCES_DELAY_MS: "500",
            TEST_CANCELLED_PATH: cancelledPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-discovery-cancellation-test-client", version: "1.0.0" });
    const controller = new AbortController();

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const pending = client.listResources(undefined, { signal: controller.signal });
      await expect.poll(async () => access(startedPath).then(() => true, () => false)).toBe(true);
      controller.abort("test cancellation");

      await expect(pending).rejects.toThrow();
      await expect.poll(async () => access(cancelledPath).then(() => true, () => false)).toBe(true);
      await delay(100);
      const health = parseJsonToolResult(await client.callTool({ name: "miftah_health", arguments: {} }));
      expect(health.upstreams).not.toMatchObject([
        { capabilities: { resources: { state: "failed" } } }
      ]);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forwards upstream tool progress through the downstream request context", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_CALL_TOOL_PROGRESS: "true",
            TEST_CALL_TOOL_PROGRESS_MESSAGE: "Fetching account"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "progress-test-client", version: "1.0.0" });
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
      await expect.poll(() => progressUpdates).toEqual([{ progress: 1, total: 2, message: "Fetching account" }]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("forwards progress from every proxied discovery endpoint", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_LIST_TOOLS_PROGRESS: "true",
            TEST_LIST_RESOURCES_PROGRESS: "true",
            TEST_LIST_RESOURCE_TEMPLATES_PROGRESS: "true",
            TEST_LIST_PROMPTS_PROGRESS: "true"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "discovery-progress-test-client", version: "1.0.0" });
    const toolsProgress: unknown[] = [];
    const resourcesProgress: unknown[] = [];
    const templatesProgress: unknown[] = [];
    const promptsProgress: unknown[] = [];

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.listTools(undefined, { onprogress: (progress) => toolsProgress.push(progress) });
      await client.listResources(undefined, { onprogress: (progress) => resourcesProgress.push(progress) });
      await client.listResourceTemplates(undefined, { onprogress: (progress) => templatesProgress.push(progress) });
      await client.listPrompts(undefined, { onprogress: (progress) => promptsProgress.push(progress) });

      await expect.poll(() => toolsProgress).toEqual([{ progress: 1, total: 2 }]);
      await expect.poll(() => resourcesProgress).toEqual([{ progress: 1, total: 2 }]);
      await expect.poll(() => templatesProgress).toEqual([{ progress: 1, total: 2 }]);
      await expect.poll(() => promptsProgress).toEqual([{ progress: 1, total: 2 }]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("aggregates concurrent upstream tool-discovery progress on one downstream token", async () => {
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
                TEST_ACCOUNT_NAME: "github",
                TEST_LIST_TOOLS_PROGRESS: "true",
                TEST_LIST_TOOLS_DELAY_MS: "100"
              }
            },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry", TEST_LIST_TOOLS_PROGRESS: "true" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "aggregate-discovery-progress-test-client", version: "1.0.0" });
    const progressUpdates: unknown[] = [];

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.listTools(undefined, { onprogress: (progress) => progressUpdates.push(progress) });

      await expect.poll(() => progressUpdates).toEqual([{ progress: 0.5 }, { progress: 1 }]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("namespaces aggregated resource templates and routes instantiated reads to their origin upstream", async () => {
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
                TEST_ACCOUNT_NAME: "github",
                TEST_RESOURCE_TEMPLATE_NAME: "issue",
                TEST_RESOURCE_TEMPLATE_URI: "account://github/{id}"
              }
            },
            sentry: {
              env: {
                TEST_ACCOUNT_NAME: "sentry",
                TEST_RESOURCE_TEMPLATE_NAME: "issue",
                TEST_RESOURCE_TEMPLATE_URI: "account://sentry/{id}"
              }
            }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-template-test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const listed = await client.listResourceTemplates();
      expect(listed.resourceTemplates.map((template) => template.name)).toEqual(
        expect.arrayContaining(["github__issue", "sentry__issue"])
      );
      const githubTemplate = listed.resourceTemplates.find((template) => template.name === "github__issue");
      if (!githubTemplate) throw new Error("Expected the GitHub resource template.");
      const uri = new UriTemplate(githubTemplate.uriTemplate).expand({ id: "42" });

      expect(await client.readResource({ uri })).toMatchObject({
        contents: [{ uri, text: "github" }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("reports a stable unavailable error when a direct upstream does not implement resource templates", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { env: { TEST_ACCOUNT_NAME: "work", TEST_RESOURCE_TEMPLATES_UNSUPPORTED: "true" } } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-templates-unavailable-test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.listResourceTemplates()).rejects.toThrow(/^MCP error -32603: RESOURCE_TEMPLATES_UNAVAILABLE:/);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("reports a stable unavailable error when no aggregated upstream implements resource templates", async () => {
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
            github: { env: { TEST_ACCOUNT_NAME: "github", TEST_RESOURCE_TEMPLATES_UNSUPPORTED: "true" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry", TEST_RESOURCE_TEMPLATES_UNSUPPORTED: "true" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "aggregated-resource-templates-unavailable-test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.listResourceTemplates()).rejects.toThrow(/^MCP error -32603: RESOURCE_TEMPLATES_UNAVAILABLE:/);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("proxies resource subscriptions to the selected upstream and namespaces update notifications", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-resource-subscriptions-"));
    const githubSubscribePath = join(directory, "github-subscribe");
    const githubUnsubscribePath = join(directory, "github-unsubscribe");
    const sentrySubscribePath = join(directory, "sentry-subscribe");
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
                TEST_ACCOUNT_NAME: "github",
                TEST_RESOURCE_SUBSCRIPTIONS: "true",
                TEST_RESOURCE_UPDATE_URI: "account://current",
                TEST_SUBSCRIBE_COUNT_PATH: githubSubscribePath,
                TEST_UNSUBSCRIBE_COUNT_PATH: githubUnsubscribePath
              }
            },
            sentry: {
              env: {
                TEST_ACCOUNT_NAME: "sentry",
                TEST_RESOURCE_SUBSCRIPTIONS: "true",
                TEST_SUBSCRIBE_COUNT_PATH: sentrySubscribePath
              }
            }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-test-client", version: "1.0.0" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      expect(client.getServerCapabilities()).toMatchObject({ resources: { listChanged: true, subscribe: true } });
      const listed = await client.listResources();
      const githubResource = listed.resources.find((resource) => resource.name === "github__Current account");
      if (!githubResource) throw new Error("Expected the GitHub resource.");

      await client.subscribeResource({ uri: githubResource.uri });
      await expectExactlyOneNotification(() => updates.length);
      expect(updates).toEqual([githubResource.uri]);
      expect(await readFile(githubSubscribePath, "utf8")).toBe("1\n");
      await expect(access(sentrySubscribePath)).rejects.toThrow();

      await client.unsubscribeResource({ uri: githubResource.uri });
      expect(await readFile(githubUnsubscribePath, "utf8")).toBe("1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forwards only updates for the subscribed resource", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_RESOURCE_UPDATE_URI: "account://other"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-filter-test", version: "1.0.0" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.subscribeResource({ uri: "account://current" });
      await delay(75);
      expect(updates).toEqual([]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("does not forward an update from a subscription that fails before activation", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_RESOURCE_UPDATE_URI: "account://current",
            TEST_FAIL_SUBSCRIBE: "true"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "failed-resource-subscription-test-client", version: "1.0.0" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.subscribeResource({ uri: "account://current" })).rejects.toThrow();
      await delay(75);
      expect(updates).toEqual([]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("cleans up an upstream subscription that finishes after downstream cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-cancelled-resource-subscription-"));
    const subscribeStartedPath = join(directory, "subscribe-started");
    const unsubscribeCountPath = join(directory, "unsubscribe-count");
    const cancelledPath = join(directory, "cancelled");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_RESOURCE_UPDATE_URI: "account://current",
            TEST_SUBSCRIBE_STARTED_PATH: subscribeStartedPath,
            TEST_SUBSCRIBE_DELAY_MS: "100",
            TEST_UNSUBSCRIBE_COUNT_PATH: unsubscribeCountPath,
            TEST_CANCELLED_PATH: cancelledPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cancelled-resource-subscription-test-client", version: "1.0.0" });
    const controller = new AbortController();
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const pending = client.subscribeResource({ uri: "account://current" }, { signal: controller.signal });
      await expect.poll(async () => access(subscribeStartedPath).then(() => true, () => false)).toBe(true);
      controller.abort("test cancellation");

      await expect(pending).rejects.toThrow();
      await expect.poll(async () => access(cancelledPath).then(() => true, () => false)).toBe(true);
      await expect.poll(async () => readFile(unsubscribeCountPath, "utf8")).toBe("1\n");
      await delay(125);
      expect(updates).toEqual([]);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases a subscription after its unsubscribe request is cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-cancelled-resource-unsubscribe-"));
    const unsubscribeCountPath = join(directory, "unsubscribe-count");
    const cancelledPath = join(directory, "cancelled");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_UNSUBSCRIBE_DELAY_MS: "100",
            TEST_UNSUBSCRIBE_COUNT_PATH: unsubscribeCountPath,
            TEST_CANCELLED_PATH: cancelledPath
          }
        }
      },
      process: { shutdownTimeoutMs: 500 }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, {
      startupTimeoutMs: 5_000,
      idleTimeoutMs: 25,
      shutdownTimeoutMs: 500
    });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cancelled-resource-unsubscribe-test-client", version: "1.0.0" });
    const controller = new AbortController();

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.subscribeResource({ uri: "account://current" });

      const pending = client.unsubscribeResource({ uri: "account://current" }, { signal: controller.signal });
      await expect.poll(async () => readFile(unsubscribeCountPath, "utf8")).toBe("1\n");
      controller.abort("test cancellation");

      await expect(pending).rejects.toThrow();
      await expect.poll(async () => access(cancelledPath).then(() => true, () => false)).toBe(true);
      await expect.poll(() => manager.listHealth()[0]?.processState).toBe("stopped");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds a pending subscription before switching profiles at capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-pending-subscription-profile-switch-"));
    const subscribeStartedPath = join(directory, "subscribe-started");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_SUBSCRIBE_STARTED_PATH: subscribeStartedPath,
            TEST_SUBSCRIBE_DELAY_MS: "1000"
          }
        },
        personal: { env: { TEST_ACCOUNT_NAME: "personal", TEST_RESOURCE_SUBSCRIPTIONS: "true" } }
      },
      process: { maxConcurrentProfiles: 1, shutdownTimeoutMs: 25, idleTimeoutMs: 25 }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, {
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 25,
      idleTimeoutMs: 25,
      maxConcurrentProfiles: 1
    });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "pending-resource-subscription-profile-switch-test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const pending = client.subscribeResource({ uri: "account://current" });
      await expect.poll(async () => access(subscribeStartedPath).then(() => true, () => false)).toBe(true);

      await expect(client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).resolves.toMatchObject({
        content: [{ type: "text", text: "Active profile changed from work to personal." }]
      });
      await expect(pending).rejects.toThrow();
      await expect.poll(() => manager.listHealth().find((health) => health.profile === "work")?.processState).toBe("stopped");
      await expect(client.callTool({ name: "whoami", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes cancelled subscription cleanup before a retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-cancelled-resource-subscription-retry-"));
    const subscribeStartedPath = join(directory, "subscribe-started");
    const subscribeCountPath = join(directory, "subscribe-count");
    const unsubscribeCountPath = join(directory, "unsubscribe-count");
    const cancelledPath = join(directory, "cancelled");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_RESOURCE_SUBSCRIPTION_STATEFUL_UPDATES: "true",
            TEST_RESOURCE_UPDATE_URI: "account://current",
            TEST_RESOURCE_UPDATE_DELAY_MS: "225",
            TEST_SUBSCRIBE_STARTED_PATH: subscribeStartedPath,
            TEST_SUBSCRIBE_COUNT_PATH: subscribeCountPath,
            // Keep the upstream request pending beyond the poll cadence so the
            // test aborts an in-flight subscription rather than a completed one.
            TEST_SUBSCRIBE_DELAY_MS: "500",
            TEST_UNSUBSCRIBE_COUNT_PATH: unsubscribeCountPath,
            TEST_UNSUBSCRIBE_DELAY_MS: "150",
            TEST_CANCELLED_PATH: cancelledPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cancelled-resource-subscription-retry-test-client", version: "1.0.0" });
    const controller = new AbortController();
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const cancelled = client.subscribeResource({ uri: "account://current" }, { signal: controller.signal });
      await expect.poll(async () => access(subscribeStartedPath).then(() => true, () => false)).toBe(true);
      controller.abort("test cancellation");

      await expect(cancelled).rejects.toThrow();
      await expect.poll(async () => access(cancelledPath).then(() => true, () => false)).toBe(true);
      await client.subscribeResource({ uri: "account://current" });

      await expect.poll(async () => readFile(subscribeCountPath, "utf8")).toBe("1\n1\n");
      await expect.poll(async () => readFile(unsubscribeCountPath, "utf8")).toBe("1\n");
      await expectExactlyOneNotification(() => updates.length);
      expect(updates).toEqual(["account://current"]);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fans one upstream resource update out to every matching static and template subscription", async () => {
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
                TEST_ACCOUNT_NAME: "github",
                TEST_RESOURCE_SUBSCRIPTIONS: "true",
                TEST_RESOURCE_UPDATE_URI: "account://current",
                TEST_RESOURCE_UPDATE_DELAY_MS: "25",
                TEST_RESOURCE_TEMPLATE_NAME: "account",
                TEST_RESOURCE_TEMPLATE_URI: "account://{id}"
              }
            },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry", TEST_RESOURCE_SUBSCRIPTIONS: "true" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-fanout-test-client", version: "1.0.0" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const resources = await client.listResources();
      const templates = await client.listResourceTemplates();
      const githubResource = resources.resources.find((resource) => resource.name === "github__Current account");
      const githubTemplate = templates.resourceTemplates.find((template) => template.name === "github__account");
      if (!githubResource || !githubTemplate) throw new Error("Expected GitHub resource and template routes.");
      const templateUri = new UriTemplate(githubTemplate.uriTemplate).expand({ id: "current" });

      await client.subscribeResource({ uri: githubResource.uri });
      await expectExactlyOneNotification(() => updates.length);
      updates.length = 0;

      await client.subscribeResource({ uri: templateUri });
      await expect.poll(() => updates.length).toBe(2);
      await delay(50);
      expect(updates).toEqual(expect.arrayContaining([githubResource.uri, templateUri]));
      expect(updates).toHaveLength(2);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("re-establishes a resource subscription after its upstream restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-resource-subscription-restart-"));
    const subscribeCountPath = join(directory, "subscribe-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_SUBSCRIBE_COUNT_PATH: subscribeCountPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-restart-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.subscribeResource({ uri: "account://current" });
      await client.callTool({ name: "miftah_restart_profile", arguments: { profile: "work" } });
      await client.subscribeResource({ uri: "account://current" });

      expect(await readFile(subscribeCountPath, "utf8")).toBe("1\n1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("clears a direct resource subscription when its upstream lifecycle ends", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-resource-subscription-direct-lifecycle-"));
    const subscribeCountPath = join(directory, "subscribe-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_SUBSCRIBE_COUNT_PATH: subscribeCountPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-direct-lifecycle-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.subscribeResource({ uri: "account://current" });
      await manager.closeProfile("work");
      await client.subscribeResource({ uri: "account://current" });

      expect(await readFile(subscribeCountPath, "utf8")).toBe("1\n1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes overlapping resource subscription transitions before releasing idle capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-resource-subscription-race-"));
    const subscribeStartedPath = join(directory, "subscribe-started");
    const subscribeCountPath = join(directory, "subscribe-count");
    const unsubscribeCountPath = join(directory, "unsubscribe-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_SUBSCRIBE_STARTED_PATH: subscribeStartedPath,
            TEST_SUBSCRIBE_DELAY_MS: "100",
            TEST_SUBSCRIBE_COUNT_PATH: subscribeCountPath,
            TEST_UNSUBSCRIBE_COUNT_PATH: unsubscribeCountPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, {
      startupTimeoutMs: 5_000,
      idleTimeoutMs: 25,
      shutdownTimeoutMs: 25
    });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-race-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const subscribe = client.subscribeResource({ uri: "account://current" });
      await expect
        .poll(async () => {
          try {
            await access(subscribeStartedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      const unsubscribe = client.unsubscribeResource({ uri: "account://current" });
      await Promise.all([subscribe, unsubscribe]);

      expect(await readFile(subscribeCountPath, "utf8")).toBe("1\n");
      expect(await readFile(unsubscribeCountPath, "utf8")).toBe("1\n");
      await expect.poll(() => manager.listHealth()[0]?.processState).toBe("stopped");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("joins an in-flight unsubscribe before profile cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-resource-subscription-cleanup-race-"));
    const unsubscribeCountPath = join(directory, "unsubscribe-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_UNSUBSCRIBE_COUNT_PATH: unsubscribeCountPath,
            TEST_UNSUBSCRIBE_DELAY_MS: "100"
          }
        },
        personal: { env: { TEST_ACCOUNT_NAME: "personal", TEST_RESOURCE_SUBSCRIPTIONS: "true" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-cleanup-race-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.subscribeResource({ uri: "account://current" });

      const unsubscribe = client.unsubscribeResource({ uri: "account://current" });
      await expect.poll(async () => readFile(unsubscribeCountPath, "utf8")).toBe("1\n");
      const switched = client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });

      await Promise.all([unsubscribe, switched]);
      expect(await readFile(unsubscribeCountPath, "utf8")).toBe("1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not retain a subscription invalidated during its upstream handshake", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-resource-subscription-handshake-race-"));
    const subscribeStartedPath = join(directory, "subscribe-started");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_SUBSCRIBE_STARTED_PATH: subscribeStartedPath,
            TEST_SUBSCRIBE_DELAY_MS: "100"
          }
        },
        personal: { env: { TEST_ACCOUNT_NAME: "personal", TEST_RESOURCE_SUBSCRIPTIONS: "true" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, {
      startupTimeoutMs: 5_000,
      idleTimeoutMs: 25,
      shutdownTimeoutMs: 25
    });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-handshake-race-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const subscribe = client.subscribeResource({ uri: "account://current" });
      await expect
        .poll(async () => {
          try {
            await access(subscribeStartedPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });

      await expect(subscribe).rejects.toThrow("RESOURCE_SUBSCRIPTION_NOT_FOUND");
      await expect.poll(() => manager.listHealth().find((health) => health.profile === "work")?.processState).toBe("stopped");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not establish a captured-profile subscription after a profile switch", async () => {
    let resolveSnapshotStarted: () => void = () => undefined;
    const snapshotStarted = new Promise<void>((resolve) => {
      resolveSnapshotStarted = resolve;
    });
    let releaseSnapshot: () => void = () => undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const snapshot: RoutingContextSnapshot = {
      context: {},
      evidence: { cwd: process.cwd(), fileRoots: [] },
      profileHints: []
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
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_RESOURCE_UPDATE_URI: "account://current"
          }
        },
        personal: { env: { TEST_ACCOUNT_NAME: "personal", TEST_RESOURCE_SUBSCRIPTIONS: "true" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, {
      startupTimeoutMs: 5_000,
      idleTimeoutMs: 25,
      shutdownTimeoutMs: 25
    });
    let collectSnapshot = true;
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager, async () => {
      if (collectSnapshot) {
        collectSnapshot = false;
        resolveSnapshotStarted();
        await snapshotGate;
      }
      return snapshot;
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-pre-candidate-switch-test", version: "1.0.0" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const subscribe = client.subscribeResource({ uri: "account://current" });
      await snapshotStarted;
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      releaseSnapshot();

      await expect(subscribe).rejects.toThrow("RESOURCE_SUBSCRIPTION_NOT_FOUND");
      await delay(100);
      expect(updates).toEqual([]);
      await expect.poll(() => manager.listHealth().find((health) => health.profile === "work")?.processState).toBe("stopped");
    } finally {
      releaseSnapshot();
      await client.close();
      await wrapper.close();
    }
  });

  it("keeps a resource subscription alive beyond the upstream idle timeout", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_RESOURCE_UPDATE_URI: "account://current",
            TEST_RESOURCE_UPDATE_DELAY_MS: "75"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, {
      startupTimeoutMs: 5_000,
      idleTimeoutMs: 25,
      shutdownTimeoutMs: 25
    });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-idle-test", version: "1.0.0" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.subscribeResource({ uri: "account://current" });
      await expect.poll(() => updates).toEqual(["account://current"]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("drops an old-profile resource subscription before a delayed update can be forwarded", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_RESOURCE_UPDATE_URI: "account://current",
            TEST_RESOURCE_UPDATE_DELAY_MS: "75"
          }
        },
        personal: { env: { TEST_ACCOUNT_NAME: "personal", TEST_RESOURCE_SUBSCRIPTIONS: "true" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-switch-test", version: "1.0.0" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.subscribeResource({ uri: "account://current" });
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      await delay(125);

      expect(updates).toEqual([]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("clears a routed third-profile subscription when the active profile changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-resource-subscription-third-profile-"));
    const unsubscribeCountPath = join(directory, "unsubscribe-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work", TEST_RESOURCE_SUBSCRIPTIONS: "true" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal", TEST_RESOURCE_SUBSCRIPTIONS: "true" } },
        third: {
          env: {
            TEST_ACCOUNT_NAME: "third",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_UNSUBSCRIBE_COUNT_PATH: unsubscribeCountPath,
            TEST_RESOURCE_UPDATE_URI: "account://third",
            TEST_RESOURCE_UPDATE_DELAY_MS: "75"
          }
        }
      },
      routing: {
        rules: [{ name: "third-resource", when: { "args.uri": "account://third" }, profile: "third" }]
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-third-profile-test", version: "1.0.0" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(
        parseJsonToolResult(
          await client.callTool({
            name: "miftah_route_preview",
            arguments: { toolName: "resources/read", args: { uri: "account://third" } }
          })
        )
      ).toMatchObject({ profile: "third", reason: "rule:third-resource" });
      await client.subscribeResource({ uri: "account://third" });
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      await delay(125);

      expect(await readFile(unsubscribeCountPath, "utf8")).toBe("1\n");
      expect(updates).toEqual([]);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds resource subscription cleanup while switching profiles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-resource-subscription-cleanup-"));
    const unsubscribeCountPath = join(directory, "unsubscribe-count");
    const cancelledPath = join(directory, "cancelled");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_RESOURCE_SUBSCRIPTIONS: "true",
            TEST_UNSUBSCRIBE_COUNT_PATH: unsubscribeCountPath,
            TEST_UNSUBSCRIBE_DELAY_MS: "1000",
            TEST_CANCELLED_PATH: cancelledPath
          }
        },
        personal: { env: { TEST_ACCOUNT_NAME: "personal", TEST_RESOURCE_SUBSCRIPTIONS: "true" } }
      },
      process: { shutdownTimeoutMs: 25 }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, {
      startupTimeoutMs: 5_000,
      ...config.process
    });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-cleanup-test", version: "1.0.0" });
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.subscribeResource({ uri: "account://current" });
      const switchedAt = Date.now();
      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        content: [{ type: "text", text: "Active profile changed from work to personal." }]
      });

      expect(Date.now() - switchedAt).toBeLessThan(500);
      expect(await readFile(unsubscribeCountPath, "utf8")).toBe("1\n");
      await expect.poll(async () => readFile(cancelledPath, "utf8")).toMatch(/^\d+\n$/);
      expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining("UPSTREAM_CALL_FAILED"), {
        code: "MIFTAH_RESOURCE_SUBSCRIPTION_CLEANUP_FAILED"
      });
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
      emitWarning.mockRestore();
    }
  });

  it("does not advertise resource subscriptions unless every selectable profile supports them", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work", TEST_RESOURCE_SUBSCRIPTIONS: "true" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-capability-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(client.getServerCapabilities()?.resources?.subscribe).not.toBe(true);
      await expect(client.subscribeResource({ uri: "account://current" })).rejects.toThrow(
        "RESOURCE_SUBSCRIPTION_UNSUPPORTED"
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("releases subscription-capability probes before serving the active profile at capacity", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work", TEST_RESOURCE_SUBSCRIPTIONS: "true" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal", TEST_RESOURCE_SUBSCRIPTIONS: "true" } }
      },
      process: { maxConcurrentProfiles: 1 }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, {
      startupTimeoutMs: 5_000,
      maxConcurrentProfiles: 1
    });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscription-capacity-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
      expect(manager.listHealth()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ profile: "work", processState: "running" }),
          expect.objectContaining({ profile: "personal", processState: "stopped" })
        ])
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("forwards upstream tools, resources, and prompts list-change notifications", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work", TEST_NOTIFY_LIST_CHANGES_ON_CALL_TOOL: "true" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "list-change-test-client", version: "1.0.0" });
    let toolsChanged = 0;
    let resourcesChanged = 0;
    let promptsChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      toolsChanged += 1;
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      resourcesChanged += 1;
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      promptsChanged += 1;
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      expect(client.getServerCapabilities()).toMatchObject({
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true }
      });

      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
      await Promise.all([
        expectExactlyOneNotification(() => toolsChanged),
        expectExactlyOneNotification(() => resourcesChanged),
        expectExactlyOneNotification(() => promptsChanged)
      ]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("forwards a tool list change from a session first used for discovery", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work", TEST_NOTIFY_TOOL_LIST_CHANGE_ON_LIST_TOOLS: "true" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tool-discovery-list-change-test", version: "1.0.0" });
    let changes = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changes += 1;
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await client.listTools();
      await expectExactlyOneNotification(() => changes);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("refreshes the initial tool snapshot after a concurrent upstream list change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-initial-tool-list-change-"));
    const countPath = join(directory, "tools-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_LIST_TOOLS_COUNT_PATH: countPath,
            TEST_NOTIFY_TOOL_LIST_CHANGE_ON_FIRST_LIST_TOOLS: "true",
            TEST_TOOL_LIST_CHANGES_AFTER_FIRST_REQUEST: "true"
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "initial-tool-list-change-refresh-test", version: "1.0.0" });
    let changes = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changes += 1;
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const initial = await client.listTools();
      expect(initial.tools.map((tool) => tool.name)).toContain("whoami");
      await expectExactlyOneNotification(() => changes);

      const refreshed = await client.listTools();
      const names = refreshed.tools.map((tool) => tool.name);
      expect(names).toContain("whoami_reloaded");
      expect(names).not.toContain("whoami");
      expect(await readFile(countPath, "utf8")).toBe("1\n1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not reject a cold tool call when an idle upstream emits a list change", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work", TEST_NOTIFY_TOOL_LIST_CHANGE_ON_LIST_TOOLS: "true" } }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "idle-tool-list-change-call-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      await expect(client.callTool({ name: "whoami", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("clears a deferred tool invalidation when its list request is cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-cancelled-tool-list-change-"));
    const cancelledPath = join(directory, "cancelled");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_NOTIFY_TOOL_LIST_CHANGE_ON_FIRST_LIST_TOOLS: "true",
            TEST_LIST_TOOLS_DELAY_AFTER_NOTIFICATION_MS: "100",
            TEST_CANCELLED_PATH: cancelledPath
          }
        }
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cancelled-tool-list-change-test", version: "1.0.0" });
    const controller = new AbortController();
    let notifyToolListChanged: (() => void) | undefined;
    const toolListChanged = new Promise<void>((resolve) => {
      notifyToolListChanged = resolve;
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifyToolListChanged?.();
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const pending = client.listTools(undefined, { signal: controller.signal });
      await toolListChanged;
      // Let the notification handler return before sending cancellation back to
      // the server; the fixture keeps its upstream response pending meanwhile.
      await delay(0);
      controller.abort("cancel after list change");
      await expect(pending).rejects.toThrow();
      await expect.poll(async () => access(cancelledPath).then(() => true, () => false)).toBe(true);
      await expect(client.callTool({ name: "whoami", arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
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
      const current = JSON.parse(content.text) as Record<string, unknown>;
      expect(current).toMatchObject({
        activeProfile: "work",
        defaultProfile: "work",
        selectionSource: "configured-default",
        selectedAt: expect.any(String),
        scope: "process",
        routingMode: "hybrid",
        identity: [{ status: "unconfigured", profile: "work", upstream: "default" }]
      });
      expect(current).not.toHaveProperty("revision");
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

  it("collects runtime roots once and routes repeated proxied calls from the cached context", async () => {
    const restoreProfile = withoutMiftahProfile();
    const fixture = await createRuntimeRoutingFixture();
    const runtime = await createMiftahRuntime(fixture.configPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "root-capable-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    let rootRequests = 0;
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      rootRequests += 1;
      return {
        roots: [{ uri: fixture.matchingRoot, name: "matching", _meta: { ignored: true } }]
      };
    });

    try {
      await Promise.all([runtime.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });
      expect(rootRequests).toBe(1);
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });
      expect(rootRequests).toBe(1);
    } finally {
      await client.close();
      await runtime.close();
      await rm(fixture.directory, { recursive: true, force: true });
      restoreProfile();
    }
  });

  it("routes proxied calls with empty roots when the initialized notification is dropped", async () => {
    const restoreProfile = withoutMiftahProfile();
    const fixture = await createRuntimeRoutingFixture();
    const runtime = await createMiftahRuntime(fixture.configPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "initialization-dropping-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    let rootRequests = 0;
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      rootRequests += 1;
      return { roots: [{ uri: fixture.matchingRoot }] };
    });

    try {
      await Promise.all([
        runtime.connect(serverTransport),
        client.connect(new DropInitializedNotificationTransport(clientTransport))
      ]);

      expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true } });
      expect(rootRequests).toBe(0);
      expect(
        await client.callTool({ name: "whoami", arguments: {} }, CallToolResultSchema, { timeout: 500 })
      ).toMatchObject({ content: [{ type: "text", text: "work" }] });
      expect(rootRequests).toBe(0);
    } finally {
      await client.close();
      await runtime.close();
      await rm(fixture.directory, { recursive: true, force: true });
      restoreProfile();
    }
  });

  it("keeps a relative runtime config distinct from a later project marker", async () => {
    const restoreProfile = withoutMiftahProfile();
    const originalCwd = process.cwd();
    const directory = await mkdtemp(join(originalCwd, ".miftah-runtime-config-path-"));
    const runtimeDirectory = join(directory, "runtime");
    const projectDirectory = join(directory, "project");
    let runtime: Awaited<ReturnType<typeof createMiftahRuntime>> | undefined;
    let client: Client | undefined;

    try {
      await Promise.all([mkdir(runtimeDirectory), mkdir(projectDirectory)]);
      await writeFile(
        join(runtimeDirectory, "miftah.json"),
        JSON.stringify({
          version: "1",
          name: "accounts",
          defaultProfile: "work",
          upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
          profiles: {
            work: { env: { TEST_ACCOUNT_NAME: "work" } },
            personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
          }
        })
      );
      await writeFile(join(projectDirectory, "miftah.json"), JSON.stringify({ profiles: { accounts: "personal" } }));

      process.chdir(runtimeDirectory);
      runtime = await createMiftahRuntime("miftah.json");
      process.chdir(projectDirectory);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      client = new Client(
        { name: "relative-runtime-config-client", version: "1.0.0" },
        { capabilities: { roots: {} } }
      );
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: [{ uri: pathToFileURL(projectDirectory).toString() }]
      }));

      await Promise.all([runtime.connect(serverTransport), client.connect(clientTransport)]);
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });
    } finally {
      await client?.close();
      await runtime?.close();
      process.chdir(originalCwd);
      await rm(directory, { recursive: true, force: true });
      restoreProfile();
    }
  });

  it("keeps fallback routing usable without roots and preserves direct-server empty context", async () => {
    const restoreProfile = withoutMiftahProfile();
    const routingFixture = await createRuntimeRoutingFixture();
    const runtime = await createMiftahRuntime(routingFixture.configPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const capabilities: { roots?: Record<string, never> } = { roots: {} };
    const client = new Client(
      { name: "roots-disabled-client", version: "1.0.0" },
      { capabilities }
    );
    let rootRequests = 0;
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      rootRequests += 1;
      return { roots: [] };
    });
    delete capabilities.roots;

    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { env: { TEST_ACCOUNT_NAME: "work" } } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [directClientTransport, directServerTransport] = InMemoryTransport.createLinkedPair();
    const directClient = new Client(
      { name: "direct-root-capable-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    let directRootRequests = 0;
    directClient.setRequestHandler(ListRootsRequestSchema, async () => {
      directRootRequests += 1;
      return { roots: [] };
    });

    try {
      await Promise.all([runtime.connect(serverTransport), client.connect(clientTransport)]);
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
      expect(rootRequests).toBe(0);

      await Promise.all([wrapper.connect(directServerTransport), directClient.connect(directClientTransport)]);
      expect(await directClient.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
      expect(directRootRequests).toBe(0);
    } finally {
      await client.close();
      await runtime.close();
      await directClient.close();
      await wrapper.close();
      await rm(routingFixture.directory, { recursive: true, force: true });
      restoreProfile();
    }
  });

  it("falls back after a failed runtime roots request without retrying per operation", async () => {
    const restoreProfile = withoutMiftahProfile();
    const fixture = await createRuntimeRoutingFixture();
    const runtime = await createMiftahRuntime(fixture.configPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "failing-roots-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    let rootRequests = 0;
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      rootRequests += 1;
      throw new Error("roots unavailable");
    });

    try {
      await Promise.all([runtime.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
      expect(rootRequests).toBe(1);
    } finally {
      await client.close();
      await runtime.close();
      await rm(fixture.directory, { recursive: true, force: true });
      restoreProfile();
    }
  });

  it("refreshes advertised roots once and ignores unadvertised roots changes", async () => {
    const restoreProfile = withoutMiftahProfile();
    const fixture = await createRuntimeRoutingFixture();
    const runtime = await createMiftahRuntime(fixture.configPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "root-change-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    let currentRoot = fixture.matchingRoot;
    let rootRequests = 0;
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      rootRequests += 1;
      return { roots: [{ uri: currentRoot }] };
    });

    const unchangedFixture = await createRuntimeRoutingFixture();
    const unchangedRuntime = await createMiftahRuntime(unchangedFixture.configPath);
    const [unchangedClientTransport, unchangedServerTransport] = InMemoryTransport.createLinkedPair();
    const unchangedClient = new Client(
      { name: "unadvertised-root-change-client", version: "1.0.0" },
      { capabilities: { roots: {} } }
    );
    let unchangedRoot = unchangedFixture.matchingRoot;
    let unchangedRootRequests = 0;
    unchangedClient.setRequestHandler(ListRootsRequestSchema, async () => {
      unchangedRootRequests += 1;
      return { roots: [{ uri: unchangedRoot }] };
    });

    try {
      await Promise.all([runtime.connect(serverTransport), client.connect(clientTransport)]);
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });
      expect(rootRequests).toBe(1);

      currentRoot = fixture.changedRoot;
      await client.notification({ method: "notifications/roots/list_changed" });
      await expect.poll(() => rootRequests).toBe(2);
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });

      await Promise.all([
        unchangedRuntime.connect(unchangedServerTransport),
        unchangedClient.connect(unchangedClientTransport)
      ]);
      expect(await unchangedClient.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });
      expect(unchangedRootRequests).toBe(1);

      unchangedRoot = unchangedFixture.changedRoot;
      const rootsChanged = RootsListChangedNotificationSchema.parse({
        method: "notifications/roots/list_changed"
      });
      await unchangedClientTransport.send({ jsonrpc: "2.0", ...rootsChanged });
      expect(await unchangedClient.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });
      expect(unchangedRootRequests).toBe(1);
    } finally {
      await client.close();
      await runtime.close();
      await unchangedClient.close();
      await unchangedRuntime.close();
      await rm(fixture.directory, { recursive: true, force: true });
      await rm(unchangedFixture.directory, { recursive: true, force: true });
      restoreProfile();
    }
  });

  it("refreshes again when roots change during an in-flight roots request", async () => {
    const restoreProfile = withoutMiftahProfile();
    const fixture = await createRuntimeRoutingFixture();
    const runtime = await createMiftahRuntime(fixture.configPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "overlapping-root-change-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    let firstRequestStarted!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      firstRequestStarted = resolve;
    });
    let releaseFirstRequest!: () => void;
    const firstRequestReleased = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let rootRequests = 0;
    let currentRoot = fixture.matchingRoot;
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      rootRequests += 1;
      const responseRoot = currentRoot;
      if (rootRequests === 1) {
        firstRequestStarted();
        await firstRequestReleased;
      }
      return { roots: [{ uri: responseRoot }] };
    });

    try {
      await Promise.all([runtime.connect(serverTransport), client.connect(clientTransport)]);
      await firstRequest;

      currentRoot = fixture.changedRoot;
      await client.notification({ method: "notifications/roots/list_changed" });
      releaseFirstRequest();
      await expect.poll(() => rootRequests).toBe(2);

      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "work" }]
      });
    } finally {
      await client.close();
      await runtime.close();
      await rm(fixture.directory, { recursive: true, force: true });
      restoreProfile();
    }
  });

  it("uses exactly one routing context snapshot per proxied operation", async () => {
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
        rules: [{ name: "context-profile", when: { "context.project": "personal" }, profile: "personal" }]
      }
    });
    const snapshots: RoutingContextSnapshot[] = [
      {
        context: { project: "personal" },
        evidence: { cwd: process.cwd(), fileRoots: [] },
        profileHints: []
      },
      {
        context: {},
        evidence: { cwd: process.cwd(), fileRoots: [] },
        profileHints: [
          {
            profile: "personal",
            source: "environment",
            evidence: { kind: "environment", variable: "MIFTAH_PROFILE" }
          }
        ]
      }
    ];
    let snapshotsCollected = 0;
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(
      config,
      new ProfileManager(config),
      manager,
      async () => {
        const snapshot = snapshots[snapshotsCollected];
        snapshotsCollected += 1;
        if (!snapshot) throw new Error("Unexpected routing context collection");
        return snapshot;
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "counting-context-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      expect(snapshotsCollected).toBe(0);

      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "personal" }]
      });
      expect(snapshotsCollected).toBe(2);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("returns unknown context profile errors without forwarding the proxied call", async () => {
    const originalProfile = process.env.MIFTAH_PROFILE;
    process.env.MIFTAH_PROFILE = "missing-profile";
    const callCountPath = join(process.cwd(), ".miftah-routing-context-call-count");
    const fixture = await createRuntimeRoutingFixture({ TEST_CALL_TOOL_COUNT_PATH: callCountPath });
    const runtime = await createMiftahRuntime(fixture.configPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "invalid-context-profile-client", version: "1.0.0" });

    try {
      await Promise.all([runtime.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("ROUTING_PROFILE_NOT_FOUND") }]
      });
      await expect(access(callCountPath)).rejects.toThrow();
    } finally {
      await client.close();
      await runtime.close();
      await rm(fixture.directory, { recursive: true, force: true });
      await rm(callCountPath, { force: true });
      if (originalProfile === undefined) delete process.env.MIFTAH_PROFILE;
      else process.env.MIFTAH_PROFILE = originalProfile;
    }
  });

  it("restores a workspace-scoped active profile and exposes safe selection metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-state-wrapper-"));
    const configPath = join(directory, "miftah.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "accounts",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
        profiles: { work: {}, personal: {} },
        state: { persistActiveProfile: true, scope: "workspace" }
      })
    );

    let firstRuntime: Awaited<ReturnType<typeof createMiftahRuntime>> | undefined;
    let firstClient: Client | undefined;
    let secondRuntime: Awaited<ReturnType<typeof createMiftahRuntime>> | undefined;
    let secondClient: Client | undefined;
    try {
      firstRuntime = await createMiftahRuntime(configPath);
      const [firstClientTransport, firstServerTransport] = InMemoryTransport.createLinkedPair();
      firstClient = new Client({ name: "profile-state-first", version: "1.0.0" });
      await Promise.all([firstRuntime.connect(firstServerTransport), firstClient.connect(firstClientTransport)]);

      await firstClient.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      expect(parseJsonToolResult(await firstClient.callTool({ name: "miftah_current_profile", arguments: {} }))).toMatchObject({
        activeProfile: "personal",
        selectionSource: "mcp-switch",
        scope: "workspace",
        selectedAt: expect.any(String)
      });
      await firstClient.close();
      firstClient = undefined;
      await firstRuntime.close();
      firstRuntime = undefined;

      secondRuntime = await createMiftahRuntime(configPath);
      const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
      secondClient = new Client({ name: "profile-state-second", version: "1.0.0" });
      await Promise.all([secondRuntime.connect(secondServerTransport), secondClient.connect(secondClientTransport)]);

      expect(parseJsonToolResult(await secondClient.callTool({ name: "miftah_current_profile", arguments: {} }))).toMatchObject({
        activeProfile: "personal",
        selectionSource: "persisted-workspace",
        scope: "workspace",
        selectedAt: expect.any(String)
      });
    } finally {
      await firstClient?.close();
      await firstRuntime?.close();
      await secondClient?.close();
      await secondRuntime?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resets a session-scoped selection when a new MCP connection opens", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: {}, personal: {} },
      security: { allowProfileSwitchingFromMcp: true },
      state: { scope: "session" }
    });
    const profiles = new ProfileManager(config, config.security, {
      ...config.state,
      configPath: join(tmpdir(), "miftah-session-state.json")
    });
    await profiles.initialize();
    await profiles.switchPersisted("personal");

    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, profiles, upstreams);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "session-profile-state", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      expect(parseJsonToolResult(await client.callTool({ name: "miftah_current_profile", arguments: {} }))).toMatchObject({
        activeProfile: "work",
        selectionSource: "configured-default",
        scope: "session"
      });
      expect(parseJsonToolResult(await client.callTool({ name: "miftah_route_preview", arguments: { toolName: "whoami" } }))).toMatchObject({
        profile: "work",
        reason: "active-profile"
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("serializes concurrent profile transitions with their routing side effects", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: {}, personal: {} },
      security: { allowProfileSwitchingFromMcp: true }
    });
    const profiles = new DelayedProfileManager(config, config.security);
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, profiles, upstreams);
    const host = wrapper as unknown as ProfileManagementHost;
    const audit = { update: () => undefined } as unknown as AuditScope;

    try {
      const switchToWork = host.handleManagement(
        "miftah_use_profile",
        { profile: "work" },
        audit,
        { activeProfile: "work", revision: 0 }
      );
      await profiles.firstSwitchEntered.promise;

      const secondHandlerEntered = deferred();
      const originalHandleManagement = host.handleManagement.bind(wrapper);
      let managementCalls = 1;
      host.handleManagement = async (...args) => {
        managementCalls += 1;
        if (managementCalls === 2) secondHandlerEntered.resolve();
        return originalHandleManagement(...args);
      };
      const switchToPersonal = host.handleManagement(
        "miftah_use_profile",
        { profile: "personal" },
        audit,
        { activeProfile: "work", revision: 0 }
      );
      await secondHandlerEntered.promise;
      profiles.releaseFirstSwitch.resolve();
      await Promise.all([switchToWork, switchToPersonal]);

      expect(profiles.current().activeProfile).toBe("personal");
      expect(host.routing.resolve({ toolName: "whoami", args: {}, context: {} })).toMatchObject({ profile: "personal" });
    } finally {
      await wrapper.close();
    }
  });
});
