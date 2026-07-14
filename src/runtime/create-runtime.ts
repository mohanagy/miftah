import { realpath } from "node:fs/promises";
import { ProfileManager } from "../profiles/profile-manager.js";
import { ProfileRuntimeIsolation } from "../isolation/profile-runtime-isolation.js";
import { resolvePath } from "../config/path-resolve.js";
import { MultiUpstreamProcessManager } from "../upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../upstream/upstream-process-manager.js";
import { resolveRuntimeConfig, type RuntimeResolutionScope } from "./resolve-runtime-config.js";
import type { StateConfig } from "../config/types.js";

/** Internal runtime construction overrides for hosts with a narrower lifecycle boundary. */
export interface RuntimeCreationOptions {
  /** Overrides profile-state persistence without changing the resolved public configuration. */
  profileState?: StateConfig;
}

/**
 * Loads configuration, resolves its secrets, and constructs the internal runtime managers.
 *
 * @param configPath - Path to the configuration file.
 * @returns The resolved configuration, upstream process manager, and profile manager.
 */
export async function createRuntime(
  configPath: string,
  scope?: RuntimeResolutionScope,
  options: RuntimeCreationOptions = {}
) {
  const configuredPath = resolvePath(configPath);
  const runtimeConfigPath = await realpath(configuredPath).catch(() => configuredPath);
  const { config, upstream, secretValues, redactor, plugins } = await resolveRuntimeConfig(runtimeConfigPath, scope);
  const isolation = new ProfileRuntimeIsolation({ configPath: runtimeConfigPath, redactor });
  const managerOptions = { ...config.process, secretValues: [...secretValues], redactor, isolation };
  const manager = config.upstreams
    ? new MultiUpstreamProcessManager(config, managerOptions)
    : new UpstreamProcessManager(upstream!, config.profiles, managerOptions);
  const profileState = options.profileState ?? config.state;
  const profileManager = new ProfileManager(
    config,
    config.security,
    profileState === undefined ? undefined : { ...profileState, configPath: runtimeConfigPath }
  );
  await profileManager.initialize();
  return { config, manager, profileManager, redactor, plugins };
}
