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
type NonEmptyEnvironmentVariables = readonly [string, ...string[]];
type NoEnvironmentVariables = readonly [];

export type SetupEnvironmentReadiness =
  | {
      readonly state: "not-required";
      readonly requiredVariables: NoEnvironmentVariables;
      readonly missingVariables: NoEnvironmentVariables;
    }
  | {
      readonly state: "not-checked";
      readonly reason: "environment-unavailable" | "configured-env-files";
      readonly requiredVariables: NonEmptyEnvironmentVariables;
      readonly missingVariables: NoEnvironmentVariables;
    }
  | {
      readonly state: "missing";
      readonly requiredVariables: NonEmptyEnvironmentVariables;
      readonly missingVariables: NonEmptyEnvironmentVariables;
    }
  | {
      readonly state: "available";
      readonly requiredVariables: NonEmptyEnvironmentVariables;
      readonly missingVariables: NoEnvironmentVariables;
    };

export type SetupEnvironmentCompletion = SetupEnvironmentReadiness & {
  readonly message: string;
  readonly nextAction?: string;
};

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
  readonly environment?: SetupEnvironmentCompletion;
}

const environmentReference = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const canonicalEnvironmentReference = /^secretref:(?:env|dotenv):\/\/([A-Za-z_][A-Za-z0-9_]*)$/u;
const environmentVariableName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function normalizedEnvironmentVariables(values: readonly string[]): string[] {
  if (values.some((value) => typeof value !== "string" || !environmentVariableName.test(value))) {
    throw new TypeError("Environment readiness contains an invalid environment variable name.");
  }
  return [...new Set(values)].sort();
}

function nonEmptyEnvironmentVariables(
  values: readonly string[],
  message: string
): NonEmptyEnvironmentVariables {
  if (values.length === 0) throw new TypeError(message);
  return values as NonEmptyEnvironmentVariables;
}

function collectEnvironmentReferences(target: Set<string>, values: Record<string, string> | undefined): void {
  if (values === undefined) return;
  for (const value of Object.values(values)) {
    const canonical = value.match(canonicalEnvironmentReference)?.[1];
    if (canonical !== undefined) target.add(canonical);
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
    return {
      state: "not-checked",
      reason: "environment-unavailable",
      requiredVariables: nonEmptyEnvironmentVariables(required, "not-checked state requires environment variables"),
      missingVariables: []
    };
  }
  const missing = required.filter((name) => environment[name] === undefined || environment[name] === "");
  const requiredNames = nonEmptyEnvironmentVariables(required, "environment readiness requires environment variables");
  if (missing.length > 0) {
    return {
      state: "missing",
      requiredVariables: requiredNames,
      missingVariables: nonEmptyEnvironmentVariables(
        missing,
        "missing state requires at least one missing environment variable"
      )
    };
  }
  return { state: "available", requiredVariables: requiredNames, missingVariables: [] };
}

/** Checks process availability without opening configured environment files or reading their values. */
export function inspectConfigEnvironment(
  config: MiftahConfig,
  environment: Readonly<Record<string, string | undefined>> | null = process.env
): SetupEnvironmentReadiness {
  const readiness = inspectSetupEnvironment(environmentReferencesFromConfig(config), environment);
  if (
    readiness.state === "missing" &&
    (config.secrets?.envFiles?.length ?? 0) > 0
  ) {
    return {
      state: "not-checked",
      reason: "configured-env-files",
      requiredVariables: readiness.requiredVariables,
      missingVariables: []
    };
  }
  return readiness;
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
): SetupEnvironmentCompletion {
  const requiredVariables = normalizedEnvironmentVariables(readiness.requiredVariables);
  const missingVariables = normalizedEnvironmentVariables(readiness.missingVariables);
  const required = requiredVariables.join(", ");
  const missing = missingVariables.join(", ");
  switch (readiness.state) {
    case "not-required": {
      if (requiredVariables.length > 0 || missingVariables.length > 0) {
        throw new TypeError("not-required state cannot include environment variables");
      }
      return {
        state: "not-required",
        requiredVariables: [],
        missingVariables: [],
        message: "This configuration does not require an environment-backed secret."
      };
    }
    case "not-checked": {
      const requiredNames = nonEmptyEnvironmentVariables(
        requiredVariables,
        "not-checked state requires at least one environment variable"
      );
      if (missingVariables.length > 0) {
        throw new TypeError("not-checked state cannot include missing environment variables");
      }
      const configuredFiles = readiness.reason === "configured-env-files";
      return {
        state: "not-checked",
        reason: readiness.reason,
        requiredVariables: requiredNames,
        missingVariables: [],
        message: configuredFiles
          ? `Availability was not fully checked; configured env files were not opened: ${required}.`
          : `Not checked in this setup process: ${required}.`,
        nextAction: configuredFiles
          ? `Before restarting your MCP client, make sure the Miftah process it launches can resolve ${required} from its inherited environment or configured secrets.envFiles. The generated client JSON does not set or contain the secret.`
          : `Before restarting your MCP client, make sure it passes ${required} to the Miftah process it launches. The generated client JSON does not set or contain the secret.`
      };
    }
    case "missing": {
      const requiredNames = nonEmptyEnvironmentVariables(
        requiredVariables,
        "missing state requires environment variables"
      );
      const missingNames = nonEmptyEnvironmentVariables(
        missingVariables,
        "missing state requires at least one missing environment variable"
      );
      if (missingNames.some((name) => !requiredNames.includes(name))) {
        throw new TypeError("missing environment variables must be required environment variables");
      }
      return {
        state: "missing",
        requiredVariables: requiredNames,
        missingVariables: missingNames,
        message: `Missing from this setup process: ${missing}.`,
        nextAction:
          `Set ${missing} in the environment inherited by the Miftah process your MCP client launches. The generated client JSON does not set or contain the secret.`
      };
    }
    case "available": {
      const requiredNames = nonEmptyEnvironmentVariables(
        requiredVariables,
        "available state requires at least one environment variable"
      );
      if (missingVariables.length > 0) {
        throw new TypeError("available state cannot include missing environment variables");
      }
      return {
        state: "available",
        requiredVariables: requiredNames,
        missingVariables: [],
        message: `Available to this setup process: ${required}.`,
        nextAction:
          `Make sure your MCP client passes ${required} to the Miftah process it launches. This does not verify the credential or provider.`
      };
    }
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
