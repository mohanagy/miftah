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

  it("keeps a pending prompt discovery valid when only resources are invalidated", async () => {
    let resolveDiscovery:
      | ((value: { prompts: Array<{ name: string; description: string }> }) => void)
      | undefined;
    const discovery = new Promise<{ prompts: Array<{ name: string; description: string }> }>((resolve) => {
      resolveDiscovery = resolve;
    });
    const registry = new ResourcePromptRegistry(
      () => ["github"],
      async () => ({ resources: [] }),
      async () => discovery,
      (value) => value
    );

    const listing = registry.listPrompts("work");
    registry.invalidateResources("work");
    if (!resolveDiscovery) throw new Error("Expected prompt discovery to start.");
    resolveDiscovery({ prompts: [{ name: "review", description: "Review a pull request" }] });

    await expect(listing).resolves.toMatchObject({
      prompts: [{ name: "github__review", description: "Review a pull request" }]
    });
    expect(registry.resolvePrompt("work", "github__review")).toMatchObject({
      upstreamName: "github",
      originalName: "review"
    });
  });

  it("does not publish partial resource discovery state after the caller cancels", async () => {
    let cancelDiscovery = false;
    const registry = new ResourcePromptRegistry(
      () => ["alpha", "beta"],
      async (_profile, upstream, _params, options) => {
        if (cancelDiscovery && upstream === "alpha") {
          return await new Promise<{
            resources: Array<{ uri: string; name: string; mimeType: string }>;
          }>((_resolve, reject) => {
            const abort = () => reject(new Error("Upstream request cancelled"));
            if (options?.signal?.aborted) {
              abort();
            } else {
              options?.signal?.addEventListener("abort", abort, { once: true });
            }
          });
        }
        return {
          resources: [
            {
              uri: `account://${upstream}/${cancelDiscovery ? "new" : "current"}`,
              name: cancelDiscovery ? "New account" : "Current account",
              mimeType: "text/plain"
            }
          ]
        };
      },
      async () => ({ prompts: [] }),
      (value) => value
    );

    await registry.listResources("work");
    cancelDiscovery = true;
    const controller = new AbortController();
    const listing = registry.listResources("work", undefined, { signal: controller.signal });
    controller.abort();

    await expect(listing).rejects.toThrow("Upstream request cancelled");
    expect(
      registry.resolveResource("work", "miftah://resource/alpha?uri=account%3A%2F%2Falpha%2Fcurrent")
    ).toMatchObject({ originalUri: "account://alpha/current" });
    expect(
      registry.resolveResource("work", "miftah://resource/beta?uri=account%3A%2F%2Fbeta%2Fnew")
    ).toBeUndefined();
    expect(registry.consumeResourceListChange("work")).toBe(false);
  });

  it("aggregates parallel upstream discovery progress without leaking incompatible totals", async () => {
    type ProgressUpdate = { progress: number; total?: number; message?: string };
    const resourcesProgress: ProgressUpdate[] = [];
    const templatesProgress: ProgressUpdate[] = [];
    const promptsProgress: ProgressUpdate[] = [];
    const registry = new ResourcePromptRegistry(
      () => ["alpha", "beta"],
      async (_profile, upstream, _params, options) => {
        options?.onprogress?.({ progress: 1, total: 2, message: `${upstream} resources` });
        return { resources: [] };
      },
      async (_profile, upstream, _params, options) => {
        options?.onprogress?.({ progress: 1, total: 2, message: `${upstream} prompts` });
        return { prompts: [] };
      },
      (value) => value,
      undefined,
      "permissive",
      async (_profile, upstream, _params, options) => {
        options?.onprogress?.({ progress: 1, total: 2, message: `${upstream} templates` });
        return { resourceTemplates: [] };
      }
    );
    const collectProgress = (updates: ProgressUpdate[]) => ({
      onprogress: (update: ProgressUpdate) => updates.push(update)
    });

    await registry.listResources("work", undefined, collectProgress(resourcesProgress));
    await registry.listResourceTemplates("work", undefined, collectProgress(templatesProgress));
    await registry.listPrompts("work", undefined, collectProgress(promptsProgress));

    expect(resourcesProgress).toEqual([
      { progress: 0.5, message: "alpha resources" },
      { progress: 1, message: "beta resources" }
    ]);
    expect(templatesProgress).toEqual([
      { progress: 0.5, message: "alpha templates" },
      { progress: 1, message: "beta templates" }
    ]);
    expect(promptsProgress).toEqual([
      { progress: 0.5, message: "alpha prompts" },
      { progress: 1, message: "beta prompts" }
    ]);
  });

  it("continues only upstreams with a next cursor without skipping or duplicating aggregated resources", async () => {
    const requestedPages: Array<{ upstream: string; cursor?: string }> = [];
    const registry = new ResourcePromptRegistry(
      () => ["beta", "alpha"],
      async (_profile, upstream, params) => {
        requestedPages.push({ upstream, cursor: params?.cursor });
        if (upstream === "alpha") {
          return {
            resources: [{ uri: "account://alpha/first", name: "first", mimeType: "text/plain" }]
          };
        }
        if (params?.cursor === "beta-next") {
          return {
            resources: [{ uri: "account://beta/second", name: "second", mimeType: "text/plain" }]
          };
        }
        return {
          resources: [{ uri: "account://beta/first", name: "first", mimeType: "text/plain" }],
          nextCursor: "beta-next"
        };
      },
      async () => ({ prompts: [] }),
      (value) => value
    );

    const first = await registry.listResources("work");
    if (!first.nextCursor) throw new Error("Expected an aggregate continuation cursor.");
    const second = await registry.listResources("work", first.nextCursor);

    expect(first.resources.map((resource) => resource.name)).toEqual(["alpha__first", "beta__first"]);
    expect(second.resources.map((resource) => resource.name)).toEqual(["beta__second"]);
    expect([...first.resources, ...second.resources].map((resource) => resource.uri)).toHaveLength(3);
    expect(new Set([...first.resources, ...second.resources].map((resource) => resource.uri))).toHaveLength(3);
    expect(requestedPages).toEqual([
      { upstream: "alpha", cursor: undefined },
      { upstream: "beta", cursor: undefined },
      { upstream: "beta", cursor: "beta-next" }
    ]);
  });

  it("continues only upstreams with a next cursor for resource templates and invalidates their cursors with resources", async () => {
    const requestedPages: Array<{ upstream: string; cursor?: string }> = [];
    const registry = new ResourcePromptRegistry(
      () => ["beta", "alpha"],
      async () => ({ resources: [] }),
      async () => ({ prompts: [] }),
      (value) => value,
      undefined,
      "permissive",
      async (_profile, upstream, params) => {
        requestedPages.push({ upstream, cursor: params?.cursor });
        if (upstream === "alpha") {
          return {
            resourceTemplates: [
              { uriTemplate: "account://alpha/{id}", name: "first", mimeType: "text/plain" }
            ]
          };
        }
        if (params?.cursor === "beta-next") {
          return {
            resourceTemplates: [
              { uriTemplate: "account://beta/second/{id}", name: "second", mimeType: "text/plain" }
            ]
          };
        }
        return {
          resourceTemplates: [
            { uriTemplate: "account://beta/{id}", name: "first", mimeType: "text/plain" }
          ],
          nextCursor: "beta-next"
        };
      }
    );

    const first = await registry.listResourceTemplates("work");
    if (!first.nextCursor) throw new Error("Expected an aggregate template continuation cursor.");
    const second = await registry.listResourceTemplates("work", first.nextCursor);

    expect(first.resourceTemplates.map((template) => template.name)).toEqual(["alpha__first", "beta__first"]);
    expect(second.resourceTemplates.map((template) => template.name)).toEqual(["beta__second"]);
    expect(requestedPages).toEqual([
      { upstream: "alpha", cursor: undefined },
      { upstream: "beta", cursor: undefined },
      { upstream: "beta", cursor: "beta-next" }
    ]);

    registry.invalidateResources("work");
    await expect(registry.listResourceTemplates("work", first.nextCursor)).rejects.toMatchObject({
      code: "RESOURCE_TEMPLATE_CURSOR_INVALID"
    });
  });

  it("forwards an empty-string upstream cursor when continuing resources", async () => {
    const requestedParams: Array<{ cursor?: string } | undefined> = [];
    const registry = new ResourcePromptRegistry(
      () => ["github"],
      async (_profile, _upstream, params) => {
        requestedParams.push(params);
        if (params?.cursor === "") {
          return {
            resources: [{ uri: "account://github/second", name: "second", mimeType: "text/plain" }]
          };
        }
        return {
          resources: [{ uri: "account://github/first", name: "first", mimeType: "text/plain" }],
          nextCursor: ""
        };
      },
      async () => ({ prompts: [] }),
      (value) => value
    );

    const first = await registry.listResources("work");
    if (first.nextCursor === undefined) throw new Error("Expected an aggregate continuation cursor.");
    const second = await registry.listResources("work", first.nextCursor);

    expect(second.resources.map((resource) => resource.name)).toEqual(["github__second"]);
    expect(requestedParams).toEqual([undefined, { cursor: "" }]);
  });

  it("forwards an empty-string upstream cursor when continuing resource templates", async () => {
    const requestedParams: Array<{ cursor?: string } | undefined> = [];
    const registry = new ResourcePromptRegistry(
      () => ["github"],
      async () => ({ resources: [] }),
      async () => ({ prompts: [] }),
      (value) => value,
      undefined,
      "permissive",
      async (_profile, _upstream, params) => {
        requestedParams.push(params);
        if (params?.cursor === "") {
          return {
            resourceTemplates: [
              { uriTemplate: "account://github/second/{id}", name: "second", mimeType: "text/plain" }
            ]
          };
        }
        return {
          resourceTemplates: [
            { uriTemplate: "account://github/first/{id}", name: "first", mimeType: "text/plain" }
          ],
          nextCursor: ""
        };
      }
    );

    const first = await registry.listResourceTemplates("work");
    if (first.nextCursor === undefined) throw new Error("Expected an aggregate continuation cursor.");
    const second = await registry.listResourceTemplates("work", first.nextCursor);

    expect(second.resourceTemplates.map((template) => template.name)).toEqual(["github__second"]);
    expect(requestedParams).toEqual([undefined, { cursor: "" }]);
  });

  it("forwards an empty-string upstream cursor when continuing prompts", async () => {
    const requestedParams: Array<{ cursor?: string } | undefined> = [];
    const registry = new ResourcePromptRegistry(
      () => ["github"],
      async () => ({ resources: [] }),
      async (_profile, _upstream, params) => {
        requestedParams.push(params);
        if (params?.cursor === "") {
          return { prompts: [{ name: "second", description: "Second prompt" }] };
        }
        return {
          prompts: [{ name: "first", description: "First prompt" }],
          nextCursor: ""
        };
      },
      (value) => value
    );

    const first = await registry.listPrompts("work");
    if (first.nextCursor === undefined) throw new Error("Expected an aggregate continuation cursor.");
    const second = await registry.listPrompts("work", first.nextCursor);

    expect(second.prompts.map((prompt) => prompt.name)).toEqual(["github__second"]);
    expect(requestedParams).toEqual([undefined, { cursor: "" }]);
  });

  it("rejects a linked resource whose redacted URI collides with a different upstream resource", () => {
    const registry = new ResourcePromptRegistry(
      () => ["github"],
      async () => ({ resources: [] }),
      async () => ({ prompts: [] }),
      (value) => value
    );

    registry.exposeUpdatedResource("work", "github", "https://github.example/account?token=first");

    expect(() =>
      registry.exposeUpdatedResource("work", "github", "https://github.example/account?token=second")
    ).toThrow(/RESOURCE_COLLISION/u);
  });

  it("rejects an upstream resource template that cannot be parsed safely", async () => {
    const registry = new ResourcePromptRegistry(
      () => ["github"],
      async () => ({ resources: [] }),
      async () => ({ prompts: [] }),
      (value) => value,
      undefined,
      "permissive",
      async () => ({
        resourceTemplates: [
          {
            uriTemplate: "account://github/{",
            name: "broken",
            mimeType: "text/plain"
          }
        ]
      })
    );

    await expect(registry.listResourceTemplates("work")).rejects.toMatchObject({
      code: "RESOURCE_TEMPLATE_UNSUPPORTED"
    });
  });

  it("removes failed template routes while retaining healthy routes and rejects malformed exposed URIs", async () => {
    let failAlpha = false;
    const registry = new ResourcePromptRegistry(
      () => ["alpha", "beta"],
      async () => ({ resources: [] }),
      async () => ({ prompts: [] }),
      (value) => value,
      undefined,
      "permissive",
      async (_profile, upstream) => {
        if (upstream === "alpha" && failAlpha) throw new Error("alpha template discovery failed");
        return {
          resourceTemplates: [
            {
              uriTemplate: `account://${upstream}/{id}`,
              name: "current",
              mimeType: "text/plain"
            }
          ]
        };
      }
    );

    const initial = await registry.listResourceTemplates("work");
    const alphaTemplate = initial.resourceTemplates.find((template) => template.name === "alpha__current");
    if (alphaTemplate === undefined) throw new Error("Expected an alpha resource template.");
    const alphaUri = alphaTemplate.uriTemplate.replace("{?id}", "?id=one");
    expect(registry.resolveResource("work", alphaUri)).toMatchObject({ originalUri: "account://alpha/one" });
    expect(registry.resolveResource("work", "not a URI")).toBeUndefined();

    failAlpha = true;
    await expect(registry.listResourceTemplates("work")).resolves.toMatchObject({
      resourceTemplates: [expect.objectContaining({ name: "beta__current" })]
    });
    expect(registry.resolveResource("work", alphaUri)).toBeUndefined();
  });
});
