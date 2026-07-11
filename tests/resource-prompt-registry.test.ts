import { describe, expect, it } from "vitest";
import { ResourcePromptRegistry } from "../src/mcp/server/resource-prompt-registry.js";

describe("resource and prompt registry", () => {
  it("bounds opaque cursor storage with least-recently-used eviction", async () => {
    const registry = new ResourcePromptRegistry(
      () => ["github"],
      async () => ({ resources: [], nextCursor: "next" }),
      async () => ({ prompts: [], nextCursor: "next" }),
      (value) => value,
      2
    );

    const first = await registry.listResources("work");
    const second = await registry.listResources("work");
    const third = await registry.listResources("work");
    if (!first.nextCursor || !second.nextCursor || !third.nextCursor) {
      throw new Error("Expected opaque aggregate cursors.");
    }

    await expect(registry.listResources("work", first.nextCursor)).rejects.toMatchObject({
      code: "RESOURCE_CURSOR_INVALID"
    });
    await expect(registry.listResources("work", second.nextCursor)).resolves.toMatchObject({ resources: [] });
  });

  it("does not publish a discovery invalidated while an upstream list is in flight", async () => {
    let resolveDiscovery:
      | ((value: { resources: Array<{ uri: string; name: string; mimeType: string }> }) => void)
      | undefined;
    const discovery = new Promise<{ resources: Array<{ uri: string; name: string; mimeType: string }> }>((resolve) => {
      resolveDiscovery = resolve;
    });
    const registry = new ResourcePromptRegistry(
      () => ["github"],
      async () => discovery,
      async () => ({ prompts: [] }),
      (value) => value
    );

    const listing = registry.listResources("work");
    registry.invalidate("work");
    if (!resolveDiscovery) throw new Error("Expected resource discovery to start.");
    resolveDiscovery({
      resources: [{ uri: "account://current", name: "Current account", mimeType: "text/plain" }]
    });

    await expect(listing).rejects.toMatchObject({ code: "RESOURCE_DISCOVERY_INVALIDATED" });
    expect(
      registry.resolveResource("work", "miftah://resource/github?uri=account%3A%2F%2Fcurrent")
    ).toBeUndefined();
  });
});
