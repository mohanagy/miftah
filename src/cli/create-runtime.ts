import { loadConfig } from "../config/load-config.js";
import { ProfileManager } from "../profiles/profile-manager.js";
import { SecretResolver } from "../secrets/secret-resolver.js";
import { MultiUpstreamProcessManager } from "../upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../upstream/upstream-process-manager.js";

/** Validates configuration before resolving secrets or constructing upstream runtime state. */
export async function createRuntime(configPath: string) {
  const config = await loadConfig(configPath);
  const resolver = new SecretResolver({
    envFiles: config.secrets?.envFiles,
    allowPlaintextSecrets: config.secrets?.allowPlaintextSecrets ?? config.security?.allowPlaintextSecrets
  });
  await resolver.load();
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, profile]) => [
      name,
      {
        ...profile,
        env: profile.env ? resolver.resolveMap(profile.env) : profile.env,
        headers: profile.headers ? resolver.resolveMap(profile.headers) : profile.headers,
        upstreams: profile.upstreams
          ? Object.fromEntries(
              Object.entries(profile.upstreams).map(([upstreamName, override]) => [
                upstreamName,
                {
                  ...override,
                  env: override.env ? resolver.resolveMap(override.env) : override.env,
                  headers: override.headers ? resolver.resolveMap(override.headers) : override.headers
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
            env: upstream.env ? resolver.resolveMap(upstream.env) : undefined,
            headers: upstream.headers ? resolver.resolveMap(upstream.headers) : undefined
          }
        ])
      )
    : config.upstreams;
  const resolvedConfig = { ...config, profiles, upstreams };
  const upstream = resolvedConfig.upstream
    ? {
        ...resolvedConfig.upstream,
        env: resolvedConfig.upstream.env ? resolver.resolveMap(resolvedConfig.upstream.env) : undefined,
        headers: resolvedConfig.upstream.headers ? resolver.resolveMap(resolvedConfig.upstream.headers) : undefined
      }
    : undefined;
  const manager = resolvedConfig.upstreams
    ? new MultiUpstreamProcessManager(resolvedConfig, config.process)
    : new UpstreamProcessManager(upstream!, profiles, config.process);
  const profileManager = new ProfileManager(resolvedConfig, resolvedConfig.security);
  return { config: resolvedConfig, manager, profileManager };
}
