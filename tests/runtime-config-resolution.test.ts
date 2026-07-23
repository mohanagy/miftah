import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/runtime/create-runtime.js";
import { resolveRuntimeConfig } from "../src/runtime/resolve-runtime-config.js";
import { SecretResolver } from "../src/secrets/secret-resolver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeScopedConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-scoped-resolution-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "miftah.json");
  await writeFile(join(directory, ".env"), "HEALTHY_SECRET=healthy-scoped-secret\n");
  await writeFile(
    configPath,
    JSON.stringify({
      version: "1",
      name: "scoped-resolution",
      defaultProfile: "healthy",
      upstreams: {
        healthy: {
          transport: "stdio",
          command: "node",
          env: { UPSTREAM_TOKEN: "${HEALTHY_SECRET}" }
        },
        broken: {
          transport: "stdio",
          command: "node",
          env: { UPSTREAM_TOKEN: "${MISSING_SECRET}" }
        }
      },
      profiles: {
        healthy: {
          env: { PROFILE_TOKEN: "${HEALTHY_SECRET}" },
          upstreams: {
            healthy: { headers: { Authorization: "${HEALTHY_SECRET}" } }
          }
        },
        broken: {
          env: { PROFILE_TOKEN: "${MISSING_SECRET}" },
          upstreams: {
            broken: { headers: { Authorization: "${MISSING_SECRET}" } }
          }
        }
      },
      server: { http: { authToken: "${MISSING_HTTP_SERVER_SECRET}" } },
      secrets: { envFiles: [".env"] }
    })
  );
  return configPath;
}

async function writeHttpServerConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-http-auth-resolution-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "miftah.json");
  await writeFile(join(directory, ".env"), "MIFTAH_HTTP_TOKEN=resolved-http-token\n");
  await writeFile(
    configPath,
    JSON.stringify({
      version: "1",
      name: "http-auth-resolution",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node" },
      profiles: { default: {} },
      server: { http: { authToken: "${MIFTAH_HTTP_TOKEN}" } },
      secrets: { envFiles: [".env"] }
    })
  );
  return configPath;
}

async function writeVersionTwoRootUpstreamConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-v2-root-upstream-resolution-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "miftah.json");
  await writeFile(join(directory, ".env"), "ROOT_UPSTREAM_SECRET=resolved-root-upstream-secret\n");
  await writeFile(
    configPath,
    JSON.stringify({
      version: "2",
      name: "v2-root-upstream-resolution",
      defaultProfile: "default",
      upstream: {
        transport: "stdio",
        command: "node",
        env: { UPSTREAM_TOKEN: "${ROOT_UPSTREAM_SECRET}" },
        headers: { Authorization: "Bearer ${ROOT_UPSTREAM_SECRET}" }
      },
      profiles: { default: {} },
      secrets: { envFiles: [".env"] }
    })
  );
  return configPath;
}

async function writeMissingHttpServerAuthConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-http-auth-opt-in-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "miftah.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: "1",
      name: "http-auth-opt-in",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node" },
      profiles: { default: {} },
      server: { http: { authToken: "${MISSING_HTTP_SERVER_SECRET}" } }
    })
  );
  return configPath;
}

type RuntimeResolutionScope = {
  readonly profile: string;
  readonly upstreamName: string;
};

type ScopedRuntimeResolver = (
  configPath: string,
  scope: RuntimeResolutionScope
) => ReturnType<typeof resolveRuntimeConfig>;

const resolveScopedRuntimeConfig: ScopedRuntimeResolver = (configPath, scope) =>
  Reflect.apply(resolveRuntimeConfig, undefined, [configPath, scope]) as ReturnType<typeof resolveRuntimeConfig>;

describe("runtime secret resolution scope", () => {
  it("keeps unrelated profile and upstream references unresolved for a selected target", async () => {
    const configPath = await writeScopedConfig();

    await expect(resolveRuntimeConfig(configPath)).rejects.toThrow("SECRET_ENV_MISSING");
    const resolved = await resolveScopedRuntimeConfig(configPath, {
      profile: "healthy",
      upstreamName: "healthy"
    });

    expect(resolved.config.profiles.healthy?.env).toEqual({ PROFILE_TOKEN: "healthy-scoped-secret" });
    expect(resolved.config.profiles.healthy?.upstreams?.healthy?.headers).toEqual({
      Authorization: "healthy-scoped-secret"
    });
    expect(resolved.config.upstreams?.healthy?.env).toEqual({ UPSTREAM_TOKEN: "healthy-scoped-secret" });
    expect(resolved.config.profiles.broken?.env).toEqual({ PROFILE_TOKEN: "${MISSING_SECRET}" });
    expect(resolved.config.profiles.broken?.upstreams?.broken?.headers).toEqual({
      Authorization: "${MISSING_SECRET}"
    });
    expect(resolved.config.upstreams?.broken?.env).toEqual({ UPSTREAM_TOKEN: "${MISSING_SECRET}" });
    expect(resolved.config.server?.http?.authToken).toBe("${MISSING_HTTP_SERVER_SECRET}");
  });

  it("resolves a secret-backed HTTP bearer token and registers it for redaction", async () => {
    const configPath = await writeHttpServerConfig();

    const unresolved = await resolveRuntimeConfig(configPath);
    expect(unresolved.config.server?.http?.authToken).toBe("${MIFTAH_HTTP_TOKEN}");
    expect(unresolved.secretValues).not.toContain("resolved-http-token");

    const resolved = await resolveRuntimeConfig(configPath, undefined, { resolveServerHttpAuthToken: true });

    expect(resolved.config.server?.http?.authToken).toBe("resolved-http-token");
    expect(resolved.secretValues).toContain("resolved-http-token");
    expect(resolved.redactor.redact("Bearer resolved-http-token")).not.toContain("resolved-http-token");
  });

  it("does not resolve an HTTP-only bearer secret while creating a standard runtime", async () => {
    const runtime = await createRuntime(await writeMissingHttpServerAuthConfig());

    try {
      expect(runtime.config.server?.http?.authToken).toBe("${MISSING_HTTP_SERVER_SECRET}");
    } finally {
      await runtime.manager.close();
    }
  });

  it("resolves a version 2 root upstream exactly once", async () => {
    const resolveMapWithSecretValues = vi.spyOn(SecretResolver.prototype, "resolveMapWithSecretValues");
    try {
      const resolved = await resolveRuntimeConfig(await writeVersionTwoRootUpstreamConfig());

      expect(resolved.config.upstream?.env).toEqual({ UPSTREAM_TOKEN: "resolved-root-upstream-secret" });
      expect(resolved.config.upstream?.headers).toEqual({ Authorization: "Bearer resolved-root-upstream-secret" });
      expect(resolveMapWithSecretValues).toHaveBeenCalledTimes(2);
    } finally {
      resolveMapWithSecretValues.mockRestore();
    }
  });

  it("initializes the identity binding store before exposing a configured runtime", async () => {
    const load = vi.fn(async () => [] as const);
    const bindingStore = { load, save: vi.fn(async () => undefined) };

    const runtime = await createRuntime(await writeMissingHttpServerAuthConfig(), undefined, {
      identity: { bindingStore }
    });

    try {
      expect(load).toHaveBeenCalledOnce();
      expect(runtime.identities.status("default", undefined)).toMatchObject({
        status: "unconfigured",
        bindingState: "unavailable"
      });
    } finally {
      await runtime.manager.close();
    }
  });
});
