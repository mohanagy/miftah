import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";
import { MiftahError } from "../src/utils/errors.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

function jsonResult(result: unknown): Record<string, unknown> {
  const parsed = CallToolResultSchema.parse(result);
  const content = parsed.content[0];
  if (content?.type !== "text") throw new Error("Expected a text tool result.");
  const value: unknown = JSON.parse(content.text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object tool result.");
  }
  return value as Record<string, unknown>;
}

describe("MCP profile locks", () => {
  it("exposes opt-in connection-bound lock controls and safe profile state", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: {}, personal: {} },
      security: {
        allowProfileSwitchingFromMcp: true,
        allowProfileLockingFromMcp: true,
        requireExplicitSelectionForDestructive: true
      },
      tooling: { toolRiskOverrides: { create_item: "destructive" } },
      audit: { enabled: false }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, upstreams);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-lock-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["miftah_lock_profile", "miftah_unlock_profile"])
      );
      expect(jsonResult(await client.callTool({ name: "miftah_current_profile", arguments: {} }))).toMatchObject({
        lock: { state: "none" },
        lease: { state: "not-required" },
        confirmation: "not-required"
      });

      expect(jsonResult(await client.callTool({ name: "miftah_lock_profile", arguments: {} }))).toMatchObject({
        profileState: { activeProfile: "work", lock: { state: "runtime", profile: "work" } }
      });
      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_LOCKED") }]
      });
      expect(await client.callTool({ name: "create_item", arguments: { name: "locked-default" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_SELECTION_REQUIRED") }]
      });
      expect(jsonResult(await client.callTool({ name: "miftah_health", arguments: {} }))).toMatchObject({
        profileState: { activeProfile: "work", lock: { state: "runtime", profile: "work" } }
      });

      expect(jsonResult(await client.callTool({ name: "miftah_unlock_profile", arguments: {} }))).toMatchObject({
        profileState: { activeProfile: "work", lock: { state: "none" } }
      });
      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("personal") }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("keeps lock controls discoverable but rejects calls while the opt-in is disabled", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: { work: {}, personal: {} },
      security: { allowProfileSwitchingFromMcp: true },
      audit: { enabled: false }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, upstreams);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-lock-disabled-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["miftah_lock_profile", "miftah_unlock_profile"])
      );
      expect(await client.callTool({ name: "miftah_lock_profile", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_LOCKING_DISABLED") }]
      });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });

  it("rolls profile state back when its required dedicated audit transition fails", async () => {
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: {},
        personal: { lease: { ttlMs: 60_000, requiredForRisk: ["write"] } }
      },
      security: { allowProfileSwitchingFromMcp: true, allowProfileLockingFromMcp: true },
      audit: { enabled: false }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, upstreams);
    const attemptedProfileAuditBatches: string[][] = [];
    const host = wrapper as unknown as {
      writeProfileActions(actions: readonly { action: string }[]): Promise<void>;
    };
    host.writeProfileActions = async (actions) => {
      attemptedProfileAuditBatches.push(actions.map((entry) => entry.action));
      throw new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: test profile audit sink rejected transition");
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-lock-audit-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

      expect(await client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("AUDIT_WRITE_FAILED") }]
      });
      expect(attemptedProfileAuditBatches).toEqual([["switch", "lease-issued"]]);
      expect(profiles.current()).toMatchObject({ activeProfile: "work", lock: { state: "none" } });

      expect(await client.callTool({ name: "miftah_lock_profile", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("AUDIT_WRITE_FAILED") }]
      });
      expect(profiles.current()).toMatchObject({ activeProfile: "work", lock: { state: "none" } });
    } finally {
      await client.close();
      await wrapper.close();
    }
  });
});
