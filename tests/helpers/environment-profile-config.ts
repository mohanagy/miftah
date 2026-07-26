/**
 * A direct-executable local STDIO configuration used by static credential
 * account tests. `process.execPath` is an absolute `.exe` on Windows, unlike
 * the Sentry preset's intentional `npx` command-shell boundary.
 */
export function environmentProfileConfig(name = "environment-account") {
  return {
    version: "3" as const,
    name,
    defaultProfile: "default",
    upstream: {
      transport: "stdio" as const,
      command: process.execPath,
      args: ["provider.mjs"]
    },
    profiles: {
      default: {
        description: "Default static account",
        policy: "readonly",
        env: { STATIC_ACCESS_TOKEN: "${STATIC_DEFAULT_ACCESS_TOKEN}" }
      }
    },
    policies: {
      readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] }
    }
  };
}
