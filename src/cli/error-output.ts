import { startupDiagnosticFromError, testProfileDiagnosticCommand } from "../upstream/startup-diagnostic.js";
import { commandInstruction } from "../utils/shell-command.js";

export interface UpstreamFailureCommandContext {
  readonly configPath: string;
  readonly profile: string;
}

function indent(value: string): string {
  return value.replace(/\n/gu, "\n  ");
}

/** Renders actionable details only when they came from Miftah's redacted startup boundary. */
export function formatUpstreamStartupFailure(error: unknown, context: UpstreamFailureCommandContext): string {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = startupDiagnosticFromError(error);
  if (diagnostic === undefined) return message;

  return [
    message,
    `Cause: ${indent(diagnostic.cause)}`,
    ...(diagnostic.exitCode === undefined ? [] : [`Exit code: ${diagnostic.exitCode}`]),
    ...(diagnostic.signal === undefined ? [] : [`Signal: ${diagnostic.signal}`]),
    ...(diagnostic.truncated ? ["Cause output was truncated."] : []),
    `Remediation: ${diagnostic.remediation}`,
    commandInstruction("Retry", testProfileDiagnosticCommand(context.configPath, context.profile))
  ].join("\n");
}
