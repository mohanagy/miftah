import { writeNewConfigFile } from "../cli/migrate-config.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig, TransportType, UpstreamConfig } from "../config/types.js";
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

/** A non-secret review summary for a configuration that has not been published yet. */
export interface SetupConfigurationPreview {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly version: MiftahConfig["version"];
  readonly defaultProfile: string;
  readonly profiles: readonly string[];
  readonly profileCount: number;
  readonly upstreams: readonly SetupConfigurationUpstreamPreview[];
  /** Values which could contain credentials, paths, launch arguments, or remote endpoints never leave the planner. */
  readonly sensitiveValues: "omitted";
  /** The only supported first-run publication behavior. */
  readonly publication: "new-file-only";
}

export interface SetupConfigurationUpstreamPreview {
  readonly name: string;
  readonly transport: TransportType;
  readonly kind: "local-process" | "remote-mcp";
}

/** Validates and serializes a new configuration before any output path is created. */
export function createSetupConfigurationPlan(request: SetupConfigurationRequest): SetupConfigurationPlan {
  const config = validateConfig(request.config);
  return {
    path: resolvePath(request.configPath, request.cwd),
    content: `${JSON.stringify(config, null, 2)}\n`
  };
}

function describeUpstream(name: string, upstream: UpstreamConfig): SetupConfigurationUpstreamPreview {
  return {
    name,
    transport: upstream.transport,
    kind: upstream.transport === "stdio" ? "local-process" : "remote-mcp"
  };
}

/**
 * Returns only the durable structure a person needs to review before Miftah
 * writes a configuration. Configuration bytes, paths, launch shapes, endpoint
 * URLs, environment names, headers, OAuth metadata, and secret references stay
 * inside the local planner.
 */
export function describeSetupConfiguration(input: MiftahConfig): SetupConfigurationPreview {
  const config = validateConfig(input);
  const upstreams: SetupConfigurationUpstreamPreview[] = [];
  if (config.upstream !== undefined) upstreams.push(describeUpstream("default", config.upstream));
  for (const [name, upstream] of Object.entries(config.upstreams ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    upstreams.push(describeUpstream(name, upstream));
  }

  const profiles = Object.keys(config.profiles).sort((left, right) => left.localeCompare(right));
  return {
    schemaVersion: 1,
    name: config.name,
    version: config.version,
    defaultProfile: config.defaultProfile,
    profiles,
    profileCount: profiles.length,
    upstreams,
    sensitiveValues: "omitted",
    publication: "new-file-only"
  };
}

/** Publishes only the previously validated bytes through the non-overwriting secure writer. */
export function publishSetupConfigurationPlan(plan: SetupConfigurationPlan): Promise<void> {
  return writeNewConfigFile(plan.path, plan.content);
}
