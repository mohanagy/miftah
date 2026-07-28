import { runProfileReadiness, type ProfileReadinessReport } from "../setup/profile-readiness.js";

export interface ProfileReadinessCommandOptions {
  readonly configPath: string;
  readonly profile: string;
  readonly upstream?: string;
}

export interface ProfileReadinessCommandResult {
  readonly report: ProfileReadinessReport;
  readonly exitCode: 0 | 1;
}

/** Runs only the provider-declared reviewed readiness check for one explicit account profile. */
export async function runProfileReadinessCommand(
  options: ProfileReadinessCommandOptions
): Promise<ProfileReadinessCommandResult> {
  const report = await runProfileReadiness(options.configPath, {
    profile: options.profile,
    ...(options.upstream === undefined ? {} : { upstream: options.upstream })
  });
  return { report, exitCode: report.status === "ready" ? 0 : 1 };
}
