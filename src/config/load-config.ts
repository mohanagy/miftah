import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolvePath } from "./path-resolve.js";
import { validateConfig } from "./validate-config.js";
import type { MiftahConfig } from "./types.js";
import { MiftahError } from "../utils/errors.js";

export async function loadConfig(path: string): Promise<MiftahConfig> {
  const resolvedPath = resolvePath(path);
  let content: string;
  try {
    content = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new MiftahError("CONFIG_NOT_FOUND", `CONFIG_NOT_FOUND: unable to read config '${resolvedPath}'`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch (error) {
    throw new MiftahError("CONFIG_INVALID_JSON", `CONFIG_INVALID_JSON: config '${resolvedPath}' is not valid JSON`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  const config = validateConfig(input);
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, profile]) => [
      name,
      {
        ...profile,
        ...(profile.cwd ? { cwd: resolvePath(profile.cwd, dirname(resolvedPath)) } : {}),
        upstreams: profile.upstreams
          ? Object.fromEntries(
              Object.entries(profile.upstreams).map(([upstreamName, override]) => [
                upstreamName,
                {
                  ...override,
                  ...(override.cwd ? { cwd: resolvePath(override.cwd, dirname(resolvedPath)) } : {})
                }
              ])
            )
          : profile.upstreams
      }
    ])
  );
  return {
    ...config,
    profiles,
    secrets: config.secrets?.envFiles
      ? {
          ...config.secrets,
          envFiles: config.secrets.envFiles.map((envFile) => resolvePath(envFile, dirname(resolvedPath)))
        }
      : config.secrets,
    plugins: config.plugins
      ? {
          ...config.plugins,
          allowlist: config.plugins.allowlist.map((plugin) => ({
            ...plugin,
            path: resolvePath(plugin.path, dirname(resolvedPath))
          }))
        }
      : config.plugins,
    upstream: config.upstream
      ? {
          ...config.upstream,
          ...(config.upstream.cwd ? { cwd: resolvePath(config.upstream.cwd, dirname(resolvedPath)) } : {})
        }
      : undefined,
    upstreams: config.upstreams
      ? Object.fromEntries(
          Object.entries(config.upstreams).map(([name, upstream]) => [
            name,
            {
              ...upstream,
              ...(upstream.cwd ? { cwd: resolvePath(upstream.cwd, dirname(resolvedPath)) } : {})
            }
          ])
        )
      : config.upstreams,
    audit: config.audit?.path
      ? { ...config.audit, path: resolvePath(config.audit.path, dirname(resolvedPath)) }
      : config.audit
  };
}
