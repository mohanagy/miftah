import { loadConfig } from "../config/load-config.js";
import { ProfileManager } from "../profiles/profile-manager.js";
import { SecretResolver } from "../secrets/secret-resolver.js";
import { SecretRedactor } from "../secrets/redact.js";
import { MultiUpstreamProcessManager } from "../upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../upstream/upstream-process-manager.js";

/**
 * Loads configuration, resolves its secrets, and constructs the internal runtime managers.
 *
 * @param configPath - Path to the configuration file.
 * @returns The resolved configuration, upstream process manager, and profile manager.
 */
export async function createRuntime(configPath: string) {
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
  const resolvedConfig = { ...config, profiles, upstreams };
  const upstream = resolvedConfig.upstream
    ? {
        ...resolvedConfig.upstream,
        env: resolveMap(resolvedConfig.upstream.env),
        headers: resolveMap(resolvedConfig.upstream.headers)
      }
    : undefined;
  const redactor = new SecretRedactor([...secretValues]);
  const managerOptions = { ...config.process, secretValues: [...secretValues], redactor };
  const manager = resolvedConfig.upstreams
    ? new MultiUpstreamProcessManager(resolvedConfig, managerOptions)
    : new UpstreamProcessManager(upstream!, profiles, managerOptions);
  const profileManager = new ProfileManager(resolvedConfig, resolvedConfig.security);
  return { config: resolvedConfig, manager, profileManager, redactor };
}
