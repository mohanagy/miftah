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
  const redactor = new SecretRedactor();
  const resolver = new SecretResolver({
    envFiles: config.secrets?.envFiles,
    allowPlaintextSecrets: config.secrets?.allowPlaintextSecrets ?? config.security?.allowPlaintextSecrets,
    redactor
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
  const profiles = Object.fromEntries(
    await Promise.all(Object.entries(config.profiles).map(async ([name, profile]) => [
      name,
      {
        ...profile,
        env: await resolveMap(profile.env),
        headers: await resolveMap(profile.headers),
        upstreams: profile.upstreams
          ? Object.fromEntries(
              await Promise.all(Object.entries(profile.upstreams).map(async ([upstreamName, override]) => [
                upstreamName,
                {
                  ...override,
                  env: await resolveMap(override.env),
                  headers: await resolveMap(override.headers)
                }
              ]))
            )
          : profile.upstreams
      }
    ]))
  );
  const upstreams = config.upstreams
    ? Object.fromEntries(
        await Promise.all(Object.entries(config.upstreams).map(async ([name, upstream]) => [
          name,
          {
            ...upstream,
            env: await resolveMap(upstream.env),
            headers: await resolveMap(upstream.headers)
          }
        ]))
      )
    : config.upstreams;
  const upstream = config.upstream
    ? {
        ...config.upstream,
        env: await resolveMap(config.upstream.env),
        headers: await resolveMap(config.upstream.headers)
      }
    : undefined;
  const resolvedConfig = { ...config, profiles, upstreams, upstream };
  const values = [...secretValues];
  return {
    config: resolvedConfig,
    upstream,
    secretValues: values,
    redactor
  };
}
