import {
  getProviderAdapterForProfileTarget,
  type ProviderAdapterDefinition
} from "../config/provider-adapters.js";
import type { MiftahConfig } from "../config/types.js";

export interface ConsoleAuthenticationMetadata {
  /**
   * `manual-only` means this local configuration is neither eligible for
   * Miftah-native OAuth nor wholly inside one reviewed provider adapter.
   */
  readonly mode: "miftah-native-oauth" | "provider-adapter" | "manual-only";
  readonly credentialOwner: "miftah" | "upstream" | "manual-only";
  readonly browserHandoff: "miftah" | "upstream" | "manual-only";
  readonly tokenStore: "miftah-vault" | "upstream-private" | "external";
  readonly provider?: string;
  readonly reauthOwner?: "miftah" | "upstream" | "manual-only";
  readonly disconnectOwner?: "miftah" | "upstream" | "manual-only";
  readonly identityEvidence?: "verified-probe" | "upstream-reported" | "unavailable";
  /** Exact non-secret profile/upstream pairs that remain inside a reviewed safe-read adapter envelope. */
  readonly readinessTargets?: readonly ConsoleProfileReadinessTarget[];
}

export interface ConsoleProfileReadinessTarget {
  readonly profile: string;
  readonly upstream: string;
}

export interface ConsoleDiscoveredConfiguration {
  /** Opaque per-process identifier. The Console never exposes a local path. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly profileCount: number;
  readonly defaultProfile: string;
  readonly authentication: ConsoleAuthenticationMetadata;
  readonly source: "standard-config-directory";
}

export interface ConsoleConfigCatalog {
  readonly source: "standard-config-directory";
  readonly discoveryState: "ready" | "unavailable";
  readonly configurations: readonly ConsoleDiscoveredConfiguration[];
  readonly selectedConfigurationId?: string;
}

export interface ConsoleInitializedConfigMetadata {
  readonly initialized: true;
  readonly name: string;
  readonly version: string;
  readonly defaultProfile: string;
  readonly profiles: readonly {
    readonly name: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly policy?: string;
    readonly upstreams?: readonly string[];
  }[];
  readonly upstreams: readonly { readonly name: string; readonly transport: string }[];
  readonly oauthConnectionCount: number;
  /** Present for live Console services; optional for embedding compatibility. */
  readonly authentication?: ConsoleAuthenticationMetadata;
  /** Present only for a no-config dashboard invocation. */
  readonly catalog?: ConsoleConfigCatalog;
  readonly restartRequiredForExistingClients: true;
}

export interface ConsoleUninitializedConfigMetadata {
  readonly initialized: false;
  /** Present only for a no-config dashboard invocation. */
  readonly catalog?: ConsoleConfigCatalog;
  readonly restartRequiredForExistingClients: true;
}

export type ConsoleConfigMetadata = ConsoleInitializedConfigMetadata | ConsoleUninitializedConfigMetadata;

interface ConfiguredUpstream {
  readonly name: string;
  readonly transport: string;
  readonly command?: string;
  readonly args?: readonly string[];
}

function configuredUpstreams(config: MiftahConfig): readonly ConfiguredUpstream[] {
  const upstreams = config.upstreams === undefined
    ? config.upstream === undefined
      ? []
      : [["default", config.upstream] as const]
    : Object.entries(config.upstreams);
  return upstreams
    .map(([name, upstream]) => ({
      name,
      transport: upstream.transport,
      ...(upstream.transport === "stdio" ? { command: upstream.command, args: upstream.args } : {})
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readinessTargets(config: MiftahConfig): readonly ConsoleProfileReadinessTarget[] {
  return Object.keys(config.profiles)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((profile) => configuredUpstreams(config)
      .filter(({ name: upstream }) => getProviderAdapterForProfileTarget(config, profile, upstream)?.diagnostics.safeReadProbe !== undefined)
      .map(({ name: upstream }) => ({ profile, upstream })));
}

/**
 * A base upstream may carry an older argument default while every effective
 * profile launch is the reviewed adapter. In that case the Console can still
 * accurately describe the configuration as provider-owned. A partial target
 * set is never enough: one outside-envelope target makes provider ownership
 * and native OAuth both inaccurate for the configuration as a whole.
 */
function adapterForEffectiveTargets(
  config: MiftahConfig,
  targets: readonly ConsoleProfileReadinessTarget[]
): ProviderAdapterDefinition | undefined {
  const upstreams = configuredUpstreams(config);
  const expectedTargetCount = Object.keys(config.profiles).length * upstreams.length;
  if (targets.length === 0 || targets.length !== expectedTargetCount) return undefined;

  const adapters = targets.map(({ profile, upstream }) => getProviderAdapterForProfileTarget(config, profile, upstream));
  const adapter = adapters[0];
  return adapter !== undefined && adapters.every((candidate) => candidate === adapter) ? adapter : undefined;
}

function supportsNativeOAuth(upstreams: readonly ConfiguredUpstream[]): boolean {
  return upstreams.length > 0 && upstreams.every(({ transport }) => transport === "streamable-http");
}

export function consoleAuthenticationMetadata(config: MiftahConfig): ConsoleAuthenticationMetadata {
  const upstreams = configuredUpstreams(config);
  const targets = readinessTargets(config);
  const adapter = adapterForEffectiveTargets(config, targets);
  if (adapter !== undefined) {
    return {
      mode: "provider-adapter",
      provider: adapter.displayName,
      credentialOwner: adapter.authentication.credentialOwnership,
      browserHandoff: adapter.authentication.browserHandoff,
      tokenStore: adapter.authentication.tokenStore,
      reauthOwner: adapter.lifecycle.reauth.owner,
      disconnectOwner: adapter.lifecycle.disconnect.owner,
      identityEvidence: adapter.identity.evidence,
      readinessTargets: targets
    };
  }

  if (!supportsNativeOAuth(upstreams)) {
    return {
      mode: "manual-only",
      credentialOwner: "manual-only",
      browserHandoff: "manual-only",
      tokenStore: "external",
      ...(targets.length === 0 ? {} : { readinessTargets: targets })
    };
  }

  return {
    mode: "miftah-native-oauth",
    credentialOwner: "miftah",
    browserHandoff: "miftah",
    tokenStore: "miftah-vault",
    ...(targets.length === 0 ? {} : { readinessTargets: targets })
  };
}

/** Builds the fixed allowlist of configuration data safe for the local Console response. */
export function consoleInitializedConfigMetadata(config: MiftahConfig): ConsoleInitializedConfigMetadata {
  const upstreams = configuredUpstreams(config);
  return {
    initialized: true,
    name: config.name,
    version: config.version,
    defaultProfile: config.defaultProfile,
    profiles: Object.entries(config.profiles)
      .map(([name, profile]) => ({
        name,
        ...(profile.description === undefined ? {} : { description: profile.description }),
        ...(profile.tags === undefined ? {} : { tags: [...profile.tags] }),
        ...(profile.policy === undefined ? {} : { policy: profile.policy }),
        ...(profile.upstreams === undefined ? {} : { upstreams: Object.keys(profile.upstreams).sort() })
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    upstreams: upstreams.map(({ name, transport }) => ({ name, transport })),
    oauthConnectionCount: config.version === "3" ? Object.keys(config.oauth?.connections ?? {}).length : 0,
    authentication: consoleAuthenticationMetadata(config),
    restartRequiredForExistingClients: true
  };
}
