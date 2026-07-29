import type { MiftahConfig } from "../config/types.js";

/**
 * A non-secret statement of what setup actually completed. It deliberately
 * describes only declared checks and manual client handoff; callers must not
 * use it to imply that an arbitrary upstream or MCP client was exercised.
 */
export type SetupCompletionVerification =
  | "not-declared"
  | "available"
  | "skipped"
  | "complete"
  | "incomplete"
  | "authorization-pending";

export type SetupCompletionClientHandoff = "shown" | "not-generated" | "available";
export type SetupEnvironmentState = "not-required" | "not-checked" | "missing" | "available";

export interface SetupEnvironmentReadiness {
  readonly state: SetupEnvironmentState;
  readonly requiredVariables: readonly string[];
  readonly missingVariables: readonly string[];
}

export interface SetupCompletionInput {
  readonly surface: "cli" | "console";
  readonly verification: SetupCompletionVerification;
  readonly clientHandoff: SetupCompletionClientHandoff;
  /** A validated non-secret profile name for a later, explicitly requested retest. */
  readonly profile?: string;
  /** A published non-secret config path, rendered for a copyable CLI handoff. */
  readonly configPath?: string;
  /** Names-only environment readiness; secret values never enter the completion model. */
  readonly environment?: SetupEnvironmentReadiness;
}

export interface SetupCompletion {
  readonly verification: {
    readonly state: SetupCompletionVerification;
    readonly message: string;
    readonly nextAction?: string;
  };
  readonly clientHandoff: {
    readonly state: SetupCompletionClientHandoff;
    readonly message: string;
  };
  readonly environment?: {
    readonly state: SetupEnvironmentState;
    readonly requiredVariables: readonly string[];
    readonly missingVariables: readonly string[];
    readonly message: string;
    readonly nextAction?: string;
  };
}

const environmentReference = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const environmentVariableName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function normalizedEnvironmentVariables(values: readonly string[]): string[] {
  return [...new Set(values)].filter((value) => environmentVariableName.test(value)).sort();
}

function collectEnvironmentReferences(target: Set<string>, values: Record<string, string> | undefined): void {
  if (values === undefined) return;
  for (const value of Object.values(values)) {
    for (const match of value.matchAll(environmentReference)) {
      const name = match[1];
      if (name !== undefined) target.add(name);
    }
  }
}

/**
 * Returns only validated names referenced from credential-bearing configuration
 * fields. Descriptions, paths, arguments, and other arbitrary strings are
 * deliberately excluded.
 */
export function environmentReferencesFromConfig(config: MiftahConfig): readonly string[] {
  const references = new Set<string>();
  const collectUpstream = (upstream: {
    readonly env?: Record<string, string>;
    readonly headers?: Record<string, string>;
  } | undefined): void => {
    collectEnvironmentReferences(references, upstream?.env);
    collectEnvironmentReferences(references, upstream?.headers);
  };

  collectUpstream(config.upstream);
  for (const upstream of Object.values(config.upstreams ?? {})) collectUpstream(upstream);
  for (const profile of Object.values(config.profiles)) {
    collectEnvironmentReferences(references, profile.env);
    collectEnvironmentReferences(references, profile.headers);
    for (const upstream of Object.values(profile.upstreams ?? {})) collectUpstream(upstream);
  }
  if (config.server?.http?.authToken !== undefined) {
    collectEnvironmentReferences(references, { authToken: config.server.http.authToken });
  }
  return normalizedEnvironmentVariables([...references]);
}

/**
 * Checks names only. Values are neither copied nor returned; `undefined` is the
 * same missing boundary used by environment expansion, while an empty value is
 * present and may still fail a separate provider-declared check.
 */
export function inspectSetupEnvironment(
  requiredVariables: readonly string[],
  environment: Readonly<Record<string, string | undefined>> | null = process.env
): SetupEnvironmentReadiness {
  const required = normalizedEnvironmentVariables(requiredVariables);
  if (required.length === 0) {
    return { state: "not-required", requiredVariables: [], missingVariables: [] };
  }
  if (environment === null) {
    return { state: "not-checked", requiredVariables: required, missingVariables: [] };
  }
  const missing = required.filter((name) => environment[name] === undefined);
  return {
    state: missing.length === 0 ? "available" : "missing",
    requiredVariables: required,
    missingVariables: missing
  };
}

function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function quoteForPowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Windows completion commands target PowerShell; both forms keep every dynamic value literal. */
function quoteShellArgument(value: string): string {
  return process.platform === "win32" ? quoteForPowerShell(value) : quoteForPosixShell(value);
}

function displayConfigPath(configPath: string | undefined): string {
  return quoteShellArgument(configPath ?? "CONFIG_PATH");
}

function displayProfile(profile: string): string {
  return quoteShellArgument(profile);
}

function commandInstruction(action: string, command: string): string {
  return `${action}${process.platform === "win32" ? " in PowerShell" : ""}: ${command}`;
}

function verificationCompletion(input: SetupCompletionInput): SetupCompletion["verification"] {
  switch (input.verification) {
    case "not-declared":
      return {
        state: "not-declared",
        message: "No provider-declared safe check is available for this configuration, so Miftah did not run or invent one."
      };
    case "available":
      return {
        state: "available",
        message: "A provider-declared read-only check is available, but it has not run yet."
      };
    case "skipped":
      return {
        state: "skipped",
        message: "The reviewed safe check was skipped. The configuration is saved but not yet verified.",
        ...(input.surface === "cli" && input.profile !== undefined
          ? {
              nextAction: `${commandInstruction(
                "When ready, run",
                `miftah profile test --config ${displayConfigPath(input.configPath)} --profile ${displayProfile(input.profile)}`
              )}.`
            }
          : {})
      };
    case "complete":
      return {
        state: "complete",
        message: "The reviewed safe check succeeded."
      };
    case "incomplete":
      return {
        state: "incomplete",
        message: "The reviewed safe check did not complete. The configuration remains saved.",
        ...(input.surface === "cli" && input.profile !== undefined
          ? {
              nextAction: `${commandInstruction(
                "Resolve the reported boundary, then run",
                `miftah profile test --config ${displayConfigPath(input.configPath)} --profile ${displayProfile(input.profile)}`
              )}.`
            }
          : {})
      };
    case "authorization-pending":
      return {
        state: "authorization-pending",
        message: "No browser authorization completed during setup. Connect later to begin the provider's authorization flow."
      };
  }
}

function handoffCompletion(input: SetupCompletionInput): SetupCompletion["clientHandoff"] {
  switch (input.clientHandoff) {
    case "shown":
      return {
        state: "shown",
        message:
          "Next: review the client JSON above, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      };
    case "not-generated":
      return {
        state: "not-generated",
        message:
          `${commandInstruction(
            "Next: generate a copy-only client snippet",
            `miftah connection list --config ${displayConfigPath(input.configPath)} --client ${quoteShellArgument("claude-desktop")}`
          )}; review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file.`
      };
    case "available":
      return {
        state: "available",
        message:
          "Next: generate a copy-only client snippet below, review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      };
  }
}

function environmentCompletion(
  readiness: SetupEnvironmentReadiness
): NonNullable<SetupCompletion["environment"]> {
  const requiredVariables = normalizedEnvironmentVariables(readiness.requiredVariables);
  const missingVariables = normalizedEnvironmentVariables(readiness.missingVariables)
    .filter((name) => requiredVariables.includes(name));
  const required = requiredVariables.join(", ");
  const missing = missingVariables.join(", ");
  switch (readiness.state) {
    case "not-required":
      return {
        state: "not-required",
        requiredVariables: [],
        missingVariables: [],
        message: "This configuration does not require an environment-backed secret."
      };
    case "not-checked":
      return {
        state: "not-checked",
        requiredVariables,
        missingVariables: [],
        message: `Not checked in this setup process: ${required}.`,
        nextAction:
          `Before restarting your MCP client, make sure it passes ${required} to the Miftah process it launches. The generated client JSON does not set or contain the secret.`
      };
    case "missing":
      return {
        state: "missing",
        requiredVariables,
        missingVariables,
        message: `Missing from this setup process: ${missing}.`,
        nextAction:
          `Set ${missing} in the environment inherited by the Miftah process your MCP client launches. The generated client JSON does not set or contain the secret.`
      };
    case "available":
      return {
        state: "available",
        requiredVariables,
        missingVariables: [],
        message: `Available to this setup process: ${required}.`,
        nextAction:
          `Make sure your MCP client passes ${required} to the Miftah process it launches. This does not verify the credential or provider.`
      };
  }
}

/** Creates shared, serializable completion copy without config bytes, paths, or credential material. */
export function createSetupCompletion(input: SetupCompletionInput): SetupCompletion {
  return {
    verification: verificationCompletion(input),
    clientHandoff: handoffCompletion(input),
    ...(input.environment === undefined ? {} : { environment: environmentCompletion(input.environment) })
  };
}
