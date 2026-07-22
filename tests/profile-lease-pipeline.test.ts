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
import { SecretRedactor } from "../src/secrets/redact.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

describe("profile leases in the operation pipeline", () => {
  it("requires an explicit unexpired selection before forwarding a lease-protected risk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-lease-"));
    const createCountPath = join(directory, "create-count");
    const auditPath = join(directory, "audit.jsonl");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          lease: { ttlMs: 60_000, requiredForRisk: ["write"] },
          env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath }
        }
      },
      security: { allowProfileSwitchingFromMcp: true },
      tooling: { toolRiskOverrides: { create_item: "write" } },
      audit: { path: auditPath }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, upstreams);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-lease-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "create_item", arguments: { name: "before-selection" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_LEASE_REQUIRED") }]
      });
      await expect(access(createCountPath)).rejects.toThrow();
      const deniedAudit = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.operation === "tools/call" && event.name === "create_item");
      expect(deniedAudit).toMatchObject({
        status: "denied",
        errorCode: "PROFILE_LEASE_REQUIRED",
        profileSelectionSource: "configured-default",
        profileLeaseState: "required"
      });

      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "work" } });
      expect(await client.callTool({ name: "create_item", arguments: { name: "selected" } })).toMatchObject({
        content: [{ type: "text", text: "created:selected" }]
      });
      expect(await readFile(createCountPath, "utf8")).toBe("1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks a lease at its exact expiry before forwarding the protected operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-lease-expiry-"));
    const createCountPath = join(directory, "create-count");
    const auditPath = join(directory, "audit.jsonl");
    let now = new Date("2026-07-12T00:00:00.000Z");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {
          lease: { ttlMs: 1_000, requiredForRisk: ["write"] },
          env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath }
        }
      },
      security: { allowProfileSwitchingFromMcp: true },
      tooling: { toolRiskOverrides: { create_item: "write" } },
      audit: { path: auditPath }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security, undefined, { now: () => now });
    const wrapper = new MiftahServer(config, profiles, upstreams);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-lease-expiry-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "work" } });
      now = new Date("2026-07-12T00:00:01.000Z");

      expect(await client.callTool({ name: "create_item", arguments: { name: "expired" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_LEASE_EXPIRED") }]
      });
      await expect(access(createCountPath)).rejects.toThrow();
      const profileActions = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "profile");
      expect(profileActions).toEqual(
        expect.arrayContaining([expect.objectContaining({ profileAction: "lease-expired", profileLeaseState: "expired" })])
      );
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not let a routed profile borrow the active profile's lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-lease-route-"));
    const personalCreateCountPath = join(directory, "personal-create-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { lease: { ttlMs: 60_000, requiredForRisk: ["write"] } },
        personal: {
          lease: { ttlMs: 60_000, requiredForRisk: ["write"] },
          env: { TEST_CREATE_ITEM_COUNT_PATH: personalCreateCountPath }
        }
      },
      routing: { rules: [{ when: { "args.account": "personal" }, profile: "personal" }] },
      security: { allowProfileSwitchingFromMcp: true },
      tooling: { toolRiskOverrides: { create_item: "write" } },
      audit: { enabled: false }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, upstreams);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-lease-route-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "work" } });

      expect(await client.callTool({ name: "create_item", arguments: { name: "wrong-lease", account: "personal" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_LEASE_REQUIRED") }]
      });
      await expect(access(personalCreateCountPath)).rejects.toThrow();

      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      expect(await client.callTool({ name: "create_item", arguments: { name: "right-lease", account: "personal" } })).toMatchObject({
        content: [{ type: "text", text: "created:right-lease" }]
      });
      expect(await readFile(personalCreateCountPath, "utf8")).toBe("1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a current-session selection for destructive operations when configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-explicit-selection-"));
    const createCountPath = join(directory, "create-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath } } },
      security: { allowProfileSwitchingFromMcp: true, requireExplicitSelectionForDestructive: true },
      tooling: { toolRiskOverrides: { create_item: "destructive" } },
      audit: { enabled: false }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, upstreams);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-explicit-selection-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "create_item", arguments: { name: "default" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_SELECTION_REQUIRED") }]
      });
      await expect(access(createCountPath)).rejects.toThrow();

      await client.callTool({ name: "miftah_use_profile", arguments: { profile: "work" } });
      expect(await client.callTool({ name: "create_item", arguments: { name: "selected" } })).toMatchObject({
        content: [{ type: "text", text: "created:selected" }]
      });
      expect(await readFile(createCountPath, "utf8")).toBe("1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts a configured static profile lock as an explicit destructive selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-static-lock-selection-"));
    const createCountPath = join(directory, "create-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: { env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath } } },
      security: { lockToProfile: "work", requireExplicitSelectionForDestructive: true },
      tooling: { toolRiskOverrides: { create_item: "destructive" } },
      audit: { enabled: false }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, upstreams);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-static-lock-selection-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "create_item", arguments: { name: "locked" } })).toMatchObject({
        content: [{ type: "text", text: "created:locked" }]
      });
      expect(await readFile(createCountPath, "utf8")).toBe("1\n");
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not let a later lease renewal authorize an already-captured expired operation", async () => {
    let now = new Date("2026-07-12T00:00:00.000Z");
    const profiles = new ProfileManager(
      {
        defaultProfile: "work",
        profiles: {
          work: {
            policy: "confirm",
            lease: { ttlMs: 1_000, requiredForRisk: ["write"] }
          }
        }
      },
      { allowProfileSwitchingFromMcp: true },
      undefined,
      { now: () => now }
    );
    profiles.switch("work");
    let targetResolved = false;
    let executed = false;
    const pipeline = new OperationPipeline({
      profiles,
      routing: new RoutingEngine(undefined, "work"),
      policy: new PolicyEngine({ confirm: { requireConfirmation: ["create_item"] } }, { create_item: "write" }),
      upstreams: { get: async () => ({}) } as unknown as UpstreamProcessManager,
      redactor: new SecretRedactor(),
      routingContext: async () => ({ context: {}, evidence: { cwd: "", fileRoots: [] }, profileHints: [] }),
      identities: new IdentityManager({
        version: "1",
        name: "profile-lease",
        defaultProfile: "work",
        upstream: { transport: "stdio", command: process.execPath },
        profiles: { work: { policy: "confirm", lease: { ttlMs: 1_000, requiredForRisk: ["write"] } } }
      }),
      approvals: {
        requireApproval: async () => {
          now = new Date("2026-07-12T00:00:01.000Z");
          profiles.switch("work");
        }
      },
      now: () => now
    });
    const audit = new AuditTrail("test").beginOperation({
      operation: "tools/call",
      name: "create_item",
      sourceProfile: "work"
    });

    await expect(
      pipeline.execute(
        {
          source: profiles.current(),
          operation: "tools/call",
          routingName: "create_item",
          policyName: "create_item",
          name: "create_item",
          args: {},
          resolveTarget: async () => {
            targetResolved = true;
            return {
              name: "create_item",
              execute: async () => {
                executed = true;
                return { content: [] };
              },
              redact: (result) => result
            };
          }
        },
        audit
      )
    ).rejects.toMatchObject({ code: "PROFILE_LEASE_EXPIRED" });
    expect(profiles.current().lease).toMatchObject({
      state: "active",
      profile: "work",
      expiresAt: "2026-07-12T00:00:02.000Z"
    });
    expect(targetResolved).toBe(true);
    expect(executed).toBe(false);
  });
});
