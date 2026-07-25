import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  /**
   * A reviewed, non-secret account-profile shape the setup workflow may add
   * to an already trusted provider-adapter configuration. This deliberately
   * models only provider-owned credential files and private adapter state;
   * generic Miftah code never reads, copies, or manages the resulting cache.
   */
  readonly accountProvisioning?: {
    readonly credentialFile: {
      /** The non-secret environment key consumed by the upstream adapter. */
      readonly environment: string;
      /** Browser-visible label; it never exposes an existing path. */
      readonly label: string;
      readonly placeholder: string;
    };
    readonly stateDirectory: {
      /** The profile-scoped upstream-private state directory environment key. */
      readonly environment: string;
      /** Stable adapter-owned namespace below Miftah's local state root. */
      readonly namespace: string;
    };
    readonly defaultProfile: {
      readonly description: string;
      readonly policy: "readonly";
    };
  };
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
      accountProvisioning: {
        credentialFile: {
          environment: "GSC_OAUTH_CLIENT_SECRETS_FILE",
          label: "Google OAuth client-secrets file",
          placeholder: "/Users/you/gsc-client-secrets.json"
        },
        stateDirectory: {
          environment: "GSC_CONFIG_DIR",
          namespace: "gsc-oauth"
        },
        defaultProfile: {
          description: "Google Search Console account (OAuth owned by upstream)",
          policy: "readonly"
        }
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

export interface ProviderAdapterAccountProfileRequest {
  /** Configuration name remains a stable namespace for plan-only callers. */
  readonly configurationName: string;
  /** A resolved config path gives installed configurations a machine-local namespace. */
  readonly configurationPath?: string;
  readonly profile: string;
  readonly description?: string;
  readonly credentialFile: string;
}

/** Bounded, non-secret input failure for a provider-owned account profile. */
export class ProviderAdapterAccountProfileError extends Error {
  constructor() {
    super("Provider account setup requires an absolute literal credential-file path.");
    this.name = "ProviderAdapterAccountProfileError";
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function isLiteralAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    isAbsolute(value) &&
    !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/u.test(value) &&
    !hasControlCharacter(value)
  );
}

function requireCredentialFile(value: unknown): string {
  if (
    !isLiteralAbsolutePath(value)
  ) {
    throw new ProviderAdapterAccountProfileError();
  }
  return value;
}

function adapterStateDirectory(
  namespace: string,
  configurationName: string,
  configurationPath: string | undefined,
  profile: string
): string {
  const configurationIdentity = configurationPath === undefined
    ? configurationName
    : resolve(configurationPath);
  const configurationNamespace = createHash("sha256").update(configurationIdentity).digest("hex");
  return join(homedir(), ".config", "miftah", namespace, configurationNamespace, profile);
}

/**
 * Builds one reviewed profile from the adapter contract. It contains only a
 * credential-file path and an isolated adapter-state directory; no token or
 * provider cache is read or returned.
 */
export function buildProviderAdapterAccountProfile(
  adapter: ProviderAdapterDefinition,
  request: ProviderAdapterAccountProfileRequest
): ProfileConfig {
  const provisioning = adapter.accountProvisioning;
  if (provisioning === undefined) {
    throw new ProviderAdapterAccountProfileError();
  }
  const credentialFile = requireCredentialFile(request.credentialFile);
  return {
    description: request.description === undefined || request.description.length === 0
      ? provisioning.defaultProfile.description
      : request.description,
    env: {
      [provisioning.credentialFile.environment]: credentialFile,
      [provisioning.stateDirectory.environment]: adapterStateDirectory(
        provisioning.stateDirectory.namespace,
        request.configurationName,
        request.configurationPath,
        request.profile
      )
    },
    policy: provisioning.defaultProfile.policy
  };
}

export function getProviderAdapterForPreset(preset: string): ProviderAdapterDefinition | undefined {
  return Object.values(PROVIDER_ADAPTER_CATALOG.adapters).find((adapter) => adapter.preset === preset);
}

/**
 * Returns one adapter only when every effective profile/upstream target is
 * inside the same reviewed adapter envelope. Account lifecycle mutations must
 * not infer ownership from a partial or mixed configuration.
 */
export function getProviderAdapterForConfiguration(config: MiftahConfig): ProviderAdapterDefinition | undefined {
  const upstreamNames = config.upstreams === undefined
    ? config.upstream === undefined ? [] : ["default"]
    : Object.keys(config.upstreams);
  const targets = Object.keys(config.profiles).flatMap((profile) =>
    upstreamNames.map((upstream) => getProviderAdapterForProfileTarget(config, profile, upstream))
  );
  const adapter = targets[0];
  return adapter !== undefined && targets.length === Object.keys(config.profiles).length * upstreamNames.length &&
    targets.every((candidate) => candidate === adapter)
    ? adapter
    : undefined;
}

/**
 * Returns an adapter only when every existing profile has the reviewed
 * non-secret credential-file and unique private-state bindings required to
 * add another account safely. This deliberately does not inspect the state
 * directories themselves.
 */
export function getProviderAdapterForAccountProvisioning(config: MiftahConfig): ProviderAdapterDefinition | undefined {
  const adapter = getProviderAdapterForConfiguration(config);
  const provisioning = adapter?.accountProvisioning;
  if (provisioning === undefined) return undefined;
  const directories = new Set<string>();
  for (const profile of Object.values(config.profiles)) {
    // Account provisioning creates one root-profile binding. A named upstream
    // can supersede either binding at launch time, so do not infer account
    // isolation from the root profile when such an override exists.
    if (Object.values(profile.upstreams ?? {}).some((override) =>
      Object.hasOwn(override.env ?? {}, provisioning.credentialFile.environment) ||
      Object.hasOwn(override.env ?? {}, provisioning.stateDirectory.environment)
    )) {
      return undefined;
    }
    const credentialFile = profile.env?.[provisioning.credentialFile.environment];
    const stateDirectory = profile.env?.[provisioning.stateDirectory.environment];
    if (
      !isLiteralAbsolutePath(credentialFile) ||
      !isLiteralAbsolutePath(stateDirectory) ||
      stateDirectory !== resolve(stateDirectory) ||
      directories.has(resolve(stateDirectory))
    ) {
      return undefined;
    }
    directories.add(resolve(stateDirectory));
  }
  return adapter;
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
