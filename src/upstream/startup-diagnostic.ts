import { MiftahError, type MiftahErrorCode } from "../utils/errors.js";

export type UpstreamStartupDiagnosticKind = "process-exit" | "signal" | "timeout" | "initialization";

/** Secret-safe, bounded details explaining why an upstream could not initialize. */
export interface UpstreamStartupDiagnostic {
  readonly errorCode: MiftahErrorCode;
  readonly kind: UpstreamStartupDiagnosticKind;
  readonly cause: string;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly truncated: boolean;
  readonly remediation: string;
}

function isStartupDiagnostic(value: unknown): value is UpstreamStartupDiagnostic {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.errorCode === "string" &&
    ["process-exit", "signal", "timeout", "initialization"].includes(String(candidate.kind)) &&
    typeof candidate.cause === "string" &&
    typeof candidate.truncated === "boolean" &&
    typeof candidate.remediation === "string" &&
    (candidate.exitCode === undefined || typeof candidate.exitCode === "number") &&
    (candidate.signal === undefined || typeof candidate.signal === "string")
  );
}

/** Reads only the manager-produced safe startup diagnostic from a domain error. */
export function startupDiagnosticFromError(error: unknown): UpstreamStartupDiagnostic | undefined {
  if (!(error instanceof MiftahError)) return undefined;
  const diagnostic = error.details?.startupDiagnostic;
  return isStartupDiagnostic(diagnostic) ? diagnostic : undefined;
}

/** Reads the already-public profile identifier associated with a startup failure. */
export function startupFailureProfile(error: unknown): string | undefined {
  if (!(error instanceof MiftahError)) return undefined;
  return typeof error.details?.profile === "string" ? error.details.profile : undefined;
}

function quotedCliArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Renders the exact legacy readiness command used to diagnose an upstream start. */
export function testProfileDiagnosticCommand(configPath: string, profile: string): string {
  return `miftah test-profile --config ${quotedCliArgument(configPath)} --profile ${quotedCliArgument(profile)}`;
}
