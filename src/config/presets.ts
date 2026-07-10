import type { MiftahConfig, UpstreamConfig } from "./types.js";

/** Pinned GitHub MCP server image used by the GitHub preset. */
export const GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server:v1.1.0";

type SharedDefaults = Pick<MiftahConfig, "routing" | "security" | "process" | "audit" | "tooling">;
type PresetBuilder = (name: string) => MiftahConfig;

/** Builds fresh shared runtime defaults so generated configs never share mutable state. */
function buildSharedDefaults(): SharedDefaults {
  return {
    routing: { mode: "hybrid", fallback: "activeProfile", rules: [] },
    security: {
      allowPlaintextSecrets: false,
      redactSecrets: true,
      allowProfileSwitchingFromMcp: true,
      requireExplicitProfileForDestructive: true
    },
    process: { startMode: "lazy", cache: true, restartOnCrash: true, startupTimeoutMs: 30_000 },
    audit: {
      enabled: true,
      path: "~/.local/state/miftah/audit.jsonl",
      format: "jsonl",
      includeArguments: false,
      redact: true
    },
    tooling: { managementToolPrefix: "miftah_", collisionStrategy: "prefix-upstream" }
  };
}

/** Builds the common single-profile shape used by package-based presets. */
function buildStandardPreset(name: string, upstream: UpstreamConfig): MiftahConfig {
  return {
    version: "1",
    name,
    description: `${name} wrapped by Miftah`,
    defaultProfile: "default",
    upstream,
    profiles: {
      default: {
        description: "Default account",
        env: {}
      }
    },
    policies: undefined,
    ...buildSharedDefaults()
  };
}

/** Builds the generic starter preset for an unspecified MCP package. */
function buildGenericPreset(name: string): MiftahConfig {
  return buildStandardPreset(name, {
    transport: "stdio",
    command: "npx",
    args: ["-y", "your-mcp-server"]
  });
}

/** Builds the Sentry MCP package preset. */
function buildSentryPreset(name: string): MiftahConfig {
  return buildStandardPreset(name, {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@sentry/mcp-server"]
  });
}

/** Builds the multi-profile GitHub preset and its referenced policies. */
function buildGithubPreset(name: string): MiftahConfig {
  return {
    version: "1",
    name,
    description: "GitHub MCP wrapped by Miftah",
    defaultProfile: "work",
    upstream: {
      transport: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", GITHUB_MCP_IMAGE]
    },
    profiles: {
      work: {
        description: "Work GitHub account",
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_WORK_TOKEN}" },
        policy: "safe-write"
      },
      personal: {
        description: "Personal GitHub account",
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_TOKEN}" },
        policy: "readonly"
      }
    },
    policies: {
      readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] },
      "safe-write": { allowRisk: ["read", "write"], denyRisk: ["destructive"], requireConfirmation: ["write"] }
    },
    ...buildSharedDefaults()
  };
}

const presetBuilders = new Map<string, PresetBuilder>([
  ["generic", buildGenericPreset],
  ["sentry", buildSentryPreset],
  ["github", buildGithubPreset]
]);

/** Builds a named configuration preset, falling back to the generic template. */
export function presetConfig(name: string, preset = "generic"): MiftahConfig {
  return (presetBuilders.get(preset) ?? buildGenericPreset)(name);
}
