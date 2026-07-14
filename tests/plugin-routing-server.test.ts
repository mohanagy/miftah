import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMiftahRuntime } from "../src/runtime/create-miftah-runtime.js";

const upstreamFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

describe("plugin routing server integration", () => {
  it("uses configured routing plugins for real proxied MCP tool calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-routing-server-"));
    const pluginPath = join(directory, "routing-plugin.mjs");
    await writeFile(
      pluginPath,
      `export default {
  apiVersion: "1",
  id: "server-routing",
  kind: "routing-matcher",
  async match(request) {
    return {
      bindings: request.signals.some((signal) =>
        signal.provider === "github" && signal.kind === "repository" && signal.value === "owner/repository"
      ) ? ["owner-work"] : []
    };
  }
};\n`,
      "utf8"
    );
    const configPath = join(directory, "miftah.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "plugin-server",
        defaultProfile: "personal",
        upstream: { transport: "stdio", command: process.execPath, args: [upstreamFixture] },
        profiles: {
          personal: { env: { TEST_ACCOUNT_NAME: "personal" } },
          work: { env: { TEST_ACCOUNT_NAME: "work" } }
        },
        plugins: {
          allowlist: [
            {
              id: "server-routing",
              kind: "routing-matcher",
              path: "./routing-plugin.mjs",
              bindings: { "owner-work": "work" }
            }
          ]
        }
      }),
      "utf8"
    );
    const wrapper = await createMiftahRuntime(configPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plugin-routing-server-test", version: "1.0.0" });

    try {
      await Promise.all([wrapper.connect(serverTransport), client.connect(clientTransport)]);
      await expect(
        client.callTool({
          name: "whoami",
          arguments: { url: "https://github.com/owner/repository/issues/1" }
        })
      ).resolves.toMatchObject({ content: [{ type: "text", text: "work" }] });
    } finally {
      await client.close();
      await wrapper.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
