import type { MiftahConfig } from "./types.js";

export function presetConfig(name: string, preset = "generic"): MiftahConfig {
  const upstream =
    preset === "github"
      ? { transport: "stdio" as const, command: "docker", args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"] }
      : preset === "sentry"
        ? { transport: "stdio" as const, command: "npx", args: ["-y", "@sentry/mcp-server"] }
        : { transport: "stdio" as const, command: "npx", args: ["-y", "your-mcp-server"] };
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
