import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { MiftahServer } from "../src/mcp/server/miftah-server.js";
import { MultiUpstreamProcessManager } from "../src/upstream/multi-upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

describe("multi-upstream wrapper", () => {
  it("namespaces and routes tools from multiple upstream servers", async () => {
    const config = validateConfig({
      version: "1",
      name: "bundle",
      defaultProfile: "work",
      upstreams: {
        github: { transport: "stdio", command: process.execPath, args: [fixture] },
        sentry: { transport: "stdio", command: process.execPath, args: [fixture] }
      },
      profiles: {
        work: {
          upstreams: {
            github: { env: { TEST_ACCOUNT_NAME: "github-work" } },
            sentry: { env: { TEST_ACCOUNT_NAME: "sentry-work" } }
          }
        }
      }
    });
    const manager = new MultiUpstreamProcessManager(config, { startupTimeoutMs: 5_000 });
    const wrapper = new MiftahServer(config, new ProfileManager(config), manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["github__whoami", "sentry__whoami"])
    );
    expect(await client.callTool({ name: "github__whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "github-work" }]
    });
    expect(await client.callTool({ name: "sentry__whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "sentry-work" }]
    });

    await client.close();
    await wrapper.close();
  });
});
