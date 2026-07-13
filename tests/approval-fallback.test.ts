import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { ApprovalStore } from "../src/approvals/approval-store.js";
import { MiftahError } from "../src/utils/errors.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

describe("approval fallback", () => {
  it("invalidates pending approvals when an MCP connection begins", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: {} }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const approvals = (wrapper as unknown as { approvals: ApprovalStore }).approvals;
    const requested = approvals.request({
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-session-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(() => approvals.approve(requested.token)).toThrow(expect.objectContaining({ code: "APPROVAL_INVALID" }));
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("advertises management tools for listing and deciding pending approvals", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: {} }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-fallback-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["miftah_list_approvals", "miftah_approve", "miftah_deny"])
      );
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("returns a one-time fallback approval without forwarding a confirmation-required call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-fallback-"));
    const createCountPath = join(directory, "create-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          policy: "confirm",
          env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath }
        }
      },
      policies: { confirm: { requireConfirmation: ["create_item"] } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-fallback-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const result = await client.callTool({ name: "create_item", arguments: { name: "first" } });

      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringMatching(
              /POLICY_CONFIRMATION_REQUIRED: approval required for 'create_item'\. Use miftah_approve with approval '[A-Za-z0-9_-]+' then retry the exact operation\./u
            )
          }
        ]
      });
      await expect(access(createCountPath)).rejects.toThrow();
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a connection-bound approval before switching profiles when configured", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      security: { allowProfileSwitchingFromMcp: true, requireProfileSwitchConfirmation: true },
      audit: { enabled: false }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-switch-approval-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const requested = await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      const requestText = textContent(requested);
      const token = requestText.match(/approval '([A-Za-z0-9_-]+)'/u)?.[1];

      expect(requested).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_SWITCH_CONFIRMATION_REQUIRED") }]
      });
      expect(profiles.current().activeProfile).toBe("work");
      if (!token) throw new Error(`Expected a profile-switch approval token, received: ${requestText}`);

      expect(await client.callTool({ name: "miftah_approve", arguments: { approval: token } })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("Approval granted") }]
      });
      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("personal") }]
      });
      expect(profiles.current()).toMatchObject({ activeProfile: "personal", confirmation: "confirmed" });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("revokes a profile confirmation when its coupled approval and profile audit batch fails", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: {}, personal: {} },
      security: { allowProfileSwitchingFromMcp: true, requireProfileSwitchConfirmation: true },
      audit: { enabled: false }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, manager);
    let auditBatches = 0;
    const host = wrapper as unknown as {
      approvals: ApprovalStore;
      auditTrail: {
        writeApprovalAndProfile(approval: unknown, profile: unknown): Promise<void>;
      };
    };
    host.auditTrail.writeApprovalAndProfile = async () => {
      auditBatches += 1;
      throw new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: test confirmation audit batch rejected transition");
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-confirmation-audit-batch-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("AUDIT_WRITE_FAILED") }]
      });
      expect(auditBatches).toBe(1);
      expect(host.approvals.list()).toEqual([]);
      expect(profiles.current()).toMatchObject({ activeProfile: "work", confirmation: "not-confirmed" });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("uses native elicitation to confirm a profile switch for form-capable clients", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: {}, personal: {} },
      security: { allowProfileSwitchingFromMcp: true, requireProfileSwitchConfirmation: true },
      audit: { enabled: false }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "profile-switch-elicit-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } }
    );
    const elicitationRequests: unknown[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitationRequests.push(request);
      return { action: "accept", content: { approved: true } };
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("personal") }]
      });
      expect(elicitationRequests).toHaveLength(1);
      expect(elicitationRequests[0]).toMatchObject({
        params: {
          mode: "form",
          requestedSchema: {
            properties: { approved: { type: "boolean" } },
            required: ["approved"]
          }
        }
      });
      expect(JSON.stringify(elicitationRequests)).not.toContain("approval '");
      expect(profiles.current()).toMatchObject({ activeProfile: "personal", confirmation: "confirmed" });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("keeps the active profile unchanged when native switch confirmation is declined", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: {}, personal: {} },
      security: { allowProfileSwitchingFromMcp: true, requireProfileSwitchConfirmation: true },
      audit: { enabled: false }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "profile-switch-decline-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } }
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approved: false } }));

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_SWITCH_CONFIRMATION_REQUIRED") }]
      });
      expect(profiles.current()).toMatchObject({ activeProfile: "work", confirmation: "not-confirmed" });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("does not hold the profile-transition queue while a profile confirmation form is open", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: {}, personal: {} },
      security: {
        allowProfileSwitchingFromMcp: true,
        requireProfileSwitchConfirmation: true,
        allowProfileLockingFromMcp: true
      },
      audit: { enabled: false }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "profile-switch-queue-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } }
    );
    let formOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      formOpened = resolve;
    });
    let acceptForm: (() => void) | undefined;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      formOpened();
      return new Promise((resolve) => {
        acceptForm = () => resolve({ action: "accept", content: { approved: true } });
      });
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const switching = client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      await opened;

      const lock = await Promise.race([
        client.callTool({ name: "miftah_lock_profile", arguments: {} }),
        delay(1_000).then(() => {
          throw new Error("Profile lock waited for an unresolved confirmation form.");
        })
      ]);
      expect(lock).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("profileState") }] });
      if (!acceptForm) throw new Error("Expected a pending profile confirmation form.");
      acceptForm();
      expect(await switching).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_LOCKED") }]
      });
      expect(profiles.current()).toMatchObject({ activeProfile: "work", lock: { state: "runtime" } });
    } finally {
      acceptForm?.();
      await client.close();
      await wrapper.close();
    }
  });

  it("issues a fallback bearer that remains usable after secret redaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-redaction-"));
    const createCountPath = join(directory, "create-count");
    let tokenAttempt = 0;
    const approvals = new ApprovalStore({
      createToken: () => (tokenAttempt++ === 0 ? "unsafe-bearer" : "safe-bearer")
    });
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          policy: "confirm",
          env: { API_TOKEN: "unsafe", TEST_CREATE_ITEM_COUNT_PATH: createCountPath }
        }
      },
      policies: { confirm: { requireConfirmation: ["create_item"] } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    (wrapper as unknown as { approvals: ApprovalStore }).approvals = approvals;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-redaction-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      const requested = textContent(await client.callTool({ name: "create_item", arguments: { name: "first" } }));
      expect(requested).toContain("approval 'safe-bearer'");
      expect(await client.callTool({ name: "miftah_approve", arguments: { approval: "safe-bearer" } })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("Approval granted") }]
      });
      expect(await client.callTool({ name: "create_item", arguments: { name: "first" } })).toMatchObject({
        content: [{ type: "text", text: "created:first" }]
      });
      expect(await readFile(createCountPath, "utf8")).toBe("1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes a newly-created approval when its required audit transition fails", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm" } },
      policies: { confirm: { requireConfirmation: ["create_item"] } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const host = wrapper as unknown as { approvals: ApprovalStore; writeApproval(): Promise<void> };
    host.writeApproval = async () => {
      throw new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: test sink rejected approval event");
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-audit-failure-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "create_item", arguments: { name: "first" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("AUDIT_WRITE_FAILED") }]
      });
      expect(host.approvals.list()).toEqual([]);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("lists pending approvals safely and makes an explicit denial non-replayable", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm" } },
      policies: { confirm: { requireConfirmation: ["create_item"] } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-deny-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const requested = await client.callTool({ name: "create_item", arguments: { name: "first" } });
      const token = textContent(requested).match(/approval '([A-Za-z0-9_-]+)'/u)?.[1];
      if (!token) throw new Error("Expected a fallback approval token.");

      const listed = textContent(await client.callTool({ name: "miftah_list_approvals", arguments: {} }));
      expect(listed).toContain('"status":"pending"');
      expect(listed).not.toContain(token);
      expect(await client.callTool({ name: "miftah_deny", arguments: { approval: token } })).toMatchObject({
        content: [{ type: "text", text: "Approval denied." }]
      });
      expect(JSON.parse(textContent(await client.callTool({ name: "miftah_list_approvals", arguments: {} })))).toEqual([]);

      const retried = await client.callTool({ name: "create_item", arguments: { name: "first" } });
      const replacement = textContent(retried).match(/approval '([A-Za-z0-9_-]+)'/u)?.[1];
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(token);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("revokes an approval when recording its approval transition fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-approve-audit-failure-"));
    const createCountPath = join(directory, "create-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm", env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath } } },
      policies: { confirm: { requireConfirmation: ["create_item"] } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const host = wrapper as unknown as {
      approvals: ApprovalStore;
      writeApproval(action: string, approval: unknown): Promise<void>;
    };
    const originalWriteApproval = host.writeApproval.bind(wrapper);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-approve-audit-failure-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const requested = await client.callTool({ name: "create_item", arguments: { name: "first" } });
      const token = textContent(requested).match(/approval '([A-Za-z0-9_-]+)'/u)?.[1];
      if (!token) throw new Error("Expected a fallback approval token.");
      host.writeApproval = async () => {
        throw new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: test sink rejected approval event");
      };

      expect(await client.callTool({ name: "miftah_approve", arguments: { approval: token } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("AUDIT_WRITE_FAILED") }]
      });
      host.writeApproval = originalWriteApproval;

      expect(await client.callTool({ name: "create_item", arguments: { name: "first" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("POLICY_CONFIRMATION_REQUIRED") }]
      });
      await expect(access(createCountPath)).rejects.toThrow();
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not consume an approval while its approval audit transition is unresolved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-audit-race-"));
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm" } },
      policies: { confirm: { requireConfirmation: ["create_item"] } },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const host = wrapper as unknown as {
      approvals: ApprovalStore;
      writeApproval(action: string, approval: unknown): Promise<void>;
      handleManagement(
        name: string,
        args: Record<string, unknown>,
        audit: unknown,
        source: unknown
      ): Promise<unknown>;
      requireApproval(binding: {
        sourceProfile: string;
        profile: string;
        upstream: string;
        operation: string;
        name: string;
        displayName: string;
        arguments: Record<string, unknown>;
      }): Promise<void>;
    };
    const originalWriteApproval = host.writeApproval.bind(wrapper);
    let beginApprovedAudit: () => void = () => undefined;
    const approvedAuditStarted = new Promise<void>((resolve) => {
      beginApprovedAudit = resolve;
    });
    let rejectApprovedAudit: (reason: unknown) => void = () => undefined;
    const approvedAudit = new Promise<never>((_, reject) => {
      rejectApprovedAudit = reject;
    });
    const binding = {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    };
    const requested = host.approvals.request(binding);

    try {
      host.writeApproval = async (action, approval) => {
        if (action === "approved") {
          beginApprovedAudit();
          await approvedAudit;
        }
        await originalWriteApproval(action, approval);
      };

      const approving = host.handleManagement(
        "miftah_approve",
        { approval: requested.token },
        {},
        { activeProfile: "work", revision: 0 }
      );
      await approvedAuditStarted;
      const retried = host.requireApproval(binding);
      rejectApprovedAudit(new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: test sink rejected approval event"));

      await expect(approving).rejects.toThrow("AUDIT_WRITE_FAILED");
      await expect(retried).rejects.toThrow("POLICY_CONFIRMATION_REQUIRED");
    } finally {
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not disclose a duplicate fallback while its requested audit transition is unresolved", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm" } },
      policies: { confirm: { requireConfirmation: ["create_item"] } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const host = wrapper as unknown as {
      writeApproval(action: string, approval: unknown): Promise<void>;
      requireApproval(binding: {
        sourceProfile: string;
        profile: string;
        upstream: string;
        operation: string;
        name: string;
        displayName: string;
        arguments: Record<string, unknown>;
      }): Promise<void>;
    };
    let beginRequestedAudit: () => void = () => undefined;
    const requestedAuditStarted = new Promise<void>((resolve) => {
      beginRequestedAudit = resolve;
    });
    let rejectRequestedAudit: (reason: unknown) => void = () => undefined;
    const requestedAudit = new Promise<never>((_, reject) => {
      rejectRequestedAudit = reject;
    });
    let requestedWrites = 0;
    host.writeApproval = async (action) => {
      if (action === "requested" && ++requestedWrites === 1) {
        beginRequestedAudit();
        await requestedAudit;
      }
    };
    const binding = {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    };

    try {
      const first = host.requireApproval(binding);
      await requestedAuditStarted;
      const duplicate = host.requireApproval(binding);
      let duplicateSettled = false;
      void duplicate.then(
        () => {
          duplicateSettled = true;
        },
        () => {
          duplicateSettled = true;
        }
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(duplicateSettled).toBe(false);
      rejectRequestedAudit(new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: test sink rejected request event"));

      await expect(first).rejects.toThrow("AUDIT_WRITE_FAILED");
      await expect(duplicate).rejects.toThrow("POLICY_CONFIRMATION_REQUIRED");
    } finally {
      await wrapper.close();
    }
  });

  it("consumes an approved fallback exactly once without auditing its bearer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-consume-"));
    const createCountPath = join(directory, "create-count");
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          policy: "confirm",
          env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath }
        }
      },
      policies: { confirm: { requireConfirmation: ["create_item"] } },
      audit: { path: auditPath, includeArguments: true }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-consume-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const requested = await client.callTool({ name: "create_item", arguments: { name: "first" } });
      const requestText = textContent(requested);
      const token = requestText.match(/approval '([A-Za-z0-9_-]+)'/u)?.[1];
      if (!token) throw new Error(`Expected fallback approval token, received: ${requestText}`);

      expect(await client.callTool({ name: "miftah_approve", arguments: { approval: token } })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("Approval granted") }]
      });
      expect(await client.callTool({ name: "create_item", arguments: { name: "first" } })).toMatchObject({
        content: [{ type: "text", text: "created:first" }]
      });
      expect(await client.callTool({ name: "create_item", arguments: { name: "first" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("POLICY_CONFIRMATION_REQUIRED") }]
      });
      expect(await readFile(createCountPath, "utf8")).toBe("1\n");
      expect(await readFile(auditPath, "utf8")).not.toContain(token);
      const approvalEvents = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "approval");
      expect(approvalEvents.map((event) => event.approvalAction)).toEqual([
        "requested",
        "approved",
        "consumed",
        "requested"
      ]);
      expect(JSON.stringify(approvalEvents)).not.toContain(token);
      expect(JSON.stringify(approvalEvents)).not.toContain('"name":"first"');
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("audits an expired approved fallback before offering a fresh one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-expiry-"));
    const auditPath = join(directory, "audit.jsonl");
    let now = new Date("2026-07-12T00:00:00.000Z");
    const approvals = new ApprovalStore({ now: () => now, ttlMs: 1_000 });
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm" } },
      policies: { confirm: { requireConfirmation: ["create_item"] } },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    (wrapper as unknown as { approvals: ApprovalStore }).approvals = approvals;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-expiry-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      const requested = await client.callTool({ name: "create_item", arguments: { name: "first" } });
      const token = textContent(requested).match(/approval '([A-Za-z0-9_-]+)'/u)?.[1];
      if (!token) throw new Error("Expected a fallback approval token.");
      await client.callTool({ name: "miftah_approve", arguments: { approval: token } });

      now = new Date("2026-07-12T00:00:01.000Z");

      expect(await client.callTool({ name: "create_item", arguments: { name: "first" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("POLICY_CONFIRMATION_REQUIRED") }]
      });
      const approvalActions = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "approval")
        .map((event) => event.approvalAction);
      expect(approvalActions).toEqual(["requested", "approved", "expired", "requested"]);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("audits expiry when an internal approval consume sweep crosses the TTL boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-consume-expiry-race-"));
    const auditPath = join(directory, "audit.jsonl");
    let raceRead = false;
    let raceReadCount = 0;
    const approvals = new ApprovalStore({
      now: () => {
        if (!raceRead) return new Date("2026-07-12T00:00:00.000Z");
        raceReadCount += 1;
        return new Date(raceReadCount === 1 ? "2026-07-12T00:00:00.999Z" : "2026-07-12T00:00:01.000Z");
      },
      ttlMs: 1_000
    });
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm" } },
      policies: { confirm: { requireConfirmation: ["create_item"] } },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const host = wrapper as unknown as {
      approvals: ApprovalStore;
      requireApproval(binding: {
        sourceProfile: string;
        profile: string;
        upstream: string;
        operation: string;
        name: string;
        displayName: string;
        arguments: Record<string, unknown>;
      }): Promise<void>;
    };
    host.approvals = approvals;
    const binding = {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    };
    const requested = approvals.request(binding);
    approvals.approve(requested.token);
    raceRead = true;

    try {
      await expect(host.requireApproval(binding)).rejects.toThrow("POLICY_CONFIRMATION_REQUIRED");

      const approvalActions = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "approval")
        .map((event) => event.approvalAction);
      expect(approvalActions).toEqual(["expired", "requested"]);
    } finally {
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("revokes a new approval when an inner expiry audit write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-request-expiry-audit-failure-"));
    let current = 0;
    let raceTimes: number[] = [];
    const approvals = new ApprovalStore({
      now: () => new Date(raceTimes.shift() ?? current),
      ttlMs: 1_000
    });
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm" } },
      policies: { confirm: { requireConfirmation: ["create_item"] } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const host = wrapper as unknown as {
      approvals: ApprovalStore;
      writeApproval(action: string, approval: unknown): Promise<void>;
      requireApproval(binding: {
        sourceProfile: string;
        profile: string;
        upstream: string;
        operation: string;
        name: string;
        displayName: string;
        arguments: Record<string, unknown>;
      }): Promise<void>;
    };
    host.approvals = approvals;
    approvals.request({
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "expired_item",
      displayName: "expired_item",
      arguments: {}
    });
    current = 500;
    raceTimes = [900, 999, 1_000];
    host.writeApproval = async (action) => {
      if (action === "expired") {
        throw new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: test sink rejected expiry event");
      }
    };

    try {
      await expect(
        host.requireApproval({
          sourceProfile: "work",
          profile: "work",
          upstream: "default",
          operation: "tools/call",
          name: "create_item",
          displayName: "create_item",
          arguments: { name: "first" }
        })
      ).rejects.toThrow("AUDIT_WRITE_FAILED");
      expect(approvals.list()).toEqual([]);
    } finally {
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an expiry error when recording its queued audit transition fails", async () => {
    const times = [
      new Date("2026-07-12T00:00:00.000Z"),
      new Date("2026-07-12T00:00:00.000Z"),
      new Date("2026-07-12T00:00:00.999Z"),
      new Date("2026-07-12T00:00:01.000Z")
    ];
    const approvals = new ApprovalStore({
      now: () => times.shift() ?? new Date("2026-07-12T00:00:01.000Z"),
      ttlMs: 1_000
    });
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm" } },
      policies: { confirm: { requireConfirmation: ["create_item"] } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const host = wrapper as unknown as {
      approvals: ApprovalStore;
      writeApproval(action: string, approval: unknown): Promise<void>;
      handleManagement(
        name: string,
        args: Record<string, unknown>,
        audit: unknown,
        source: unknown
      ): Promise<unknown>;
    };
    host.approvals = approvals;
    const requested = approvals.request({
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "expired_item",
      displayName: "expired_item",
      arguments: {}
    });
    host.writeApproval = async (action) => {
      if (action === "expired") {
        throw new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: test sink rejected expiry event");
      }
    };

    try {
      await expect(
        host.handleManagement("miftah_approve", { approval: requested.token }, {}, { activeProfile: "work", revision: 0 })
      ).rejects.toMatchObject({
        code: "APPROVAL_EXPIRED",
        message: "APPROVAL_EXPIRED: approval token has expired"
      });
      expect(approvals.takeExpiredTransitions()).toHaveLength(1);
    } finally {
      await wrapper.close();
    }
  });

  it("uses a boolean form elicitation when the client supports it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-elicit-"));
    const createCountPath = join(directory, "create-count");
    const secretArgument = "approval-form-secret";
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          policy: "confirm",
          env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath }
        }
      },
      policies: { confirm: { requireConfirmation: ["create_item"] } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "approval-elicit-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } }
    );
    let elicitationRequest: unknown;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitationRequest = request;
      return { action: "accept", content: { approved: true } };
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(wrapper.server.getClientCapabilities()).toMatchObject({ elicitation: { form: {} } });

      const callResult = await client.callTool({ name: "create_item", arguments: { name: secretArgument } });
      expect(elicitationRequest).toBeDefined();
      expect(callResult).toMatchObject({
        content: [{ type: "text", text: `created:${secretArgument}` }]
      });
      expect(JSON.stringify(elicitationRequest)).not.toContain(secretArgument);
      expect(elicitationRequest).toMatchObject({
        params: {
          mode: "form",
          requestedSchema: {
            properties: { approved: { type: "boolean" } },
            required: ["approved"]
          }
        }
      });
      expect(await readFile(createCountPath, "utf8")).toBe("1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("audits a native approval that expires while its form is open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-elicit-expiry-"));
    const auditPath = join(directory, "audit.jsonl");
    let now = new Date("2026-07-12T00:00:00.000Z");
    const approvals = new ApprovalStore({ now: () => now, ttlMs: 1_000 });
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm" } },
      policies: { confirm: { requireConfirmation: ["create_item"] } },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    (wrapper as unknown as { approvals: ApprovalStore }).approvals = approvals;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "approval-elicit-expiry-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } }
    );
    client.setRequestHandler(ElicitRequestSchema, async () => {
      now = new Date("2026-07-12T00:00:01.000Z");
      return { action: "accept", content: { approved: true } };
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "create_item", arguments: { name: "first" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("APPROVAL_EXPIRED") }]
      });
      const approvalActions = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "approval")
        .map((event) => event.approvalAction);
      expect(approvalActions).toEqual(["requested", "expired"]);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the same generic form for confirmation-required resource and prompt operations", async () => {
    const secretResourceUri = "account://current?token=resource-approval-secret";
    const secretPromptArgument = "prompt-approval-secret";
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { policy: "confirm" } },
      policies: { confirm: { requireConfirmation: ["resources/read", "prompts/get"] } }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "approval-resource-prompt-elicit-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } }
    );
    const elicitationRequests: unknown[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitationRequests.push(request);
      return { action: "accept", content: { approved: true } };
    });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.readResource({ uri: secretResourceUri })).toMatchObject({ contents: [{ text: "unknown" }] });
      expect(await client.getPrompt({ name: "account_prompt", arguments: { value: secretPromptArgument } })).toMatchObject({
        messages: [{ content: { text: "unknown" } }]
      });
      expect(elicitationRequests).toHaveLength(2);
      expect(JSON.stringify(elicitationRequests)).not.toContain(secretResourceUri);
      expect(JSON.stringify(elicitationRequests)).not.toContain(secretPromptArgument);
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("does not fall back to a bearer when a supported client declines the form", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-approval-decline-"));
    const createCountPath = join(directory, "create-count");
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          policy: "confirm",
          env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath }
        }
      },
      policies: { confirm: { requireConfirmation: ["create_item"] } },
      audit: { path: auditPath }
    });
    const manager = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "approval-decline-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } }
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approved: false } }));

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "create_item", arguments: { name: "first" } })).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "POLICY_CONFIRMATION_REQUIRED: approval was not accepted for 'create_item'"
          }
        ]
      });
      await expect(access(createCountPath)).rejects.toThrow();
      const approvalActions = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "approval")
        .map((event) => event.approvalAction);
      expect(approvalActions).toEqual(["requested", "denied"]);
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function textContent(result: unknown): string {
  if (!isTextContentResult(result)) throw new Error("Expected a text result.");
  const content = result.content.find((item) => item.type === "text")?.text;
  if (content === undefined) throw new Error("Expected a text result.");
  return content;
}

function isTextContentResult(value: unknown): value is { content: readonly { type: string; text?: string }[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    Array.isArray((value as { content?: unknown }).content)
  );
}
