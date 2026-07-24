import type { MiftahConfig, ProfileConfig, ProfileUpstreamOverride, UpstreamConfig } from "./types.js";

export type ProviderAdapterOwner = "miftah" | "upstream" | "manual-only";

export type ProviderAuthenticationContract =
  | {
      readonly credentialOwnership: "miftah";
      readonly browserHandoff: "miftah";
      readonly tokenStore: "miftah-vault";
    }
  | {
      readonly credentialOwnership: "upstream";
      readonly browserHandoff: "upstream";
      readonly tokenStore: "upstream-private";
    }
  | {
      readonly credentialOwnership: "manual-only";
      readonly browserHandoff: "manual-only";
      readonly tokenStore: "external";
    };

export type ProviderAdapterOperation =
  | {
      readonly owner: ProviderAdapterOwner;
      readonly mechanism: "mcp-tool";
      readonly name: string;
    }
  | {
      readonly owner: ProviderAdapterOwner;
      readonly mechanism: "native" | "provider-console" | "operator";
      readonly name?: string;
    };

export type ProviderIdentityContract =
  | {
      readonly evidence: "verified-probe";
      readonly assurance: "verified";
    }
  | {
      readonly evidence: "upstream-reported";
      readonly assurance: "informational";
    }
  | {
      readonly evidence: "unavailable";
      readonly assurance: "none";
    };

export interface ProviderAdapterDefinition {
  readonly displayName: string;
  readonly preset: string;
  readonly launch: {
    readonly transport: "stdio";
    readonly command: string;
    readonly args: readonly string[];
    readonly prerequisites: readonly string[];
  };
  /**
   * Configuration-controlled process settings which must remain inside the reviewed adapter envelope.
   * A matching command string alone is not sufficient to trust an adapter diagnostic.
   */
  readonly execution: {
    /** Exact non-secret environment keys that may be supplied in adapter configuration. */
    readonly allowedEnvironment: readonly string[];
    /** The adapter is trusted only when it inherits its working directory. */
    readonly cwd: "inherit";
    /** The adapter is trusted only when no profile isolation override changes its launch boundary. */
    readonly isolation: "none";
  };
  readonly authentication: ProviderAuthenticationContract;
  readonly lifecycle: {
    readonly health: ProviderAdapterOperation;
    readonly reauth: ProviderAdapterOperation;
    readonly disconnect: ProviderAdapterOperation;
  };
  readonly identity: ProviderIdentityContract;
  readonly diagnostics: {
    readonly mode: "metadata-only";
    readonly tokenCacheAccess: "forbidden";
    /** A built-in, provider-declared tool Miftah may call once with `{}` during guided readiness. */
    readonly safeReadProbe?: {
      readonly name: string;
      readonly input: "empty-object";
    };
    /** @deprecated Use safeReadProbe for an executable first-success check. */
    readonly safeHealthTool?: string;
  };
  readonly destructiveTools: {
    readonly default: "disabled" | "upstream-default";
    readonly enablement: "manual-only" | "unsupported";
    readonly upstreamEnvironmentControl?: string;
  };
  readonly manualSetup: {
    readonly supported: true;
    readonly documentation: string;
  };
}

export const PROVIDER_ADAPTER_CATALOG = {
  version: "1",
  adapters: {
    "google-search-console": {
      displayName: "Google Search Console",
      preset: "google-search-console",
      launch: {
        transport: "stdio",
        command: "uvx",
        args: ["mcp-search-console@0.3.2"],
        prerequisites: ["Python >=3.11", "uv/uvx", "Google OAuth desktop client-secrets JSON"]
      },
      execution: {
        allowedEnvironment: [
          "GSC_OAUTH_CLIENT_SECRETS_FILE",
          "GSC_CONFIG_DIR",
          "GSC_CREDENTIALS_PATH",
          "GSC_SKIP_OAUTH"
        ],
        cwd: "inherit",
        isolation: "none"
      },
      authentication: {
        credentialOwnership: "upstream",
        browserHandoff: "upstream",
        tokenStore: "upstream-private"
      },
      lifecycle: {
        health: { owner: "upstream", mechanism: "mcp-tool", name: "get_capabilities" },
        reauth: { owner: "upstream", mechanism: "mcp-tool", name: "reauthenticate" },
        disconnect: { owner: "manual-only", mechanism: "provider-console" }
      },
      identity: { evidence: "unavailable", assurance: "none" },
      diagnostics: {
        mode: "metadata-only",
        tokenCacheAccess: "forbidden",
        safeReadProbe: { name: "get_capabilities", input: "empty-object" },
        safeHealthTool: "get_capabilities"
      },
      destructiveTools: {
        default: "disabled",
        enablement: "manual-only",
        upstreamEnvironmentControl: "GSC_ALLOW_DESTRUCTIVE"
      },
      manualSetup: {
        supported: true,
        documentation: "docs/provider-adapters.md#google-search-console-pilot"
      }
    }
  }
} as const satisfies {
  readonly version: string;
  readonly adapters: Record<string, ProviderAdapterDefinition>;
};

export type ProviderAdapterName = keyof typeof PROVIDER_ADAPTER_CATALOG.adapters;

export function getProviderAdapterForPreset(preset: string): ProviderAdapterDefinition | undefined {
  return Object.values(PROVIDER_ADAPTER_CATALOG.adapters).find((adapter) => adapter.preset === preset);
}

/**
 * Returns a trusted adapter only when the selected profile will launch its exact pinned command and argument array.
 * The effective profile argument array is the launch boundary; a base default that is superseded by that array is not.
 */
export function getProviderAdapterForProfileTarget(
  config: MiftahConfig,
  profileName: string,
  upstreamName: string
): ProviderAdapterDefinition | undefined {
  const profile = config.profiles[profileName];
  const upstream = configuredUpstream(config, upstreamName);
  if (profile === undefined || upstream === undefined) return undefined;
  // Singleton configurations have no named upstream map at runtime. Treating a
  // same-named profile override as effective here would validate a launch shape
  // that the runtime will never execute.
  const override = config.upstreams === undefined ? undefined : profile.upstreams?.[upstreamName];
  const effectiveArguments = override?.args ?? profile.args ?? upstream.args ?? [];
  return Object.values(PROVIDER_ADAPTER_CATALOG.adapters).find(
    (adapter) =>
      matchesAdapter(upstream, adapter) &&
      sameArguments(effectiveArguments, adapter.launch.args) &&
      matchesExecutionEnvelope(upstream, profile, override, adapter)
  );
}

function configuredUpstream(config: MiftahConfig, upstreamName: string): UpstreamConfig | undefined {
  if (config.upstreams !== undefined) return config.upstreams[upstreamName];
  return upstreamName === "default" ? config.upstream : undefined;
}

function matchesAdapter(upstream: UpstreamConfig, adapter: ProviderAdapterDefinition): boolean {
  return (
    upstream.transport === adapter.launch.transport &&
    upstream.command === adapter.launch.command
  );
}

function matchesExecutionEnvelope(
  upstream: UpstreamConfig,
  profile: ProfileConfig,
  override: ProfileUpstreamOverride | undefined,
  adapter: ProviderAdapterDefinition
): boolean {
  if (adapter.execution.cwd === "inherit" && (upstream.cwd !== undefined || profile.cwd !== undefined || override?.cwd !== undefined)) {
    return false;
  }
  if (adapter.execution.isolation === "none" && (profile.isolation !== undefined || override?.isolation !== undefined)) {
    return false;
  }
  return [upstream.env, profile.env, override?.env].every((environment) =>
    Object.keys(environment ?? {}).every((key) => adapter.execution.allowedEnvironment.includes(key))
  );
}

function sameArguments(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}
