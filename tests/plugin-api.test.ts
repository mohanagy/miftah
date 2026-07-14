import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginRegistry } from "../src/plugins/plugin-registry.js";
import { createRuntime } from "../src/runtime/create-runtime.js";
import { resolveRuntimeConfig } from "../src/runtime/resolve-runtime-config.js";
import { SecretResolver } from "../src/secrets/secret-resolver.js";
import { RoutingEngine } from "../src/routing/routing-engine.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("plugin API", () => {
  it("declares the versioned plugin API as a package subpath", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports?: Record<string, unknown>;
    };

    expect(manifest.exports?.["./plugin-api"]).toEqual({
      types: "./dist/plugin-api.d.ts",
      import: "./dist/plugin-api.js"
    });
  });

  it("runs the maintained reference plugins through the versioned child-host contract", async () => {
    const examplesDirectory = fileURLToPath(new URL("../examples/", import.meta.url));
    const plugins = await loadPluginRegistry(
      {
        allowlist: [
          {
            id: "file-local",
            kind: "secret-provider",
            path: join(examplesDirectory, "plugins", "file-secret-provider.mjs")
          },
          {
            id: "github-owner",
            kind: "routing-matcher",
            path: join(examplesDirectory, "plugins", "github-owner-routing-matcher.mjs"),
            bindings: { "acme-work": "work" }
          }
        ]
      },
      { rootDirectory: examplesDirectory }
    );
    const resolver = new SecretResolver({ plugins });

    await expect(resolver.resolveValue("secretref:file-local://file-secret-provider.mjs")).resolves.toContain(
      'id: "file-local"'
    );
    await expect(
      plugins.matchRouting("github_issue_get", {
        signals: [{ provider: "github", kind: "repository", value: "acme/miftah", source: "argument" }]
      })
    ).resolves.toEqual([{ pluginId: "github-owner", binding: "acme-work", profile: "work" }]);
  });

  it("runs an allowlisted secret provider in a clean child with only its canonical reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-api-"));
    temporaryDirectories.push(directory);
    const pluginPath = join(directory, "fixture-secret-provider.mjs");
    await writeFile(
      pluginPath,
      `export default {
  apiVersion: "1",
  id: "fixture",
  kind: "secret-provider",
  async resolve(request) {
    return {
      value: JSON.stringify({
        requestKeys: Object.keys(request).sort(),
        reference: request.reference,
        inheritedParentValue: process.env.MIFTAH_PLUGIN_PARENT_ONLY ?? null
      })
    };
  }
};\n`,
      "utf8"
    );

    process.env.MIFTAH_PLUGIN_PARENT_ONLY = "must-not-reach-plugin";
    try {
      const plugins = await loadPluginRegistry({
        allowlist: [{ id: "fixture", kind: "secret-provider", path: pluginPath }]
      });
      const resolver = new SecretResolver({ plugins });

      await expect(resolver.resolveValue("secretref:fixture://account")).resolves.toBe(
        '{"requestKeys":["reference"],"reference":"secretref:fixture://account","inheritedParentValue":null}'
      );
    } finally {
      delete process.env.MIFTAH_PLUGIN_PARENT_ONLY;
    }
  });

  it("rejects an incompatible allowlisted manifest before constructing a runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-api-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "incompatible-plugin.mjs"),
      `export default {
  apiVersion: "2",
  id: "fixture",
  kind: "secret-provider",
  async resolve() { return { value: "not-used" }; }
};\n`,
      "utf8"
    );
    const configPath = join(directory, "miftah.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "plugin-preflight",
        defaultProfile: "default",
        upstream: { transport: "stdio", command: process.execPath },
        profiles: { default: {} },
        plugins: {
          allowlist: [{ id: "fixture", kind: "secret-provider", path: "./incompatible-plugin.mjs" }]
        }
      }),
      "utf8"
    );

    await expect(createRuntime(configPath)).rejects.toMatchObject({ code: "PLUGIN_API_INCOMPATIBLE" });
  });

  it("rejects a local plugin path whose resolved target escapes the canonical configuration directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-api-"));
    temporaryDirectories.push(directory);
    const configurationDirectory = join(directory, "configuration");
    const externalDirectory = join(directory, "external");
    await Promise.all([mkdir(configurationDirectory), mkdir(externalDirectory)]);
    await writeFile(
      join(externalDirectory, "escaped-plugin.mjs"),
      `export default {
  apiVersion: "1",
  id: "escaped",
  kind: "secret-provider",
  async resolve() { return { value: "not-used" }; }
};\n`,
      "utf8"
    );
    await symlink(
      externalDirectory,
      join(configurationDirectory, "plugins"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const configPath = join(configurationDirectory, "miftah.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "plugin-symlink-escape",
        defaultProfile: "default",
        upstream: { transport: "stdio", command: process.execPath },
        profiles: { default: {} },
        plugins: {
          allowlist: [{ id: "escaped", kind: "secret-provider", path: "./plugins/escaped-plugin.mjs" }]
        }
      }),
      "utf8"
    );

    await expect(resolveRuntimeConfig(configPath)).rejects.toMatchObject({ code: "PLUGIN_API_INCOMPATIBLE" });
  });

  it("resolves an allowlisted secret-provider reference from the public configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-api-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "configured-secret-plugin.mjs"),
      `export default {
  apiVersion: "1",
  id: "configured-secret",
  kind: "secret-provider",
  async resolve(request) {
    return { value: request.reference === "secretref:configured-secret://account" ? "configured-plugin-secret" : "wrong-reference" };
  }
};\n`,
      "utf8"
    );
    const configPath = join(directory, "miftah.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "1",
        name: "configured-plugin-secret",
        defaultProfile: "default",
        upstream: { transport: "stdio", command: process.execPath },
        profiles: { default: { env: { API_TOKEN: "secretref:configured-secret://account" } } },
        plugins: {
          allowlist: [
            { id: "configured-secret", kind: "secret-provider", path: "./configured-secret-plugin.mjs" }
          ]
        }
      }),
      "utf8"
    );

    const resolved = await resolveRuntimeConfig(configPath);
    expect(resolved.config.profiles.default?.env?.API_TOKEN).toBe("configured-plugin-secret");
    expect(resolved.redactor.redactText("configured-plugin-secret")).toBe("[REDACTED]");
  });

  it("routes through an allowlisted matcher using only canonical signals and configured binding tokens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-api-"));
    temporaryDirectories.push(directory);
    const pluginPath = join(directory, "fixture-routing-matcher.mjs");
    await writeFile(
      pluginPath,
      `export default {
  apiVersion: "1",
  id: "fixture-routing",
  kind: "routing-matcher",
  async match(request) {
    const hasOnlySafeInput = JSON.stringify(Object.keys(request).sort()) === '["signals","toolName"]';
    const matchesRepository = request.signals.some((signal) =>
      signal.provider === "github" && signal.kind === "repository" && signal.value === "owner/repository"
    );
    return {
      bindings: hasOnlySafeInput && matchesRepository && process.env.MIFTAH_PLUGIN_PARENT_ONLY === undefined
        ? ["owner-work"]
        : []
    };
  }
};\n`,
      "utf8"
    );
    process.env.MIFTAH_PLUGIN_PARENT_ONLY = "must-not-reach-plugin";
    try {
      const plugins = await loadPluginRegistry({
        allowlist: [
          {
            id: "fixture-routing",
            kind: "routing-matcher",
            path: pluginPath,
            bindings: { "owner-work": "work" }
          }
        ]
      });
      const routing = new RoutingEngine(
        { fallback: "block" },
        "personal",
        "personal",
        { personal: {}, work: {} },
        plugins
      );

      await expect(
        routing.resolveWithPlugins({
          toolName: "github_issue_get",
          args: { repository: "owner/repository", password: "not-for-plugins" }
        })
      ).resolves.toMatchObject({ profile: "work", reason: "matcher:plugin:fixture-routing" });
    } finally {
      delete process.env.MIFTAH_PLUGIN_PARENT_ONLY;
    }
  });

  it("rejects an inherited object property returned as an unconfigured routing binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-api-"));
    temporaryDirectories.push(directory);
    const pluginPath = join(directory, "inherited-binding-routing-matcher.mjs");
    await writeFile(
      pluginPath,
      `export default {
  apiVersion: "1",
  id: "inherited-binding",
  kind: "routing-matcher",
  async match() { return { bindings: ["constructor"] }; }
};\n`,
      "utf8"
    );
    const plugins = await loadPluginRegistry({
      allowlist: [
        {
          id: "inherited-binding",
          kind: "routing-matcher",
          path: pluginPath,
          bindings: { "configured-binding": "work" }
        }
      ]
    });

    await expect(
      plugins.matchRouting("github_issue_get", {
        signals: [{ provider: "github", kind: "repository", value: "owner/repository", source: "argument" }]
      })
    ).rejects.toMatchObject({ code: "ROUTING_PLUGIN_FAILED" });
  });

  it("bounds, deduplicates, and sorts canonical routing signals before starting a plugin host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-api-"));
    temporaryDirectories.push(directory);
    const pluginPath = join(directory, "bounded-routing-matcher.mjs");
    await writeFile(
      pluginPath,
      `export default {
  apiVersion: "1",
  id: "bounded-routing",
  kind: "routing-matcher",
  async match(request) {
    const values = request.signals.map((signal) => signal.value);
    const isSorted = values.every((value, index) => index === 0 || values[index - 1] <= value);
    const isUnique = new Set(values).size === values.length;
    return {
      bindings: request.signals.length === 64 && isSorted && isUnique && values[0] === "owner/repository0"
        ? ["bulk-work"]
        : []
    };
  }
};\n`,
      "utf8"
    );
    const plugins = await loadPluginRegistry({
      allowlist: [
        {
          id: "bounded-routing",
          kind: "routing-matcher",
          path: pluginPath,
          bindings: { "bulk-work": "work" }
        }
      ]
    });
    const signals = Array.from({ length: 65 }, (_, index) => ({
      provider: "github" as const,
      kind: "repository" as const,
      value: `owner/repository${64 - index}`,
      source: "argument" as const
    }));
    signals.push({ ...signals[signals.length - 1]! });

    await expect(plugins.matchRouting("github_bulk", { signals })).resolves.toEqual([
      { pluginId: "bounded-routing", binding: "bulk-work", profile: "work" }
    ]);
  });

  it("keeps a full canonical routing payload inside the plugin host byte limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-api-"));
    temporaryDirectories.push(directory);
    const pluginPath = join(directory, "byte-bounded-routing-matcher.mjs");
    await writeFile(
      pluginPath,
      `export default {
  apiVersion: "1",
  id: "byte-bounded-routing",
  kind: "routing-matcher",
  async match(request) {
    return { bindings: request.signals.length < 64 && request.signals[0]?.value.startsWith("owner/000") ? ["byte-work"] : [] };
  }
};\n`,
      "utf8"
    );
    const plugins = await loadPluginRegistry({
      allowlist: [
        {
          id: "byte-bounded-routing",
          kind: "routing-matcher",
          path: pluginPath,
          bindings: { "byte-work": "work" }
        }
      ]
    });
    const signals = Array.from({ length: 64 }, (_, index) => ({
      provider: "github" as const,
      kind: "repository" as const,
      value: `owner/${index.toString().padStart(3, "0")}${"a".repeat(245)}`,
      source: "argument" as const
    }));

    await expect(plugins.matchRouting("github_bulk", { signals })).resolves.toEqual([
      { pluginId: "byte-bounded-routing", binding: "byte-work", profile: "work" }
    ]);
  });

  it("reports the first routing plugin failure instead of a sibling cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-api-"));
    temporaryDirectories.push(directory);
    const hangingPluginPath = join(directory, "a-hanging-routing-matcher.mjs");
    const failingPluginPath = join(directory, "z-failing-routing-matcher.mjs");
    await Promise.all([
      writeFile(
        hangingPluginPath,
        `export default {
  apiVersion: "1",
  id: "a-hanging",
  kind: "routing-matcher",
  async match() { await new Promise(() => undefined); return { bindings: [] }; }
};\n`,
        "utf8"
      ),
      writeFile(
        failingPluginPath,
        `export default {
  apiVersion: "1",
  id: "z-failing",
  kind: "routing-matcher",
  async match() { throw new Error("fixture failure"); }
};\n`,
        "utf8"
      )
    ]);
    const plugins = await loadPluginRegistry({
      timeoutMs: 2_000,
      allowlist: [
        {
          id: "a-hanging",
          kind: "routing-matcher",
          path: hangingPluginPath,
          bindings: { unused: "work" }
        },
        {
          id: "z-failing",
          kind: "routing-matcher",
          path: failingPluginPath,
          bindings: { unused: "work" }
        }
      ]
    });

    await expect(
      plugins.matchRouting("github_issue_get", {
        signals: [{ provider: "github", kind: "repository", value: "owner/repository", source: "argument" }]
      })
    ).rejects.toMatchObject({ code: "ROUTING_PLUGIN_FAILED" });
  });

  it("does not start routing plugins when the caller has already cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-api-"));
    temporaryDirectories.push(directory);
    const markerPath = join(directory, "routing-plugin-was-called");
    const pluginPath = join(directory, "cancelled-routing-matcher.mjs");
    await writeFile(
      pluginPath,
      `import { writeFile } from "node:fs/promises";
export default {
  apiVersion: "1",
  id: "cancelled-routing",
  kind: "routing-matcher",
  async match() {
    await writeFile(${JSON.stringify(markerPath)}, "called");
    return { bindings: [] };
  }
};\n`,
      "utf8"
    );
    const plugins = await loadPluginRegistry({
      allowlist: [
        {
          id: "cancelled-routing",
          kind: "routing-matcher",
          path: pluginPath,
          bindings: { unused: "work" }
        }
      ]
    });

    await expect(
      plugins.matchRouting(
        "github_issue_get",
        {
          signals: [
            { provider: "github", kind: "repository", value: "owner/repository", source: "argument" }
          ]
        },
        AbortSignal.abort()
      )
    ).rejects.toMatchObject({ code: "ROUTING_PLUGIN_CANCELLED" });
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
