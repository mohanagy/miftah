import { createInterface } from "node:readline/promises";
import { runProfileReadiness, type ProfileReadinessReport } from "../setup/profile-readiness.js";
import { MiftahError } from "../utils/errors.js";
import { CliUsageError } from "./parse.js";
import type { CliOptions } from "./parse.js";
import { runInitCommand, type InitCommandContext, type InitCommandOptions } from "./init.js";

/** `init` remains network-free; only guided `setup --verify` may run the reviewed provider probe. */
export type SetupCommandOptions = InitCommandOptions & Pick<CliOptions, "verify">;

export interface SetupCommandResult {
  readonly verification: "not-applicable" | "skipped" | "complete" | "incomplete";
  /** The process outcome after configuration publication and optional readiness verification. */
  readonly exitCode: 0 | 1;
  readonly reports: readonly ProfileReadinessReport[];
}

type ReadinessDecision = "verify" | "skip" | "cancelled";

/**
 * Starts the human-first setup journey while retaining `init` for scripts and
 * existing automation. Both entry points deliberately use the same planner,
 * validation, config writer, and client-handoff implementation.
 */
export async function runSetupCommand(options: SetupCommandOptions, context: InitCommandContext): Promise<SetupCommandResult> {
  const created = await runInitCommand({ ...options, interactive: true }, context);
  if (created.providerAdapter?.diagnostics.safeReadProbe === undefined) {
    return { verification: "not-applicable", exitCode: 0, reports: [] };
  }
  const decision = options.verify === true ? "verify" : await confirmReadiness(context);
  if (decision === "skip") {
    context.output.write("First-success verification was skipped; the configuration was created but has not been tested with the provider.\n");
    return { verification: "skipped", exitCode: 0, reports: [] };
  }
  if (decision === "cancelled") {
    context.output.write("First-success verification was cancelled after configuration creation; the configuration remains available.\n");
    return { verification: "incomplete", exitCode: 1, reports: [] };
  }

  const reports: ProfileReadinessReport[] = [];
  let incomplete = false;
  for (const profile of Object.keys(created.config.profiles).sort()) {
    try {
      const report = await runProfileReadiness(created.output, { profile });
      reports.push(report);
      writeReadinessReport(context, report);
      if (report.status !== "ready") incomplete = true;
    } catch (error) {
      incomplete = true;
      const code = error instanceof MiftahError ? error.code : "UPSTREAM_CALL_FAILED";
      context.output.write(`Profile '${profile}': readiness did not complete (${code}).\n`);
    }
  }
  return { verification: incomplete ? "incomplete" : "complete", exitCode: incomplete ? 1 : 0, reports };
}

async function confirmReadiness(context: InitCommandContext): Promise<ReadinessDecision> {
  const line = createInterface({ input: context.input, output: context.output, terminal: true });
  let cancelled = false;
  let resolveCancellation: (decision: "cancelled") => void = () => undefined;
  const cancellation = new Promise<"cancelled">((resolve) => {
    resolveCancellation = resolve;
  });
  const cancel = () => {
    cancelled = true;
    resolveCancellation("cancelled");
  };
  line.once("close", cancel);
  line.once("SIGINT", cancel);
  try {
    return await Promise.race([
      line.question("Run the reviewed safe readiness check for every account now? (yes/no) [no]: ").then((value): ReadinessDecision => {
        const answer = value.trim().toLowerCase();
        if (answer === "" || answer === "n" || answer === "no") return "skip";
        if (answer === "y" || answer === "yes") return "verify";
        throw new CliUsageError("Answer 'yes' or 'no' when asked to run the safe readiness check.");
      }),
      cancellation
    ]);
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    if (cancelled) return "cancelled";
    throw error;
  } finally {
    line.removeListener("close", cancel);
    line.removeListener("SIGINT", cancel);
    line.close();
  }
}

function writeReadinessReport(context: InitCommandContext, report: ProfileReadinessReport): void {
  if (report.status === "ready") {
    context.output.write(`Profile '${report.profile}': safe read-only check succeeded; identity is ${report.identity.status}.\n`);
    return;
  }
  context.output.write(
    `Profile '${report.profile}': readiness is ${report.status} (${report.safeRead.status}${
      report.safeRead.errorCode === undefined ? "" : `: ${report.safeRead.errorCode}`
    }).\n`
  );
}
