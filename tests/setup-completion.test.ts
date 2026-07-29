import { describe, expect, it } from "vitest";
import {
  createSetupCompletion,
  environmentReferencesFromConfig,
  inspectConfigEnvironment,
  inspectSetupEnvironment
} from "../src/setup/setup-completion.js";

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("process.platform descriptor was unavailable");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return callback();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

describe("setup completion", () => {
  it("reports a missing generated environment reference before client handoff without exposing a value", () => {
    const environment = inspectSetupEnvironment(["SENTRY_ACCESS_TOKEN"], {});
    const completion = createSetupCompletion({
      surface: "cli",
      verification: "not-declared",
      clientHandoff: "shown",
      environment
    });

    expect(completion.environment).toEqual({
      state: "missing",
      requiredVariables: ["SENTRY_ACCESS_TOKEN"],
      missingVariables: ["SENTRY_ACCESS_TOKEN"],
      message: "Missing from this setup process: SENTRY_ACCESS_TOKEN.",
      nextAction:
        "Set SENTRY_ACCESS_TOKEN in the environment inherited by the Miftah process your MCP client launches. The generated client JSON does not set or contain the secret."
    });
    expect(JSON.stringify(completion)).not.toContain("provider-secret-value");
  });

  it("keeps environment availability distinct from provider verification and client inheritance", () => {
    const environment = inspectSetupEnvironment(
      ["SENTRY_ACCESS_TOKEN"],
      { SENTRY_ACCESS_TOKEN: "provider-secret-value" }
    );
    const completion = createSetupCompletion({
      surface: "console",
      verification: "not-declared",
      clientHandoff: "available",
      environment
    });

    expect(completion.environment).toEqual({
      state: "available",
      requiredVariables: ["SENTRY_ACCESS_TOKEN"],
      missingVariables: [],
      message: "Available to this setup process: SENTRY_ACCESS_TOKEN.",
      nextAction:
        "Make sure your MCP client passes SENTRY_ACCESS_TOKEN to the Miftah process it launches. This does not verify the credential or provider."
    });
    expect(JSON.stringify(completion)).not.toContain("provider-secret-value");
    expect(completion.verification.state).toBe("not-declared");
  });

  it("represents not checked and not required environment readiness separately", () => {
    expect(inspectSetupEnvironment(["SENTRY_ACCESS_TOKEN"], null)).toEqual({
      state: "not-checked",
      reason: "environment-unavailable",
      requiredVariables: ["SENTRY_ACCESS_TOKEN"],
      missingVariables: []
    });
    expect(inspectSetupEnvironment([], {})).toEqual({
      state: "not-required",
      requiredVariables: [],
      missingVariables: []
    });
  });

  it("extracts only validated environment references from credential-bearing config fields", () => {
    expect(environmentReferencesFromConfig({
      version: "3",
      name: "sentry",
      description: "Do not treat ${DESCRIPTION_ONLY} as a credential reference.",
      defaultProfile: "work",
      upstream: {
        transport: "streamable-http",
        url: "https://mcp.example.test",
        headers: {
          Authorization: "Bearer ${UPSTREAM_TOKEN}",
          "X-Canonical": "secretref:env://CANONICAL_TOKEN"
        }
      },
      profiles: {
        work: {
          env: { SENTRY_ACCESS_TOKEN: "${SENTRY_ACCESS_TOKEN}" },
          headers: { "X-Account": "${ACCOUNT_TOKEN}" },
          upstreams: {
            default: {
              env: {
                EXTRA_TOKEN: "prefix-${EXTRA_TOKEN}",
                ENV_FILE_TOKEN: "secretref:dotenv://ENV_FILE_TOKEN"
              },
              headers: { "X-Literal": "literal" }
            }
          }
        }
      }
    })).toEqual([
      "ACCOUNT_TOKEN",
      "CANONICAL_TOKEN",
      "ENV_FILE_TOKEN",
      "EXTRA_TOKEN",
      "SENTRY_ACCESS_TOKEN",
      "UPSTREAM_TOKEN"
    ]);
  });

  it("does not call an environment-file-backed reference missing until configured files are resolved", () => {
    expect(inspectConfigEnvironment({
      version: "3",
      name: "sentry",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node" },
      profiles: {
        default: {
          env: {
            ACCOUNT_ID: "secretref:env://ACCOUNT_ID",
            SENTRY_ACCESS_TOKEN: "secretref:env://SENTRY_ACCESS_TOKEN"
          }
        }
      },
      secrets: { envFiles: ["/Users/example/.config/miftah/sentry.env"] }
    }, { ACCOUNT_ID: "account-id" })).toEqual({
      state: "not-checked",
      reason: "configured-env-files",
      requiredVariables: ["ACCOUNT_ID", "SENTRY_ACCESS_TOKEN"],
      missingVariables: []
    });
  });

  it("treats an empty credential environment value as missing", () => {
    expect(inspectSetupEnvironment(
      ["SENTRY_ACCESS_TOKEN"],
      { SENTRY_ACCESS_TOKEN: "" }
    )).toEqual({
      state: "missing",
      requiredVariables: ["SENTRY_ACCESS_TOKEN"],
      missingVariables: ["SENTRY_ACCESS_TOKEN"]
    });
  });

  it("rejects contradictory environment readiness objects at the completion boundary", () => {
    const base = {
      surface: "cli" as const,
      verification: "not-declared" as const,
      clientHandoff: "shown" as const
    };
    expect(() => createSetupCompletion({
      ...base,
      environment: {
        state: "missing",
        requiredVariables: ["SENTRY_ACCESS_TOKEN"],
        missingVariables: []
      } as never
    })).toThrow("missing state requires at least one missing environment variable");
    expect(() => createSetupCompletion({
      ...base,
      environment: {
        state: "available",
        requiredVariables: ["SENTRY_ACCESS_TOKEN"],
        missingVariables: ["SENTRY_ACCESS_TOKEN"]
      } as never
    })).toThrow("available state cannot include missing environment variables");
    expect(() => createSetupCompletion({
      ...base,
      environment: {
        state: "missing",
        requiredVariables: ["SENTRY_ACCESS_TOKEN"],
        missingVariables: ["UNRELATED_TOKEN"]
      } as never
    })).toThrow("missing environment variables must be required environment variables");
  });

  it("gives an unreviewed generic setup a truthful manual handoff without inventing a probe", () => {
    expect(createSetupCompletion({
      surface: "cli",
      verification: "not-declared",
      clientHandoff: "not-generated",
      configPath: "/Users/example/.config/miftah/support.json"
    })).toEqual({
      verification: {
        state: "not-declared",
        message: "No provider-declared safe check is available for this configuration, so Miftah did not run or invent one."
      },
      clientHandoff: {
        state: "not-generated",
        message:
          "Next: generate a copy-only client snippet: miftah connection list --config '/Users/example/.config/miftah/support.json' --client 'claude-desktop'; review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      }
    });
  });

  it("gives a skipped reviewed provider profile an explicit later retest without claiming success", () => {
    expect(createSetupCompletion({
      surface: "cli",
      verification: "skipped",
      clientHandoff: "shown",
      profile: "google-work",
      configPath: "/Users/example/.config/miftah/gsc.json"
    })).toEqual({
      verification: {
        state: "skipped",
        message: "The reviewed safe check was skipped. The configuration is saved but not yet verified.",
        nextAction: "When ready, run: miftah profile test --config '/Users/example/.config/miftah/gsc.json' --profile 'google-work'."
      },
      clientHandoff: {
        state: "shown",
        message:
          "Next: review the client JSON above, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      }
    });
  });

  it("keeps Console client adoption explicitly manual while exposing a reviewed check when one is available", () => {
    expect(createSetupCompletion({
      surface: "console",
      verification: "available",
      clientHandoff: "available"
    })).toEqual({
      verification: {
        state: "available",
        message: "A provider-declared read-only check is available, but it has not run yet."
      },
      clientHandoff: {
        state: "available",
        message:
          "Next: generate a copy-only client snippet below, review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      }
    });
  });

  it("does not deny declared OAuth metadata discovery while browser authorization remains pending", () => {
    expect(createSetupCompletion({
      surface: "console",
      verification: "authorization-pending",
      clientHandoff: "available"
    }).verification).toEqual({
      state: "authorization-pending",
      message: "No browser authorization completed during setup. Connect later to begin the provider's authorization flow."
    });
  });

  it("quotes a published CLI config path when it contains whitespace", () => {
    expect(createSetupCompletion({
      surface: "cli",
      verification: "not-declared",
      clientHandoff: "not-generated",
      configPath: "/Users/example/Miftah configs/support.json"
    }).clientHandoff.message).toContain(
      "miftah connection list --config '/Users/example/Miftah configs/support.json' --client 'claude-desktop'"
    );
  });

  it("serializes POSIX config paths and profiles as literal shell arguments", () => {
    expect(createSetupCompletion({
      surface: "cli",
      verification: "skipped",
      clientHandoff: "not-generated",
      configPath: "/Users/example/miftah $HOME/$(whoami).json",
      profile: "work'$(not-a-command)"
    })).toMatchObject({
      verification: {
        nextAction:
          "When ready, run: miftah profile test --config '/Users/example/miftah $HOME/$(whoami).json' --profile 'work'\"'\"'$(not-a-command)'."
      },
      clientHandoff: {
        message:
          "Next: generate a copy-only client snippet: miftah connection list --config '/Users/example/miftah $HOME/$(whoami).json' --client 'claude-desktop'; review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      }
    });
  });

  it("serializes Windows config paths and profiles for PowerShell without expanding them", () => {
    const completion = withPlatform("win32", () => createSetupCompletion({
      surface: "cli",
      verification: "incomplete",
      clientHandoff: "not-generated",
      configPath: "C:\\Miftah $env:USER $(whoami).json",
      profile: "work'$(not-a-command)"
    }));

    expect(completion).toMatchObject({
      verification: {
        state: "incomplete",
        nextAction:
          "Resolve the reported boundary, then run in PowerShell: miftah profile test --config 'C:\\Miftah $env:USER $(whoami).json' --profile 'work''$(not-a-command)'."
      },
      clientHandoff: {
        message:
          "Next: generate a copy-only client snippet in PowerShell: miftah connection list --config 'C:\\Miftah $env:USER $(whoami).json' --client 'claude-desktop'; review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      }
    });
  });

  it("keeps a completed reviewed check distinct from an incomplete one", () => {
    expect(createSetupCompletion({
      surface: "cli",
      verification: "complete",
      clientHandoff: "shown"
    })).toEqual({
      verification: {
        state: "complete",
        message: "The reviewed safe check succeeded."
      },
      clientHandoff: {
        state: "shown",
        message:
          "Next: review the client JSON above, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      }
    });

    expect(createSetupCompletion({
      surface: "cli",
      verification: "incomplete",
      clientHandoff: "shown",
      configPath: "/Users/example/.config/miftah/gsc.json",
      profile: "google-work"
    })).toEqual({
      verification: {
        state: "incomplete",
        message: "The reviewed safe check did not complete. The configuration remains saved.",
        nextAction:
          "Resolve the reported boundary, then run: miftah profile test --config '/Users/example/.config/miftah/gsc.json' --profile 'google-work'."
      },
      clientHandoff: {
        state: "shown",
        message:
          "Next: review the client JSON above, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      }
    });
  });
});
