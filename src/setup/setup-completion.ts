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

export interface SetupCompletionInput {
  readonly surface: "cli" | "console";
  readonly verification: SetupCompletionVerification;
  readonly clientHandoff: SetupCompletionClientHandoff;
  /** A validated non-secret profile name for a later, explicitly requested retest. */
  readonly profile?: string;
  /** A published non-secret config path, rendered for a copyable CLI handoff. */
  readonly configPath?: string;
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
}

function displayConfigPath(configPath: string | undefined): string {
  const value = configPath ?? "CONFIG_PATH";
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
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
          ? { nextAction: `When ready, run 'miftah profile test --config ${displayConfigPath(input.configPath)} --profile ${input.profile}'.` }
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
          ? { nextAction: `Resolve the reported boundary, then run 'miftah profile test --config ${displayConfigPath(input.configPath)} --profile ${input.profile}'.` }
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
          `Next: generate a copy-only client snippet with 'miftah connection list --config ${displayConfigPath(input.configPath)} --client claude-desktop', review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file.`
      };
    case "available":
      return {
        state: "available",
        message:
          "Next: generate a copy-only client snippet below, review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
      };
  }
}

/** Creates shared, serializable completion copy without config bytes, paths, or credential material. */
export function createSetupCompletion(input: SetupCompletionInput): SetupCompletion {
  return {
    verification: verificationCompletion(input),
    clientHandoff: handoffCompletion(input)
  };
}
