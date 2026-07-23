import { PROVIDER_ADAPTER_CATALOG, type ProviderAdapterDefinition } from "../config/provider-adapters.js";
import type { MiftahConfig } from "../config/types.js";

export interface ConsoleAuthenticationMetadata {
  readonly mode: "miftah-native-oauth" | "provider-adapter";
  readonly credentialOwner: "miftah" | "upstream" | "manual-only";
  readonly browserHandoff: "miftah" | "upstream" | "manual-only";
  readonly tokenStore: "miftah-vault" | "upstream-private" | "external";
  readonly provider?: string;
  readonly reauthOwner?: "miftah" | "upstream" | "manual-only";
  readonly disconnectOwner?: "miftah" | "upstream" | "manual-only";
  readonly identityEvidence?: "verified-probe" | "upstream-reported" | "unavailable";
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

function sameArguments(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}

function adapterForConfig(upstreams: readonly ConfiguredUpstream[]): ProviderAdapterDefinition | undefined {
  if (upstreams.length === 0) return undefined;
  return Object.values(PROVIDER_ADAPTER_CATALOG.adapters).find((adapter) =>
    upstreams.every((upstream) =>
      upstream.transport === adapter.launch.transport &&
      upstream.command === adapter.launch.command &&
      sameArguments(upstream.args, adapter.launch.args)
    )
  );
}

export function consoleAuthenticationMetadata(config: MiftahConfig): ConsoleAuthenticationMetadata {
  const adapter = adapterForConfig(configuredUpstreams(config));
  if (adapter === undefined) {
    return {
      mode: "miftah-native-oauth",
      credentialOwner: "miftah",
      browserHandoff: "miftah",
      tokenStore: "miftah-vault"
    };
  }
  return {
    mode: "provider-adapter",
    provider: adapter.displayName,
    credentialOwner: adapter.authentication.credentialOwnership,
    browserHandoff: adapter.authentication.browserHandoff,
    tokenStore: adapter.authentication.tokenStore,
    reauthOwner: adapter.lifecycle.reauth.owner,
    disconnectOwner: adapter.lifecycle.disconnect.owner,
    identityEvidence: adapter.identity.evidence
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
