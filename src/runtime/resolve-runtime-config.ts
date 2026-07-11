import { loadConfig } from "../config/load-config.js";
import type { MiftahConfig, UpstreamConfig } from "../config/types.js";
import { SecretRedactor } from "../secrets/redact.js";
import { SecretResolver } from "../secrets/secret-resolver.js";

export interface ResolvedRuntimeConfig {
  readonly config: MiftahConfig;
  readonly upstream: UpstreamConfig | undefined;
  readonly secretValues: readonly string[];
  readonly redactor: SecretRedactor;
}

/** Loads a configuration and resolves every supported secret-bearing configuration map. */
export async function resolveRuntimeConfig(configPath: string): Promise<ResolvedRuntimeConfig> {
  const config = await loadConfig(configPath);
  const resolver = new SecretResolver({
    envFiles: config.secrets?.envFiles,
    allowPlaintextSecrets: config.secrets?.allowPlaintextSecrets ?? config.security?.allowPlaintextSecrets
  });
  await resolver.load();
  const secretValues = new Set<string>();
  const resolveMap = (values: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!values) return values;
    const resolved = resolver.resolveMapWithSecretValues(values);
    for (const value of resolved.secretValues) secretValues.add(value);
    return resolved.values;
  };
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, profile]) => [
      name,
      {
        ...profile,
        env: resolveMap(profile.env),
        headers: resolveMap(profile.headers),
        upstreams: profile.upstreams
          ? Object.fromEntries(
              Object.entries(profile.upstreams).map(([upstreamName, override]) => [
                upstreamName,
                {
                  ...override,
                  env: resolveMap(override.env),
                  headers: resolveMap(override.headers)
                }
              ])
            )
          : profile.upstreams
      }
    ])
  );
  const upstreams = config.upstreams
    ? Object.fromEntries(
        Object.entries(config.upstreams).map(([name, upstream]) => [
          name,
          {
            ...upstream,
            env: resolveMap(upstream.env),
            headers: resolveMap(upstream.headers)
          }
        ])
      )
    : config.upstreams;
  const upstream = config.upstream
    ? {
        ...config.upstream,
        env: resolveMap(config.upstream.env),
        headers: resolveMap(config.upstream.headers)
      }
    : undefined;
  const resolvedConfig = { ...config, profiles, upstreams, upstream };
  const values = [...secretValues];
  return {
    config: resolvedConfig,
    upstream,
    secretValues: values,
    redactor: new SecretRedactor(values)
  };
}
