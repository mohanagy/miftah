import { realpath } from "node:fs/promises";
import { ProfileManager } from "../profiles/profile-manager.js";
import { ProfileRuntimeIsolation } from "../isolation/profile-runtime-isolation.js";
import { resolvePath } from "../config/path-resolve.js";
import { MultiUpstreamProcessManager } from "../upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../upstream/upstream-process-manager.js";
import {
  resolveRuntimeConfig,
  resolveRuntimeConfigFromLoadedConfig,
  type ResolvedRuntimeConfig,
  type RuntimeResolutionScope
} from "./resolve-runtime-config.js";
import type { MiftahConfig, StateConfig } from "../config/types.js";
import {
  createRemoteOAuthRuntime,
  type RemoteOAuthRuntimeOptions
} from "../oauth/remote-oauth-runtime.js";
import { IdentityManager, type IdentityManagerOptions } from "../identity/identity-manager.js";
import {
  defaultIdentityBindingPath,
  FileIdentityBindingStore
} from "../identity/identity-binding-store.js";

/** Internal runtime construction overrides for hosts with a narrower lifecycle boundary. */
export interface RuntimeCreationOptions {
  /** Overrides profile-state persistence without changing the resolved public configuration. */
  profileState?: StateConfig;
  /** Internal protocol dependencies used by deterministic OAuth fixtures and native runtime wiring. */
  oauth?: RemoteOAuthRuntimeOptions;
  /** Internal persistence seam for deterministic identity-binding tests. */
  identity?: IdentityManagerOptions;
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
  const resolved = await resolveRuntimeConfig(runtimeConfigPath, scope);
  return createRuntimeFromResolvedConfig(runtimeConfigPath, resolved, options);
}

/**
 * Constructs a runtime from configuration that a trusted caller has already
 * opened and validated. It deliberately does not reopen configPath.
 */
export async function createRuntimeFromLoadedConfig(
  configPath: string,
  config: MiftahConfig,
  scope?: RuntimeResolutionScope,
  options: RuntimeCreationOptions = {}
) {
  const runtimeConfigPath = resolvePath(configPath);
  const resolved = await resolveRuntimeConfigFromLoadedConfig(runtimeConfigPath, config, scope);
  return createRuntimeFromResolvedConfig(runtimeConfigPath, resolved, options);
}

async function createRuntimeFromResolvedConfig(
  runtimeConfigPath: string,
  resolved: ResolvedRuntimeConfig,
  options: RuntimeCreationOptions
) {
  const { config, upstream, secretValues, redactor, plugins } = resolved;
  const isolation = new ProfileRuntimeIsolation({ configPath: runtimeConfigPath, redactor });
  const oauth = await createRemoteOAuthRuntime(runtimeConfigPath, config, redactor, options.oauth);
  const identities = new IdentityManager(config, {
    bindingStore:
      options.identity?.bindingStore ??
      new FileIdentityBindingStore(defaultIdentityBindingPath(runtimeConfigPath))
  });
  await identities.initialize();
  const managerOptions = {
    ...config.process,
    secretValues: [...secretValues],
    redactor,
    isolation,
    ...(oauth === undefined
      ? {}
      : {
          oauthProvider: (profile: string, upstreamName: string) => oauth.provider(profile, upstreamName),
          ...(oauth.fetch === undefined ? {} : { remoteFetch: oauth.fetch })
        })
  };
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
  return { config, manager, profileManager, redactor, plugins, oauth, identities };
}
