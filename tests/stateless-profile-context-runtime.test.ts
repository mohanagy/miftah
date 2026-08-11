import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, type JSONRPCMessage, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAuthenticatedRequestContextBoundary } from "../src/http/authenticated-request-context.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import {
  InMemoryProfileContextRevocationStore,
  PROFILE_CONTEXT_ARGUMENT,
  PROFILE_CONTEXT_META_KEY,
  ProfileContextHandleService,
  type ModernProfileContextRuntimeOptions
} from "../src/profiles/profile-context-handle.js";
import { validateConfig } from "../src/config/validate-config.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");
const nowMs = 2_000_000_000_000;

class AuthenticatedClientTransport implements Transport {
  constructor(
    private readonly delegate: InMemoryTransport,
    private readonly authInfo: () => AuthInfo | undefined
  ) {}

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

  set sessionId(value: string | undefined) {
    this.delegate.sessionId = value;
  }

  async start(): Promise<void> {
    await this.delegate.start();
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.delegate.send(message, {
      ...(options?.relatedRequestId === undefined ? {} : { relatedRequestId: options.relatedRequestId }),
      authInfo: this.authInfo()
    });
  }
}

function claims(chatContext: string) {
  return {
    issuer: "https://issuer.example",
    subject: "user-123",
    audience: "https://miftah.example",
    chatContext,
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60 * 60_000
  };
}

function authInfo(chatContext: string): AuthInfo {
  return {
    token: "validated-access-token",
    clientId: "trusted-host",
    scopes: ["mcp"],
    expiresAt: Math.floor((nowMs + 60 * 60_000) / 1_000),
    extra: { verifiedClaims: claims(chatContext) }
  };
}

function parseText(result: unknown): string {
  const parsed = CallToolResultSchema.parse(result);
  const content = parsed.content[0];
  if (content?.type !== "text") throw new Error("Expected a text tool result.");
  return content.text;
}

function profileHandle(result: unknown): string {
  const parsed: unknown = JSON.parse(parseText(result));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Expected object.");
  const context = (parsed as Record<string, unknown>).profileContext;
  if (typeof context !== "object" || context === null || Array.isArray(context)) throw new Error("Expected context.");
  const handle = (context as Record<string, unknown>).handle;
  if (typeof handle !== "string") throw new Error("Expected handle.");
  return handle;
}

function inputProperties(tool: Tool | undefined): Record<string, unknown> {
  const properties = tool?.inputSchema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return {};
  return properties;
}

describe("modern stateless profile-context runtime", () => {
  it("threads explicit handles across instances without changing legacy active-profile state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-stateless-profile-context-"));
    const firstAudit = join(directory, "first-audit.jsonl");
    const secondAudit = join(directory, "second-audit.jsonl");
    await mkdir(directory, { recursive: true });
    const baseConfig = {
      version: "1" as const,
      name: "accounts",
      defaultProfile: "personal",
      upstream: { transport: "stdio" as const, command: process.execPath, args: [fixture] },
      profiles: {
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } },
        work: { env: { TEST_ACCOUNT_NAME: "work" } }
      }
    };
    const firstConfig = validateConfig({ ...baseConfig, audit: { path: firstAudit, includeArguments: true } });
    const secondConfig = validateConfig({ ...baseConfig, audit: { path: secondAudit, includeArguments: true } });
    const sealingKey = Buffer.alloc(32, 0x61);
    const auditKey = Buffer.alloc(32, 0x62);
    const revocations = new InMemoryProfileContextRevocationStore();
    const keyringProvider = () => ({
      activeEpoch: 1,
      epochs: [{ epoch: 1, key: sealingKey, activatedAtMs: nowMs - 1_000 }]
    });
    const requestBoundary = createAuthenticatedRequestContextBoundary<unknown>({
      deploymentId: "miftah.example/deployment-a",
      bindingKey: Buffer.alloc(32, 0x41),
      auditKey: Buffer.alloc(32, 0x42),
      clock: () => nowMs,
      verifiedClaimsProvider: (request) => {
        const extra = (request as AuthInfo | undefined)?.extra;
        return extra?.verifiedClaims as ReturnType<typeof claims> | undefined;
      }
    });
    const modern = (): ModernProfileContextRuntimeOptions => ({
      handles: new ProfileContextHandleService({
        deploymentId: "miftah.example/deployment-a",
        profiles: ["personal", "work"],
        keyringProvider,
        auditKey,
        revocations,
        clock: () => nowMs
      }),
      authenticatedRequestContext: requestBoundary,
      handleLifetimeMs: 10 * 60_000
    });
    const noAuditConfig = validateConfig(baseConfig);
    const noAuditManager = new UpstreamProcessManager(noAuditConfig.upstream!, noAuditConfig.profiles, {
      startupTimeoutMs: 5_000
    });
    try {
      expect(() => new MiftahServer(
        noAuditConfig,
        new ProfileManager(noAuditConfig),
        noAuditManager,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        modern()
      )).toThrow(/modern profile context requires a configured audit journal/u);
    } finally {
      await noAuditManager.close();
    }
    const firstManager = new UpstreamProcessManager(firstConfig.upstream!, firstConfig.profiles, {
      startupTimeoutMs: 5_000
    });
    const secondManager = new UpstreamProcessManager(secondConfig.upstream!, secondConfig.profiles, {
      startupTimeoutMs: 5_000
    });
    const firstProfiles = new ProfileManager(firstConfig);
    const secondProfiles = new ProfileManager(secondConfig);
    const first = new MiftahServer(
      firstConfig,
      firstProfiles,
      firstManager,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      modern()
    );
    const second = new MiftahServer(
      secondConfig,
      secondProfiles,
      secondManager,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      modern()
    );
    const [firstClientTransport, firstServerTransport] = InMemoryTransport.createLinkedPair();
    const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
    let firstAuthentication: AuthInfo | undefined = authInfo("chat-work");
    const secondChat = "chat-work";
    const firstClient = new Client({ name: "modern-client-a", version: "1.0.0" });
    const secondClient = new Client({ name: "modern-client-b", version: "1.0.0" });

    try {
      await Promise.all([
        first.connect(firstServerTransport),
        second.connect(secondServerTransport),
        firstClient.connect(new AuthenticatedClientTransport(firstClientTransport, () => firstAuthentication)),
        secondClient.connect(new AuthenticatedClientTransport(secondClientTransport, () => authInfo(secondChat)))
      ]);

      const toolsBefore = await firstClient.listTools();
      const useProfile = toolsBefore.tools.find((tool) => tool.name === "miftah_use_profile");
      const currentProfile = toolsBefore.tools.find((tool) => tool.name === "miftah_current_profile");
      const listProfiles = toolsBefore.tools.find((tool) => tool.name === "miftah_list_profiles");
      const whoami = toolsBefore.tools.find((tool) => tool.name === "whoami");
      expect(inputProperties(useProfile)).toHaveProperty(PROFILE_CONTEXT_ARGUMENT);
      expect(useProfile?.inputSchema.required).not.toContain(PROFILE_CONTEXT_ARGUMENT);
      expect(inputProperties(currentProfile)).toHaveProperty(PROFILE_CONTEXT_ARGUMENT);
      expect(currentProfile?.inputSchema.required).toContain(PROFILE_CONTEXT_ARGUMENT);
      expect(inputProperties(listProfiles)).not.toHaveProperty(PROFILE_CONTEXT_ARGUMENT);
      expect(inputProperties(whoami)).toHaveProperty(PROFILE_CONTEXT_ARGUMENT);
      expect(whoami?.inputSchema.required).toContain(PROFILE_CONTEXT_ARGUMENT);

      firstAuthentication = undefined;
      await expect(firstClient.listTools()).rejects.toThrow(/PROFILE_CONTEXT_UNAVAILABLE/u);
      await expect(firstClient.callTool({ name: "miftah_list_profiles" })).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: "PROFILE_CONTEXT_UNAVAILABLE: Profile context is unavailable." }]
      });
      firstAuthentication = authInfo("chat-work");

      const workHandle = profileHandle(await firstClient.callTool({
        name: "miftah_use_profile",
        arguments: { profile: "work" }
      }));
      expect(firstProfiles.current().activeProfile).toBe("personal");

      const secondIdentity = await secondClient.callTool({
        name: "whoami",
        arguments: { [PROFILE_CONTEXT_ARGUMENT]: workHandle }
      });
      expect(parseText(secondIdentity)).toContain("work");
      expect(JSON.stringify(secondIdentity)).not.toContain(workHandle);
      expect(secondProfiles.current().activeProfile).toBe("personal");

      const echo = await firstClient.callTool({
        name: "echo",
        arguments: { message: "safe", [PROFILE_CONTEXT_ARGUMENT]: workHandle }
      });
      expect(parseText(echo)).toContain("safe");
      expect(JSON.stringify(echo)).not.toContain(workHandle);
      await expect(firstClient.callTool({
        name: "echo",
        arguments: {
          message: `embedded ${workHandle}`,
          [PROFILE_CONTEXT_ARGUMENT]: workHandle
        }
      })).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: "PROFILE_CONTEXT_INVALID: Profile context is invalid." }]
      });

      const resource = await secondClient.readResource({
        uri: "account://current",
        _meta: { [PROFILE_CONTEXT_META_KEY]: workHandle }
      });
      expect(resource).toMatchObject({ contents: [{ text: "work" }] });
      await expect(secondClient.getPrompt({
        name: "account_prompt",
        arguments: { message: `embedded ${workHandle}` },
        _meta: { [PROFILE_CONTEXT_META_KEY]: workHandle }
      })).rejects.toThrow(/PROFILE_CONTEXT_INVALID/u);

      firstAuthentication = authInfo("chat-personal");
      await expect(firstClient.callTool({
        name: "whoami",
        arguments: { [PROFILE_CONTEXT_ARGUMENT]: workHandle }
      })).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: "PROFILE_CONTEXT_INVALID: Profile context is invalid." }]
      });
      firstAuthentication = authInfo("chat-work");

      const personalHandle = profileHandle(await secondClient.callTool({
        name: "miftah_use_profile",
        arguments: { profile: "personal", [PROFILE_CONTEXT_ARGUMENT]: workHandle }
      }));
      expect(personalHandle).not.toBe(workHandle);
      await expect(firstClient.callTool({
        name: "whoami",
        arguments: { [PROFILE_CONTEXT_ARGUMENT]: workHandle }
      })).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: "PROFILE_CONTEXT_REVOKED: Profile context has been revoked." }]
      });
      expect(parseText(await firstClient.callTool({
        name: "whoami",
        arguments: { [PROFILE_CONTEXT_ARGUMENT]: personalHandle }
      }))).toContain("personal");

      const toolsAfter = await secondClient.listTools();
      expect(toolsAfter.tools).toEqual(toolsBefore.tools);
      expect(firstProfiles.current().activeProfile).toBe("personal");
      expect(secondProfiles.current().activeProfile).toBe("personal");

      const auditText = `${await readFile(firstAudit, "utf8")}\n${await readFile(secondAudit, "utf8")}`;
      expect(auditText).not.toContain(workHandle);
      expect(auditText).not.toContain(personalHandle);
      expect(auditText).toMatch(/"profileContextCorrelation":"mctxc1\.[A-Za-z0-9_-]{22}"/u);
    } finally {
      await Promise.allSettled([
        firstClient.close(),
        secondClient.close(),
        first.close(),
        second.close(),
        firstManager.close(),
        secondManager.close()
      ]);
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  }, 30_000);
});
