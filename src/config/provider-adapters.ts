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

export interface ProviderAdapterOperation {
  readonly owner: ProviderAdapterOwner;
  readonly mechanism: "native" | "mcp-tool" | "provider-console" | "operator";
  readonly name?: string;
}

export interface ProviderAdapterDefinition {
  readonly displayName: string;
  readonly preset: string;
  readonly launch: {
    readonly transport: "stdio";
    readonly command: string;
    readonly args: readonly string[];
    readonly prerequisites: readonly string[];
  };
  readonly authentication: ProviderAuthenticationContract;
  readonly lifecycle: {
    readonly health: ProviderAdapterOperation;
    readonly reauth: ProviderAdapterOperation;
    readonly disconnect: ProviderAdapterOperation;
  };
  readonly identity: {
    readonly evidence: "verified-probe" | "upstream-reported" | "unavailable";
    readonly assurance: "verified" | "informational" | "none";
  };
  readonly diagnostics: {
    readonly mode: "metadata-only";
    readonly tokenCacheAccess: "forbidden";
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
