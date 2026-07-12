import { ProfileManager } from "../profiles/profile-manager.js";
import { resolvePath } from "../config/path-resolve.js";
import { MultiUpstreamProcessManager } from "../upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../upstream/upstream-process-manager.js";
import { resolveRuntimeConfig, type RuntimeResolutionScope } from "./resolve-runtime-config.js";

/**
 * Loads configuration, resolves its secrets, and constructs the internal runtime managers.
 *
 * @param configPath - Path to the configuration file.
 * @returns The resolved configuration, upstream process manager, and profile manager.
 */
export async function createRuntime(configPath: string, scope?: RuntimeResolutionScope) {
  const runtimeConfigPath = resolvePath(configPath);
  const { config, upstream, secretValues, redactor } = await resolveRuntimeConfig(runtimeConfigPath, scope);
  const managerOptions = { ...config.process, secretValues: [...secretValues], redactor };
  const manager = config.upstreams
    ? new MultiUpstreamProcessManager(config, managerOptions)
    : new UpstreamProcessManager(upstream!, config.profiles, managerOptions);
  const profileManager = new ProfileManager(
    config,
    config.security,
    config.state === undefined ? undefined : { ...config.state, configPath: runtimeConfigPath }
  );
  await profileManager.initialize();
  return { config, manager, profileManager, redactor };
}
