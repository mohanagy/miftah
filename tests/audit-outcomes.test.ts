import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuditTrail } from "../src/audit/audit-trail.js";
import { validateConfig } from "../src/config/validate-config.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

interface ToolHandler {
  handleUpstreamTool(
    name: string,
    args: Record<string, unknown>,
    audit: ReturnType<AuditTrail["beginOperation"]>,
    source: { activeProfile: string; revision: number }
  ): Promise<unknown>;
}

async function waitForAuditEvent(
  path: string,
  matches: (event: Record<string, unknown>) => boolean,
  timeoutMs = 2_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const event = events.find(matches);
    if (event) return event;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for a matching audit event`);
    await delay(10);
  }
}

describe("audit outcomes", () => {
  it("records one terminal operation event for list, management, and unknown-tool requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-outcomes-"));
    const auditPath = join(directory, "audit.jsonl");
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
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config, config.security), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      expect(await client.callTool({ name: "missing_tool", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("TOOL_NOT_FOUND") }]
      });

      const events = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "operation");
      expect(events).toHaveLength(3);
      expect(new Set(events.map((event) => event.requestId)).size).toBe(3);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "tools/list",
            name: "tools",
            status: "success",
            sourceProfile: "work",
            profile: "work",
            upstream: "default",
            sessionId: expect.any(String)
          }),
          expect.objectContaining({
            operation: "profiles/switch",
            name: "personal",
            status: "success",
            sourceProfile: "work",
            profile: "personal",
            sessionId: expect.any(String)
          }),
          expect.objectContaining({
            operation: "tools/call",
            name: "missing_tool",
            status: "failure",
            sourceProfile: "personal",
            profile: "personal",
            errorCode: "TOOL_NOT_FOUND",
            sessionId: expect.any(String)
          })
        ])
      );
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records wrapper and lazy upstream lifecycle outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-lifecycle-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { env: { TEST_ACCOUNT_NAME: "work" } } },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();
      await client.close();
      await wrapper.close();

      const lifecycleEvents = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "lifecycle");
      expect(lifecycleEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "wrapper/start",
            name: "accounts",
            profile: "work",
            status: "success"
          }),
          expect.objectContaining({
            operation: "upstream/start",
            name: "default",
            upstream: "default",
            profile: "work",
            status: "success"
          }),
          expect.objectContaining({
            operation: "upstream/shutdown",
            name: "default",
            upstream: "default",
            profile: "work",
            status: "success"
          }),
          expect.objectContaining({
            operation: "wrapper/shutdown",
            name: "accounts",
            profile: "work",
            status: "success"
          })
        ])
      );
    } finally {
      await client.close().catch(() => undefined);
      await wrapper.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts secret-bearing discovery metadata before it reaches MCP clients", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-discovery-redaction-"));
    const auditPath = join(directory, "audit.jsonl");
    const secret = "discovery-output-secret";
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            API_TOKEN: secret,
            TEST_INCLUDE_DISCOVERY_TOKEN: "true"
          }
        }
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      const resources = await client.listResources();
      const prompts = await client.listPrompts();

      const clientOutput = JSON.stringify({ tools, resources, prompts });
      expect(clientOutput).not.toContain(secret);
      expect(clientOutput).toContain("[REDACTED]");
      expect(await readFile(auditPath, "utf8")).not.toContain(secret);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts discovery failures from client errors, health, and audit output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-discovery-failure-"));
    const auditPath = join(directory, "audit.jsonl");
    const secret = "discovery-error-secret";
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            API_TOKEN: secret,
            TEST_FAIL_LIST_RESOURCES: "true"
          }
        }
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await expect(client.listResources()).rejects.toThrow(/\[REDACTED\]/);
      await expect(client.listResources()).rejects.not.toThrow(secret);

      const health = await client.callTool({ name: "miftah_health", arguments: {} });
      const output = JSON.stringify(health);
      expect(output).not.toContain(secret);
      expect(output).toContain("[REDACTED]");
      expect(await readFile(auditPath, "utf8")).not.toContain(secret);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps MCP results available and exposes audit health when fail-open writes fail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-mcp-fail-open-"));
    const blockingPath = join(directory, "not-a-directory");
    await writeFile(blockingPath, "file");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { env: { TEST_ACCOUNT_NAME: "work" } } },
      audit: { path: join(blockingPath, "audit.jsonl"), failureMode: "fail-open" }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("whoami");
      const health = CallToolResultSchema.parse(
        await client.callTool({ name: "miftah_health", arguments: {} }, CallToolResultSchema)
      );
      const content = health.content[0];
      if (content?.type !== "text") throw new Error("Expected a text health result");
      expect(JSON.parse(content.text)).toMatchObject({
        audit: { state: "failed", lastFailure: { errorCode: "AUDIT_WRITE_FAILED" } }
      });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed with a stable error when an MCP audit write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-mcp-fail-closed-"));
    const blockingPath = join(directory, "not-a-directory");
    await writeFile(blockingPath, "file");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { env: { TEST_ACCOUNT_NAME: "work" } } },
      audit: { path: join(blockingPath, "audit.jsonl"), failureMode: "fail-closed" }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await expect(client.listTools()).rejects.toThrow(/AUDIT_WRITE_FAILED/);
      expect(await client.callTool({ name: "miftah_health", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("AUDIT_WRITE_FAILED") }]
      });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not mutate profile state when a fail-closed audit sink is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-mcp-preflight-"));
    const blockingPath = join(directory, "not-a-directory");
    await writeFile(blockingPath, "file");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      audit: { path: join(blockingPath, "audit.jsonl"), failureMode: "fail-closed" }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const profiles = new ProfileManager(config);
    const wrapper = new MiftahServer(config, profiles, manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("AUDIT_WRITE_FAILED") }]
      });
      expect(profiles.current().activeProfile).toBe("work");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps profile mutations fail-closed when ordinary audit logging is configured fail-open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-profile-fail-open-"));
    const blockingPath = join(directory, "not-a-directory");
    await writeFile(blockingPath, "file");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      security: { allowProfileSwitchingFromMcp: true, allowProfileLockingFromMcp: true },
      audit: { path: join(blockingPath, "audit.jsonl"), failureMode: "fail-open" }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-fail-open-audit-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("AUDIT_WRITE_FAILED") }]
      });
      expect(profiles.current()).toMatchObject({ activeProfile: "work", lock: { state: "none" } });
      expect(await client.callTool({ name: "miftah_lock_profile", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("AUDIT_WRITE_FAILED") }]
      });
      expect(profiles.current()).toMatchObject({ activeProfile: "work", lock: { state: "none" } });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records upstream crash and automatic recovery outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-recovery-"));
    const auditPath = join(directory, "audit.jsonl");
    const crashPath = join(directory, "crash");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          env: {
            TEST_ACCOUNT_NAME: "work",
            TEST_CRASH_ON_CALL_TOOL_PATH: crashPath
          }
        }
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, {
      startupTimeoutMs: 1_000,
      restartOnCrash: true,
      maxRestarts: 2
    });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();
      await writeFile(crashPath, "crash");
      const crashedRequest = client.callTool({ name: "whoami", arguments: {} }).catch(() => undefined);

      await waitForAuditEvent(auditPath, (event) => event.operation === "upstream/crash" && event.status === "failure");
      await unlink(crashPath);
      await waitForAuditEvent(auditPath, (event) => event.operation === "upstream/restart" && event.status === "success");
      await crashedRequest;
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records blocked management profile switches as denied outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-switch-denied-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      security: { allowProfileSwitchingFromMcp: false },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config, config.security), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_SWITCH_DISABLED") }]
      });
      expect(await waitForAuditEvent(
        auditPath,
        (event) => event.operation === "profiles/switch" && event.errorCode === "PROFILE_SWITCH_DISABLED"
      )).toMatchObject({ status: "denied" });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records safe profile confirmation, transition, lease, and runtime-lock actions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-profile-actions-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: {
          lease: { ttlMs: 60_000, requiredForRisk: ["write"] },
          env: { TEST_ACCOUNT_NAME: "personal" }
        }
      },
      security: {
        allowProfileSwitchingFromMcp: true,
        requireProfileSwitchConfirmation: true,
        allowProfileLockingFromMcp: true,
        approvalMode: "delegated-agent"
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-audit-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const requested = CallToolResultSchema.parse(
        await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })
      );
      const requestText = requested.content.find((item) => item.type === "text")?.text;
      const token = requestText?.match(/approval '([A-Za-z0-9_-]+)'/u)?.[1];
      if (!token) throw new Error("Expected a profile confirmation token.");
      await client.callTool({ name: "miftah_approve", arguments: { approval: token } });
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      await client.callTool({ name: "miftah_lock_profile", arguments: {} });
      await client.callTool({ name: "miftah_unlock_profile", arguments: {} });

      const profileEvents = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "profile");
      expect(profileEvents.map((event) => event.profileAction)).toEqual([
        "confirmation-requested",
        "confirmation-accepted",
        "switch",
        "lease-issued",
        "lock",
        "unlock"
      ]);
      expect(profileEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            profileAction: "switch",
            sourceProfile: "work",
            profile: "personal",
            operation: "profiles/switch",
            profileLeaseState: "active"
          }),
          expect.objectContaining({
            profileAction: "lock",
            profile: "personal",
            profileLockState: "runtime"
          }),
          expect.objectContaining({
            profileAction: "unlock",
            profile: "personal",
            profileLockState: "none"
          })
        ])
      );
      const approvalEvents = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "approval");
      expect(approvalEvents).toHaveLength(3);
      expect(approvalEvents.every((event) => event.approvalMechanism === "delegated-agent")).toBe(true);
      expect(JSON.stringify(profileEvents)).not.toContain(token);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records a static profile lock as wrapper startup metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-lock-metadata-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      security: { lockToProfile: "work" },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config, config.security), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      expect(await waitForAuditEvent(
        auditPath,
        (event) => event.operation === "wrapper/start" && event.kind === "lifecycle"
      )).toMatchObject({ lockToProfile: "work" });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a tool call on the profile captured before an intervening switch", async () => {
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
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const profiles = new ProfileManager(config);
    const wrapper = new MiftahServer(config, profiles, manager);
    const source = profiles.current();
    profiles.switch("personal");
    const audit = new AuditTrail("accounts").beginOperation({
      operation: "tools/call",
      name: "whoami",
      sourceProfile: source.activeProfile
    });

    try {
      expect(
        await (wrapper as unknown as ToolHandler).handleUpstreamTool("whoami", {}, audit, source)
      ).toMatchObject({ content: [{ type: "text", text: "work" }] });
    } finally {
      await wrapper.close();
    }
  });

  it("records the inspected profile for profile-info operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-profile-info-"));
    const auditPath = join(directory, "audit.jsonl");
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
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({ name: "miftah_profile_info", arguments: { profile: "personal" } });
      expect(await waitForAuditEvent(
        auditPath,
        (event) => event.operation === "management/profile-info" && event.name === "personal"
      )).toMatchObject({ sourceProfile: "work", profile: "personal" });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records upstream error results as failed tool operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-tool-result-error-"));
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
            TEST_RETURN_CALL_TOOL_ERROR: "true"
          }
        }
      },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 1_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      expect(await client.callTool({ name: "whoami", arguments: {} })).toMatchObject({ isError: true });
      expect(await waitForAuditEvent(
        auditPath,
        (event) => event.operation === "tools/call" && event.name === "whoami"
      )).toMatchObject({ status: "failure", errorCode: "UPSTREAM_CALL_FAILED" });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
