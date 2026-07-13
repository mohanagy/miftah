import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";
import { MiftahError } from "../src/utils/errors.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

describe("profile transition audit barrier", () => {
  it("does not expose a new profile lease to concurrent calls before its required audit transition commits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-profile-audit-barrier-"));
    const createCountPath = join(directory, "create-count");
    const config = validateConfig({
      version: "1",
      name: "accounts",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: [fixture] },
      profiles: {
        work: { lease: { ttlMs: 60_000, requiredForRisk: ["write"] } },
        personal: {
          lease: { ttlMs: 60_000, requiredForRisk: ["write"] },
          env: { TEST_CREATE_ITEM_COUNT_PATH: createCountPath }
        }
      },
      security: { allowProfileSwitchingFromMcp: true },
      tooling: { toolRiskOverrides: { create_item: "write" } },
      audit: { enabled: false }
    });
    const upstreams = new UpstreamProcessManager(config.upstream!, config.profiles, { startupTimeoutMs: 5_000 });
    const profiles = new ProfileManager(config, config.security);
    const wrapper = new MiftahServer(config, profiles, upstreams);
    let auditStarted!: () => void;
    const auditStartedPromise = new Promise<void>((resolve) => {
      auditStarted = resolve;
    });
    let rejectAudit!: (reason: unknown) => void;
    const auditGate = new Promise<void>((_resolve, reject) => {
      rejectAudit = reject;
    });
    const host = wrapper as unknown as {
      writeProfileActions(actions: readonly unknown[]): Promise<void>;
    };
    host.writeProfileActions = async () => {
      auditStarted();
      await auditGate;
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "profile-audit-barrier-client", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();

      const switching = client.callTool({ name: "miftah_use_profile", arguments: { profile: "personal" } });
      await auditStartedPromise;
      const writing = client.callTool({ name: "create_item", arguments: { name: "must-not-run" } });

      await expect(
        Promise.race([
          writing.then(() => "settled"),
          delay(100).then(() => "waiting")
        ])
      ).resolves.toBe("waiting");

      rejectAudit(new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: test audit sink rejected transition"));
      expect(await switching).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("AUDIT_WRITE_FAILED") }]
      });
      expect(await writing).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("PROFILE_LEASE_REQUIRED") }]
      });
      await expect(access(createCountPath)).rejects.toThrow();
      expect(profiles.current()).toMatchObject({ activeProfile: "work", lease: { state: "required" } });
    } finally {
      rejectAudit?.(new Error("test cleanup"));
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
