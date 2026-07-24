import { writeNewConfigFile } from "../cli/migrate-config.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig } from "../config/types.js";
import { validateConfig } from "../config/validate-config.js";

export interface SetupConfigurationRequest {
  readonly configPath: string;
  readonly config: MiftahConfig;
  /** Resolves a relative config path without changing the serialized configuration. */
  readonly cwd?: string;
}

/** Immutable, validated bytes for a new configuration that has not yet been published. */
export interface SetupConfigurationPlan {
  readonly path: string;
  readonly content: string;
}

/** Validates and serializes a new configuration before any output path is created. */
export function createSetupConfigurationPlan(request: SetupConfigurationRequest): SetupConfigurationPlan {
  const config = validateConfig(request.config);
  return {
    path: resolvePath(request.configPath, request.cwd),
    content: `${JSON.stringify(config, null, 2)}\n`
  };
}

/** Publishes only the previously validated bytes through the non-overwriting secure writer. */
export function publishSetupConfigurationPlan(plan: SetupConfigurationPlan): Promise<void> {
  return writeNewConfigFile(plan.path, plan.content);
}
