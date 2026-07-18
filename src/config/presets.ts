import type { MiftahConfig, ProfileConfig } from "./types.js";
import { CURRENT_CONFIG_VERSION } from "./versions.js";

/** Pinned GitHub MCP server image used by the GitHub preset. */
export const GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server:v1.5.0";

const GENERIC_MCP_PACKAGE = "@modelcontextprotocol/server-everything@2026.7.4";
const SENTRY_MCP_PACKAGE = "@sentry/mcp-server@0.36.0";
const environmentVariableName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const allowedHeaderPrefixes = new Set(["Bearer ", "Sentry "]);
const npmPackageWithVersion = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@(.+)$/u;
const exactSemver =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|[0-9A-Za-z]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9][0-9]*)|[0-9A-Za-z]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const canonicalDigestImage =
  /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?\/)?(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)*[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?@sha256:[A-Fa-f0-9]{64}$/u;

type CurrentMiftahConfig = Extract<MiftahConfig, { version: "2" }>;
type CurrentUpstreamConfig = NonNullable<CurrentMiftahConfig["upstream"]>;
type SharedDefaults = Pick<CurrentMiftahConfig, "routing" | "security" | "secrets" | "process" | "audit" | "tooling">;

export interface PresetBuildOptions {
  credentialEnv?: string;
  npmPackage?: string;
  dockerImage?: string;
  url?: string;
  headerName?: string;
  headerPrefix?: string;
}

type PresetOptionRequirement = "required" | "optional" | "optional-with-credentialEnv" | "provider-managed";
type PresetRequirements = Readonly<Partial<Record<string, PresetOptionRequirement>>>;

/** An ordinary input error that CLI code can translate to its own usage error. */
export class PresetCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetCatalogError";
  }
}

function catalogError(message: string): never {
  throw new PresetCatalogError(message);
}

function environmentReference(name: unknown): string {
  if (typeof name !== "string" || !environmentVariableName.test(name)) {
    catalogError(`Invalid credential environment variable name '${name}'.`);
  }
  return `\${${name}}`;
}

function validateCredentialEnv(credentialEnv: unknown): void {
  if (credentialEnv === undefined) return;
  if (typeof credentialEnv !== "string") {
    catalogError("Preset option 'credentialEnv' must be a string when supplied.");
  }
  if (!environmentVariableName.test(credentialEnv)) {
    catalogError(`Invalid credential environment variable name '${credentialEnv}'.`);
  }
}

/** Builds fresh runtime defaults so generated configs never share mutable state. */
function buildSharedDefaults(options: { multiProfile?: boolean } = {}): SharedDefaults {
  return {
    routing: { mode: "hybrid", fallback: "activeProfile", rules: [] },
    security: {
      allowProfileSwitchingFromMcp: true,
      requireExplicitProfileForDestructive: true,
      ...(options.multiProfile
        ? {
            requireProfileSwitchConfirmation: true,
            requireExplicitSelectionForDestructive: true
          }
        : {})
    },
    secrets: { allowPlaintextSecrets: false },
    process: { startupTimeoutMs: 30_000 },
    audit: {
      enabled: true,
      path: "~/.local/state/miftah/audit.jsonl",
      format: "jsonl",
      includeArguments: false,
      failureMode: "fail-closed"
    },
    tooling: { collisionStrategy: "prefix-upstream" }
  };
}

function buildReadonlyPolicies(): NonNullable<CurrentMiftahConfig["policies"]> {
  return {
    readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] }
  };
}

function buildCredentialProfile(credentialEnv?: string): ProfileConfig {
  return {
    description: "Default account",
    env: credentialEnv === undefined ? {} : { [credentialEnv]: environmentReference(credentialEnv) }
  };
}

/** Builds the common single-profile shape used by generic presets. */
function buildStandardPreset(
  name: string,
  upstream: CurrentUpstreamConfig,
  credentialEnv?: string
): CurrentMiftahConfig {
  return {
    version: CURRENT_CONFIG_VERSION,
    name,
    description: `${name} wrapped by Miftah`,
    defaultProfile: "default",
    upstream,
    profiles: {
      default: buildCredentialProfile(credentialEnv)
    },
    ...buildSharedDefaults()
  };
}

/** Builds the generic reference MCP server preset. */
function buildGenericPreset(name: string, options: PresetBuildOptions): MiftahConfig {
  // npm registry metadata for this package does not declare an upstream Node engine floor.
  return buildStandardPreset(
    name,
    {
      transport: "stdio",
      command: "npx",
      args: ["--yes", GENERIC_MCP_PACKAGE, "stdio"]
    },
    options.credentialEnv
  );
}

/** Builds the Sentry MCP package preset. */
function buildSentryPreset(name: string): MiftahConfig {
  const config = buildStandardPreset(name, {
    transport: "stdio",
    command: "npx",
    args: ["--yes", SENTRY_MCP_PACKAGE, "--skills=inspect"]
  });
  config.profiles.default = {
    description: "Default account",
    env: { SENTRY_ACCESS_TOKEN: "${SENTRY_ACCESS_TOKEN}" },
    policy: "readonly"
  };
  config.policies = buildReadonlyPolicies();
  return config;
}

/** Builds the multi-profile GitHub preset and its referenced policies. */
function buildGithubPreset(name: string): MiftahConfig {
  return {
    version: CURRENT_CONFIG_VERSION,
    name,
    description: "GitHub MCP wrapped by Miftah",
    defaultProfile: "work",
    upstream: {
      transport: "stdio",
      command: "docker",
      args: [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        GITHUB_MCP_IMAGE,
        "stdio",
        "--read-only",
        "--toolsets=repos,issues,pull_requests"
      ]
    },
    profiles: {
      work: {
        description: "Work GitHub account",
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_WORK_TOKEN}" },
        policy: "readonly"
      },
      personal: {
        description: "Personal GitHub account",
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_TOKEN}" },
        policy: "readonly"
      }
    },
    policies: buildReadonlyPolicies(),
    ...buildSharedDefaults({ multiProfile: true })
  };
}

function requireExactNpmPackage(value: unknown): string {
  if (typeof value !== "string") {
    catalogError("Preset option 'npmPackage' must be a string.");
  }
  const version = npmPackageWithVersion.exec(value)?.[1];
  if (!value || version === undefined || !exactSemver.test(version)) {
    catalogError("Preset 'generic-npx' requires an exact npm package semver spec such as '@scope/server@1.2.3'.");
  }
  return value;
}

function buildGenericNpxPreset(name: string, options: PresetBuildOptions): MiftahConfig {
  return buildStandardPreset(
    name,
    {
      transport: "stdio",
      command: "npx",
      args: ["--yes", requireExactNpmPackage(options.npmPackage)]
    },
    options.credentialEnv
  );
}

function requireCanonicalDigestImage(value: unknown): string {
  if (typeof value !== "string") {
    catalogError("Preset option 'dockerImage' must be a string.");
  }
  if (!value || !canonicalDigestImage.test(value)) {
    catalogError(
      "Preset 'generic-docker' requires a canonical image reference with an @sha256: digest containing 64 hexadecimal characters."
    );
  }
  return value;
}

function buildGenericDockerPreset(name: string, options: PresetBuildOptions): MiftahConfig {
  const credentialArgs = options.credentialEnv === undefined ? [] : ["-e", options.credentialEnv];
  return buildStandardPreset(
    name,
    {
      transport: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", ...credentialArgs, requireCanonicalDigestImage(options.dockerImage), "stdio"]
    },
    options.credentialEnv
  );
}

function requireHttpsUrl(value: unknown): string {
  if (value === undefined) {
    catalogError("Preset 'streamable-http' requires an HTTPS URL.");
  }
  if (typeof value !== "string") {
    catalogError("Preset option 'url' must be a string.");
  }
  if (!value) {
    catalogError("Preset 'streamable-http' requires an HTTPS URL.");
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      catalogError("Preset 'streamable-http' requires an HTTPS URL without userinfo, query, or fragment.");
    }
  } catch (error) {
    if (error instanceof PresetCatalogError) throw error;
    catalogError("Preset 'streamable-http' requires a valid HTTPS URL without userinfo, query, or fragment.");
  }
  return value;
}

function buildCredentialHeaders(options: PresetBuildOptions): Record<string, string> | undefined {
  const hasHeaderName = options.headerName !== undefined;
  const hasHeaderPrefix = options.headerPrefix !== undefined;
  if (!hasHeaderName && !hasHeaderPrefix && options.credentialEnv === undefined) return undefined;

  if (options.credentialEnv === undefined || options.headerName === undefined) {
    catalogError("Streamable HTTP credentials require credentialEnv and headerName together.");
  }
  if (typeof options.headerName !== "string") {
    catalogError("Preset option 'headerName' must be a string when supplied.");
  }
  if (!headerName.test(options.headerName)) {
    catalogError(`Invalid HTTP header name '${options.headerName}'.`);
  }
  const headerPrefix = options.headerPrefix === undefined ? "" : options.headerPrefix;
  if (typeof headerPrefix !== "string") {
    catalogError("Preset option 'headerPrefix' must be a string when supplied.");
  }
  if (headerPrefix !== "" && !allowedHeaderPrefixes.has(headerPrefix)) {
    catalogError("HTTP header prefix must be empty, 'Bearer ', or 'Sentry '.");
  }

  return { [options.headerName]: `${headerPrefix}${environmentReference(options.credentialEnv)}` };
}

function buildStreamableHttpPreset(name: string, options: PresetBuildOptions): MiftahConfig {
  const headers = buildCredentialHeaders(options);
  return buildStandardPreset(
    name,
    {
      transport: "streamable-http",
      url: requireHttpsUrl(options.url),
      ...(headers ? { headers } : {})
    },
    undefined
  );
}

/**
 * Versioned internal catalog for strict preset creation. Requirements define which
 * caller-supplied inputs each builder may receive.
 */
export const PRESET_CATALOG = {
  version: "1",
  presets: {
    generic: {
      requirements: { credentialEnv: "optional" },
      build: buildGenericPreset
    },
    github: {
      requirements: { credentialEnv: "provider-managed" },
      build: buildGithubPreset
    },
    sentry: {
      requirements: { credentialEnv: "provider-managed" },
      build: buildSentryPreset
    },
    "generic-npx": {
      requirements: { npmPackage: "required", credentialEnv: "optional" },
      build: buildGenericNpxPreset
    },
    "generic-docker": {
      requirements: { dockerImage: "required", credentialEnv: "optional" },
      build: buildGenericDockerPreset
    },
    "streamable-http": {
      requirements: {
        url: "required",
        credentialEnv: "optional",
        headerName: "optional-with-credentialEnv",
        headerPrefix: "optional-with-credentialEnv"
      },
      build: buildStreamableHttpPreset
    }
  }
} as const satisfies {
  readonly version: string;
  readonly presets: Record<
    string,
    {
      readonly requirements: PresetRequirements;
      readonly build: (name: string, options: PresetBuildOptions) => MiftahConfig;
    }
  >;
};

export type PresetCatalogName = keyof typeof PRESET_CATALOG.presets;

function validatePresetOptions(
  preset: string,
  requirements: PresetRequirements,
  options: PresetBuildOptions
): void {
  for (const [option, value] of Object.entries(options)) {
    if (value === undefined) continue;
    const requirement = requirements[option];
    if (requirement === undefined || requirement === "provider-managed") {
      catalogError(`Preset '${preset}' does not support option '${option}'.`);
    }
  }
  validateCredentialEnv(options.credentialEnv);
}

/** Builds a catalog preset strictly, rejecting unknown names instead of falling back. */
export function buildPresetConfig(name: string, preset: string, options: PresetBuildOptions = {}): MiftahConfig {
  if (!Object.hasOwn(PRESET_CATALOG.presets, preset)) {
    catalogError(`Unknown preset '${preset}'. Supported presets: ${Object.keys(PRESET_CATALOG.presets).join(", ")}.`);
  }
  const definition = PRESET_CATALOG.presets[preset as PresetCatalogName];
  validatePresetOptions(preset, definition.requirements, options);
  return definition.build(name, options);
}

/** Builds a named legacy configuration preset, retaining its generic fallback behavior. */
export function presetConfig(name: string, preset = "generic"): MiftahConfig {
  if (preset === "generic" || preset === "github" || preset === "sentry") {
    return buildPresetConfig(name, preset);
  }
  return buildPresetConfig(name, "generic");
}
