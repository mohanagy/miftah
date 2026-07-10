import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

describe("upstream process manager", () => {
  it("starts one cached upstream per profile and forwards MCP operations", async () => {
    const manager = new UpstreamProcessManager(
      {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      {
        work: { env: { TEST_ACCOUNT_NAME: "work" } },
        personal: { env: { TEST_ACCOUNT_NAME: "personal" } }
      },
      { startupTimeoutMs: 5_000 }
    );

    const work = await manager.get("work");
    expect((await work.listTools()).tools.map((tool) => tool.name)).toContain("whoami");
    expect(await work.callTool({ name: "whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "work" }]
    });
    expect(await manager.get("work")).toBe(work);
    expect(await (await manager.get("personal")).callTool({ name: "whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "personal" }]
    });

    await manager.close();
  });
});
