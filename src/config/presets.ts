import type { MiftahConfig } from "./types.js";

export const GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server:v1.1.0";

export function presetConfig(name: string, preset = "generic"): MiftahConfig {
  const upstream =
    preset === "github"
      ? {
          transport: "stdio" as const,
          command: "docker",
          args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", GITHUB_MCP_IMAGE]
        }
      : preset === "sentry"
        ? { transport: "stdio" as const, command: "npx", args: ["-y", "@sentry/mcp-server"] }
        : { transport: "stdio" as const, command: "npx", args: ["-y", "your-mcp-server"] };
  const profiles: MiftahConfig["profiles"] =
    preset === "github"
      ? {
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
        }
      : {
          default: {
            description: "Default account",
            env: {}
          }
        };
  return {
    version: "1",
    name,
    description: preset === "github" ? "GitHub MCP wrapped by Miftah" : `${name} wrapped by Miftah`,
    defaultProfile: preset === "github" ? "work" : "default",
    upstream,
    profiles,
    policies:
      preset === "github"
        ? {
            readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] },
            "safe-write": { allowRisk: ["read", "write"], denyRisk: ["destructive"], requireConfirmation: ["write"] }
          }
        : undefined,
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
