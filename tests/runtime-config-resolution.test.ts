import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeConfig } from "../src/runtime/resolve-runtime-config.js";

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
      secrets: { envFiles: [".env"] }
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
  });
});
