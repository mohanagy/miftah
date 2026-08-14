import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { AuthInfo, Transport, TransportSendOptions, JSONRPCMessage, Tool } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
  isInputRequiredResult,
  withInputRequired
} from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAuthenticatedRequestContextBoundary } from "../src/http/authenticated-request-context.js";
import { startMiftahHttpServer } from "../src/http/miftah-http-server.js";
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
import { createMiftahServerFactory } from "../src/runtime/create-miftah-runtime.js";
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

/** Parses the safe JSON envelope returned by modern profile selection tools. */
function profileSelectionResult(result: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(parseText(result));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Expected object.");
  return parsed as Record<string, unknown>;
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
        const authenticatedRequest = request as AuthInfo | undefined;
        if (authenticatedRequest?.clientId === "failing-host") throw new Error("private verifier failure");
        const extra = authenticatedRequest?.extra;
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
      firstAuthentication = {
        ...authInfo("chat-work"),
        extra: { verifiedClaims: { ...claims("chat-work"), issuedAtMs: "invalid" } }
      };
      await expect(firstClient.listTools()).rejects.toThrow(/PROFILE_CONTEXT_INVALID/u);
      firstAuthentication = { ...authInfo("chat-work"), clientId: "failing-host" };
      await expect(firstClient.listTools()).rejects.toThrow(/PROFILE_CONTEXT_UNAVAILABLE/u);
      firstAuthentication = authInfo("chat-work");

      const workSelection = await firstClient.callTool({
        name: "miftah_use_profile",
        arguments: { profile: "work" }
      });
      expect(profileSelectionResult(workSelection)).toMatchObject({
        message: "Active profile changed from personal to work. Scope: session. This selection ends with the current MCP session; a fresh session starts from the configured default profile.",
        profileState: {
          activeProfile: "work",
          scope: "session",
          persistence: "temporary",
          survivesProcessRestart: false,
          restartBehavior: "configured-default"
        }
      });
      const workHandle = profileHandle(workSelection);
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
      const prototypeArguments = JSON.parse(
        '{"message":"prototype-safe","__proto__":{"polluted":true}}'
      ) as Record<string, unknown>;
      prototypeArguments[PROFILE_CONTEXT_ARGUMENT] = workHandle;
      expect(parseText(await firstClient.callTool({ name: "echo", arguments: prototypeArguments }))).toContain(
        "prototype-safe"
      );
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
      await expect(firstClient.callTool({
        name: `echo-${workHandle}`,
        arguments: { [PROFILE_CONTEXT_ARGUMENT]: workHandle }
      })).resolves.toMatchObject({
        isError: true,
        content: [{ type: "text", text: "PROFILE_CONTEXT_INVALID: Profile context is invalid." }]
      });
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

      const resetSelection = await secondClient.callTool({
        name: "miftah_reset_profile",
        arguments: { [PROFILE_CONTEXT_ARGUMENT]: personalHandle }
      });
      expect(profileSelectionResult(resetSelection)).toMatchObject({
        message: "Active profile reset from personal to personal. Scope: session. This selection ends with the current MCP session; a fresh session starts from the configured default profile.",
        profileState: {
          activeProfile: "personal",
          scope: "session",
          persistence: "temporary",
          survivesProcessRestart: false,
          restartBehavior: "configured-default"
        }
      });
      const resetHandle = profileHandle(resetSelection);
      expect(resetHandle).not.toBe(personalHandle);

      const toolsAfter = await secondClient.listTools();
      expect(toolsAfter.tools).toEqual(toolsBefore.tools);
      expect(firstProfiles.current().activeProfile).toBe("personal");
      expect(secondProfiles.current().activeProfile).toBe("personal");

      const auditText = `${await readFile(firstAudit, "utf8")}\n${await readFile(secondAudit, "utf8")}`;
      expect(auditText).not.toContain(workHandle);
      expect(auditText).not.toContain(personalHandle);
      expect(auditText).not.toContain(resetHandle);
      expect(auditText).toMatch(/"profileContextCorrelation":"mctxc1\.[A-Za-z0-9_-]{22}"/u);
      const auditEvents = auditText
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(auditEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "operation",
          operation: "tools/list",
          sourceProfile: "personal",
          status: "failure",
          errorCode: "PROFILE_CONTEXT_INVALID"
        }),
        expect.objectContaining({
          kind: "operation",
          operation: "tools/list",
          sourceProfile: "personal",
          status: "failure",
          errorCode: "PROFILE_CONTEXT_UNAVAILABLE"
        }),
        expect.objectContaining({
          kind: "operation",
          operation: "management/list-profiles",
          sourceProfile: "personal",
          status: "failure",
          errorCode: "PROFILE_CONTEXT_UNAVAILABLE"
        }),
        expect.objectContaining({
          kind: "operation",
          operation: "prompts/get",
          sourceProfile: "personal",
          status: "failure",
          errorCode: "PROFILE_CONTEXT_INVALID"
        })
      ]));
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

  it("binds one-time MRTR approval state to the authenticated chat and exact profile handle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-stateless-mrtr-binding-"));
    const configPath = join(directory, "miftah.json");
    const auditPath = join(directory, "audit.jsonl");
    const createCountPath = join(directory, "create-count");
    await writeFile(configPath, JSON.stringify({
      version: "1",
      name: "accounts",
      defaultProfile: "personal",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } },
        work: {
          policy: "confirm",
          env: { TEST_ACCOUNT_NAME: "work", TEST_CREATE_ITEM_COUNT_PATH: createCountPath }
        }
      },
      policies: { confirm: { requireConfirmation: ["create_item"] } },
      audit: { path: auditPath, includeArguments: true },
      server: { http: { port: 0 } }
    }));
    const requestBoundary = createAuthenticatedRequestContextBoundary<unknown>({
      deploymentId: "miftah.example/mrtr-binding",
      bindingKey: Buffer.alloc(32, 0x51),
      auditKey: Buffer.alloc(32, 0x52),
      clock: () => nowMs,
      verifiedClaimsProvider: (request) => {
        const extra = (request as AuthInfo | undefined)?.extra;
        return extra?.verifiedClaims as ReturnType<typeof claims> | undefined;
      }
    });
    const modernProfileContext = {
      handles: new ProfileContextHandleService({
        deploymentId: "miftah.example/mrtr-binding",
        profiles: ["personal", "work"],
        keyringProvider: () => ({
          activeEpoch: 1,
          epochs: [{ epoch: 1, key: Buffer.alloc(32, 0x53), activatedAtMs: nowMs - 1_000 }]
        }),
        auditKey: Buffer.alloc(32, 0x54),
        revocations: new InMemoryProfileContextRevocationStore(),
        clock: () => nowMs
      }),
      authenticatedRequestContext: requestBoundary
    };
    let authentication: AuthInfo | undefined = authInfo("chat-a");
    const server = await startMiftahHttpServer(configPath, {
      modernServerFactory: createMiftahServerFactory(configPath, { modernProfileContext })
    });
    const nodeServer = (server as unknown as {
      readonly server: {
        prependListener(event: "request", listener: (request: { auth?: AuthInfo }) => void): void;
      };
    }).server;
    nodeServer.prependListener("request", (request) => {
      request.auth = authentication;
    });
    const client = new Client(
      { name: "modern-mrtr-binding-client", version: "1.0.0" },
      {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        capabilities: { elicitation: { form: {} } },
        inputRequired: { autoFulfill: false }
      }
    );
    const accepted = { approval: { action: "accept" as const, content: { approved: true } } };

    const requestCreate = async (
      handle: string,
      continuation?: { readonly requestState: string; readonly inputResponses: typeof accepted }
    ) => client.request(
      {
        method: "tools/call",
        params: {
          name: "create_item",
          arguments: { name: "principal-bound", [PROFILE_CONTEXT_ARGUMENT]: handle },
          ...(continuation ?? {})
        }
      },
      withInputRequired(CallToolResultSchema),
      { allowInputRequired: true }
    );

    try {
      await client.connect(new StreamableHTTPClientTransport(server.url));

      const handleA = profileHandle(await client.callTool({
        name: "miftah_use_profile",
        arguments: { profile: "work" }
      }));
      authentication = authInfo("chat-b");
      const handleB = profileHandle(await client.callTool({
        name: "miftah_use_profile",
        arguments: { profile: "work" }
      }));

      authentication = authInfo("chat-a");
      const firstRound = await requestCreate(handleA);
      if (!isInputRequiredResult(firstRound) || firstRound.requestState === undefined) {
        throw new Error(`Expected an integrity-bound approval continuation: ${JSON.stringify(firstRound)}`);
      }
      expect(firstRound.inputRequests).toHaveProperty("approval");
      const continuation = { requestState: firstRound.requestState, inputResponses: accepted };

      authentication = authInfo("chat-b");
      expect(await requestCreate(handleB, continuation)).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("APPROVAL_INVALID") }]
      });

      authentication = authInfo("chat-a");
      expect(await requestCreate(handleA, continuation)).toMatchObject({
        content: [{ type: "text", text: "created:principal-bound" }]
      });
      await expect(requestCreate(handleA, continuation)).rejects.toThrow(/requestState/u);
      expect(await readFile(createCountPath, "utf8")).toBe("1\n");

      const auditText = await readFile(auditPath, "utf8");
      expect(auditText).not.toContain(handleA);
      expect(auditText).not.toContain(handleB);
      expect(auditText).not.toContain(firstRound.requestState);
      expect(auditText).not.toContain('"requestState"');
      expect(auditText).not.toContain('"inputResponses"');
      const events = auditText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const operationEvents = events.filter(
        (event) => event.kind === "operation" && event.operation === "tools/call" && event.name === "create_item"
      );
      expect(operationEvents.length).toBeGreaterThanOrEqual(3);
      for (const event of operationEvents) expect(event.arguments).toEqual({ name: "principal-bound" });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "operation",
          operation: "tools/call",
          status: "confirmation-required",
          errorCode: "POLICY_CONFIRMATION_REQUIRED"
        }),
        expect.objectContaining({
          kind: "operation",
          operation: "tools/call",
          status: "failure",
          errorCode: "APPROVAL_INVALID"
        }),
        expect.objectContaining({ kind: "operation", operation: "tools/call", status: "success" })
      ]));
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  }, 20_000);

  it("enforces strict cross-profile tool discovery whenever modern mode is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-stateless-strict-discovery-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "personal",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } },
        work: { env: { TEST_ACCOUNT_NAME: "work", TEST_WHOAMI_SCHEMA: "account" } }
      },
      audit: { path: auditPath }
    });
    const requestBoundary = createAuthenticatedRequestContextBoundary<unknown>({
      deploymentId: "miftah.example/strict-discovery",
      bindingKey: Buffer.alloc(32, 0x31),
      auditKey: Buffer.alloc(32, 0x32),
      clock: () => nowMs,
      verifiedClaimsProvider: (request) => {
        const extra = (request as AuthInfo | undefined)?.extra;
        return extra?.verifiedClaims as ReturnType<typeof claims> | undefined;
      }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(
      config,
      new ProfileManager(config),
      manager,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        handles: new ProfileContextHandleService({
          deploymentId: "miftah.example/strict-discovery",
          profiles: ["personal", "work"],
          keyringProvider: () => ({
            activeEpoch: 1,
            epochs: [{ epoch: 1, key: Buffer.alloc(32, 0x33), activatedAtMs: nowMs - 1_000 }]
          }),
          auditKey: Buffer.alloc(32, 0x34),
          revocations: new InMemoryProfileContextRevocationStore(),
          clock: () => nowMs
        }),
        authenticatedRequestContext: requestBoundary
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "modern-strict-client", version: "1.0.0" });

    try {
      await Promise.all([
        wrapper.connect(serverTransport),
        client.connect(new AuthenticatedClientTransport(clientTransport, () => authInfo("strict-chat")))
      ]);
      await expect(client.listTools()).rejects.toThrow(/TOOL_SCHEMA_MISMATCH: strict tools discovery/u);
      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toContainEqual(expect.objectContaining({
        kind: "operation",
        operation: "tools/list",
        status: "failure",
        errorCode: "TOOL_SCHEMA_MISMATCH"
      }));
    } finally {
      await Promise.allSettled([client.close(), wrapper.close(), manager.close()]);
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  }, 20_000);
});
