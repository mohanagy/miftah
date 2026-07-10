import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import type { MiftahConfig } from "../src/config/types.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

describe("Miftah MCP wrapper", () => {
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
});
