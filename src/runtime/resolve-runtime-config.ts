import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "../config/load-config.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig, PluginsConfig, UpstreamConfig } from "../config/types.js";
import { SecretRedactor } from "../secrets/redact.js";
import { SecretResolver } from "../secrets/secret-resolver.js";
import { loadPluginRegistry, type PluginRegistry } from "../plugins/plugin-registry.js";
import { parsePluginSecretReference } from "../plugins/plugin-secret-reference.js";
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
  /** Cancels scoped secret/plugin resolution before a runtime is constructed. */
  readonly signal?: AbortSignal;
}

/** Loads a configuration and resolves every supported secret-bearing configuration map. */
export async function resolveRuntimeConfig(
  configPath: string,
  scope?: RuntimeResolutionScope,
  options: RuntimeResolutionOptions = {}
): Promise<ResolvedRuntimeConfig> {
  throwIfResolutionCancelled(options.signal);
  const requestedConfigPath = resolvePath(configPath);
  const canonicalConfigPath = await realpath(requestedConfigPath).catch(() => requestedConfigPath);
  throwIfResolutionCancelled(options.signal);
  const config = await loadConfig(canonicalConfigPath);
  throwIfResolutionCancelled(options.signal);
  return resolveRuntimeConfigFromLoadedConfig(canonicalConfigPath, config, scope, options);
}

/**
 * Resolves runtime dependencies from configuration bytes already loaded by a
 * trusted caller. Unlike resolveRuntimeConfig, this function never reopens the
 * configuration pathname.
 */
export async function resolveRuntimeConfigFromLoadedConfig(
  configPath: string,
  config: MiftahConfig,
  scope?: RuntimeResolutionScope,
  options: RuntimeResolutionOptions = {}
): Promise<ResolvedRuntimeConfig> {
  throwIfResolutionCancelled(options.signal);
  const canonicalConfigPath = resolvePath(configPath);
  validateResolutionScope(config, scope);
  let plugins: PluginRegistry;
  try {
    plugins = await loadPluginRegistry(pluginsForResolution(config, scope), {
      rootDirectory: dirname(canonicalConfigPath),
      signal: options.signal
    });
  } catch (error) {
    if (options.signal?.aborted) throw resolutionCancelledError();
    throw error;
  }
  throwIfResolutionCancelled(options.signal);
  const redactor = new SecretRedactor();
  const resolver = new SecretResolver({
    envFiles: config.secrets?.envFiles,
    allowPlaintextSecrets: config.secrets?.allowPlaintextSecrets ?? config.security?.allowPlaintextSecrets,
    providerTimeoutMs: config.secrets?.providerTimeoutMs,
    redactor,
    plugins,
    signal: options.signal
  });
  await resolver.load();
  throwIfResolutionCancelled(options.signal);
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

function throwIfResolutionCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw resolutionCancelledError();
}

function resolutionCancelledError(): MiftahError {
  return new MiftahError("SECRET_PROVIDER_CANCELLED", "SECRET_PROVIDER_CANCELLED: runtime resolution was cancelled");
}

/**
 * A scoped runtime never evaluates routing. It preflights only the local secret-provider
 * plugins referenced by that exact profile/upstream target, so an unrelated extension
 * cannot execute or block a bounded readiness/doctor operation.
 */
function pluginsForResolution(
  config: MiftahConfig,
  scope: RuntimeResolutionScope | undefined
): PluginsConfig | undefined {
  if (scope === undefined || config.plugins === undefined) return config.plugins;
  const providerIds = referencedPluginProviderIds(config, scope);
  return {
    ...config.plugins,
    allowlist: config.plugins.allowlist.filter(
      (plugin) => plugin.kind === "secret-provider" && providerIds.has(plugin.id)
    )
  };
}

function referencedPluginProviderIds(config: MiftahConfig, scope: RuntimeResolutionScope): ReadonlySet<string> {
  const profile = config.profiles[scope.profile];
  const upstream = config.upstreams === undefined
    ? config.upstream
    : config.upstreams[scope.upstreamName!];
  const override = scope.upstreamName === undefined ? undefined : profile?.upstreams?.[scope.upstreamName];
  const ids = new Set<string>();
  for (const values of [upstream?.env, upstream?.headers, profile?.env, profile?.headers, override?.env, override?.headers]) {
    for (const value of Object.values(values ?? {})) {
      const reference = parsePluginSecretReference(value);
      if (reference !== undefined) ids.add(reference.providerId);
    }
  }
  return ids;
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
