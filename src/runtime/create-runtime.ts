import { ProfileManager } from "../profiles/profile-manager.js";
import { MultiUpstreamProcessManager } from "../upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../upstream/upstream-process-manager.js";
import { resolveRuntimeConfig } from "./resolve-runtime-config.js";

/**
 * Loads configuration, resolves its secrets, and constructs the internal runtime managers.
 *
 * @param configPath - Path to the configuration file.
 * @returns The resolved configuration, upstream process manager, and profile manager.
 */
export async function createRuntime(configPath: string) {
  const { config, upstream, secretValues, redactor } = await resolveRuntimeConfig(configPath);
  const managerOptions = { ...config.process, secretValues: [...secretValues], redactor };
  const manager = config.upstreams
    ? new MultiUpstreamProcessManager(config, managerOptions)
    : new UpstreamProcessManager(upstream!, config.profiles, managerOptions);
  const profileManager = new ProfileManager(config, config.security);
  return { config, manager, profileManager, redactor };
}
