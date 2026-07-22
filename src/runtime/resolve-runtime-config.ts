import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "../config/load-config.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig, UpstreamConfig } from "../config/types.js";
import { SecretRedactor } from "../secrets/redact.js";
import { SecretResolver } from "../secrets/secret-resolver.js";
import { loadPluginRegistry, type PluginRegistry } from "../plugins/plugin-registry.js";
import { MiftahError } from "../utils/errors.js";

export interface ResolvedRuntimeConfig {
  readonly config: MiftahConfig;
  readonly upstream: UpstreamConfig | undefined;
  readonly secretValues: readonly string[];
  readonly redactor: SecretRedactor;
  /** Runtime-owned allowlisted plugins, preflighted before any MCP server is constructed. */
  readonly plugins: PluginRegistry;
}

/** Limits secret resolution to one doctor-owned profile/upstream target. */
export interface RuntimeResolutionScope {
  readonly profile: string;
  readonly upstreamName?: string;
}

/** Opt-in resolution for credentials owned by a host rather than a profile/upstream runtime. */
export interface RuntimeResolutionOptions {
  readonly resolveServerHttpAuthToken?: boolean;
}

/** Loads a configuration and resolves every supported secret-bearing configuration map. */
export async function resolveRuntimeConfig(
  configPath: string,
  scope?: RuntimeResolutionScope,
  options: RuntimeResolutionOptions = {}
): Promise<ResolvedRuntimeConfig> {
  const requestedConfigPath = resolvePath(configPath);
  const canonicalConfigPath = await realpath(requestedConfigPath).catch(() => requestedConfigPath);
  const config = await loadConfig(canonicalConfigPath);
  validateResolutionScope(config, scope);
  const plugins = await loadPluginRegistry(config.plugins, { rootDirectory: dirname(canonicalConfigPath) });
  const redactor = new SecretRedactor();
  const resolver = new SecretResolver({
    envFiles: config.secrets?.envFiles,
    allowPlaintextSecrets: config.secrets?.allowPlaintextSecrets ?? config.security?.allowPlaintextSecrets,
    providerTimeoutMs: config.secrets?.providerTimeoutMs,
    redactor,
    plugins
  });
  await resolver.load();
  const secretValues = new Set<string>();
  const resolveMap = async (
    values: Record<string, string> | undefined
  ): Promise<Record<string, string> | undefined> => {
    if (!values) return values;
    const resolved = await resolver.resolveMapWithSecretValues(values);
    for (const value of resolved.secretValues) secretValues.add(value);
    return resolved.values;
  };
  const resolveValue = async (value: string | undefined): Promise<string | undefined> => {
    if (value === undefined) return undefined;
    const resolved = await resolver.resolveValueWithSecretValues(value);
    for (const secretValue of resolved.secretValues) secretValues.add(secretValue);
    return resolved.value;
  };
  const profiles = Object.fromEntries(
    await Promise.all(
      Object.entries(config.profiles).map(async ([name, profile]) => {
        if (scope !== undefined && name !== scope.profile) return [name, profile];
        const upstreams = profile.upstreams
          ? Object.fromEntries(
              await Promise.all(
                Object.entries(profile.upstreams).map(async ([upstreamName, override]) => {
                  if (scope !== undefined && upstreamName !== scope.upstreamName) return [upstreamName, override];
                  return [
                    upstreamName,
                    {
                      ...override,
                      env: await resolveMap(override.env),
                      headers: await resolveMap(override.headers)
                    }
                  ];
                })
              )
            )
          : profile.upstreams;
        return [
          name,
          {
            ...profile,
            env: await resolveMap(profile.env),
            headers: await resolveMap(profile.headers),
            upstreams
          }
        ];
      })
    )
  );
  const upstreams = config.upstreams
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(config.upstreams).map(async ([name, upstream]) => {
            if (scope !== undefined && name !== scope.upstreamName) return [name, upstream];
            return [
              name,
              {
                ...upstream,
                env: await resolveMap(upstream.env),
                headers: await resolveMap(upstream.headers)
              }
            ];
          })
        )
      )
    : config.upstreams;
  const resolveRootUpstream = async <Upstream extends UpstreamConfig>(
    candidate: Upstream | undefined
  ): Promise<Upstream | undefined> => {
    if (candidate === undefined || scope?.upstreamName !== undefined) return candidate;
    return {
      ...candidate,
      env: await resolveMap(candidate.env),
      headers: await resolveMap(candidate.headers)
    };
  };
  const server = config.server
    ? {
        ...config.server,
        http: config.server.http
          ? {
              ...config.server.http,
              authToken:
                scope === undefined && options.resolveServerHttpAuthToken === true
                  ? await resolveValue(config.server.http.authToken)
                  : config.server.http.authToken
            }
          : undefined
      }
    : undefined;
  let upstream: UpstreamConfig | undefined;
  let resolvedConfig: MiftahConfig;
  if (config.version === "1") {
    const resolvedUpstream = await resolveRootUpstream(config.upstream);
    upstream = resolvedUpstream;
    resolvedConfig = { ...config, profiles, upstreams, upstream: resolvedUpstream, server };
  } else {
    const resolvedUpstream = await resolveRootUpstream(config.upstream);
    upstream = resolvedUpstream;
    resolvedConfig = { ...config, profiles, upstreams, upstream: resolvedUpstream, server };
  }
  const values = [...secretValues];
  return {
    config: resolvedConfig,
    upstream,
    secretValues: values,
    redactor,
    plugins
  };
}

function validateResolutionScope(config: MiftahConfig, scope: RuntimeResolutionScope | undefined): void {
  if (scope === undefined) return;
  if (config.profiles[scope.profile] === undefined) {
    throw new MiftahError(
      "CONFIG_SCHEMA_INVALID",
      "CONFIG_SCHEMA_INVALID: scoped secret resolution profile is not configured"
    );
  }
  if (config.upstreams) {
    if (scope.upstreamName === undefined || config.upstreams[scope.upstreamName] === undefined) {
      throw new MiftahError(
        "CONFIG_SCHEMA_INVALID",
        "CONFIG_SCHEMA_INVALID: scoped secret resolution upstream is not configured"
      );
    }
    return;
  }
  if (scope.upstreamName !== undefined || config.upstream === undefined) {
    throw new MiftahError(
      "CONFIG_SCHEMA_INVALID",
      "CONFIG_SCHEMA_INVALID: scoped secret resolution upstream is not configured"
    );
  }
}
