import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomUUID } from "node:crypto";
import {
  CallToolResultSchema,
  ListRootsRequestSchema,
  RootsListChangedNotificationSchema,
  ToolListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { expectExactlyOneNotification } from "./helpers/notifications.js";
import { validateConfig } from "../src/config/validate-config.js";
import type { MiftahConfig } from "../src/config/types.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { createMiftahRuntime } from "../src/runtime/create-miftah-runtime.js";
import type { RoutingContextSnapshot } from "../src/routing/routing-types.js";
import { MultiUpstreamProcessManager } from "../src/upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");
const toolCollisionPattern = /TOOL_COLLISION/;

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

describe("Miftah MCP wrapper", () => {
  it("reports configured identity status without probing upstreams from management surfaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-identity-management-"));
    const callCountPath = join(directory, "tool-call-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: { TEST_CALL_TOOL_COUNT_PATH: callCountPath },
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
        routingMode: "hybrid",
        identity: [{ status: "unconfigured", profile: "work", upstream: "default" }]
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
});
