import { createInterface } from "node:readline/promises";
import { runProfileReadiness, type ProfileReadinessReport } from "../setup/profile-readiness.js";
import { MiftahError } from "../utils/errors.js";
import { CliUsageError } from "./parse.js";
import type { CliOptions } from "./parse.js";
import { runInitCommand, type InitCommandContext, type InitCommandOptions } from "./init.js";
import { runClientEntryImportSetup } from "./setup-client-entry-import.js";
import { runNativeOAuthSetup } from "./setup-native-oauth.js";
import { runProviderAccountSetup } from "./setup-provider-account.js";

/** `init` remains network-free; only guided `setup --verify` may run the reviewed provider probe. */
export type SetupCommandOptions = InitCommandOptions & Pick<
  CliOptions,
  "config" | "description" | "makeDefault" | "upstream" | "verify" | "importFile" | "importEntry" | "nativeOAuth" | "addProfile" | "profile"
>;

export interface SetupCommandResult {
  readonly verification: "not-applicable" | "skipped" | "complete" | "incomplete";
  /** The process outcome after configuration publication and optional readiness verification. */
  readonly exitCode: 0 | 1;
  readonly reports: readonly ProfileReadinessReport[];
}

type ReadinessDecision = "verify" | "skip" | "cancelled";

function flagName(option: string): string {
  return option.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function isTty(context: InitCommandContext): boolean {
  return context.input.isTTY === true && context.output.isTTY === true;
}

/**
 * Starts the human-first setup journey while retaining `init` for scripts and
 * existing automation. Both entry points deliberately use the same planner,
 * validation, config writer, and client-handoff implementation.
 */
export async function runSetupCommand(options: SetupCommandOptions, context: InitCommandContext): Promise<SetupCommandResult> {
  if (options.addProfile === true) {
    if (options.nativeOAuth === true) {
      throw new CliUsageError("Choose either '--add-profile' for a reviewed provider adapter or '--native-oauth' for endpoint-first OAuth.");
    }
    if (options.importFile !== undefined || options.importEntry !== undefined) {
      throw new CliUsageError("Provider-owned account addition cannot import a local client entry.");
    }
    const incompatible = [
      "name",
      "preset",
      "output",
      "client",
      "credentialEnv",
      "npmPackage",
      "dockerImage",
      "url",
      "headerName",
      "headerPrefix",
      "localCommand",
      "args",
      "cwd",
      "acceptLocalCommand",
      "upstream"
    ].find((name) => options[name as keyof SetupCommandOptions] !== undefined);
    if (incompatible !== undefined) {
      throw new CliUsageError(`Option '--${flagName(incompatible)}' is unavailable when adding a provider-owned account.`);
    }
    const added = await runProviderAccountSetup(options, context);
    const decision = options.verify === true ? "verify" : !isTty(context) ? "skip" : await confirmReadiness(context, "the new account now");
    if (decision === "skip") {
      context.output.write("First-success verification was skipped; the new account was added but has not been tested with the provider.\n");
      return { verification: "skipped", exitCode: 0, reports: [] };
    }
    if (decision === "cancelled") {
      context.output.write("First-success verification was cancelled after the account was added; the configuration remains available.\n");
      return { verification: "incomplete", exitCode: 1, reports: [] };
    }
    try {
      const report = await runProfileReadiness(added.configPath, { profile: added.report.profile });
      writeReadinessReport(context, report);
      return {
        verification: report.status === "ready" ? "complete" : "incomplete",
        exitCode: report.status === "ready" ? 0 : 1,
        reports: [report]
      };
    } catch (error) {
      const code = error instanceof MiftahError ? error.code : "UPSTREAM_CALL_FAILED";
      context.output.write(`Profile '${added.report.profile}': readiness did not complete (${code}).\n`);
      return { verification: "incomplete", exitCode: 1, reports: [] };
    }
  }
  if (options.nativeOAuth === true) {
    if (options.importFile !== undefined || options.importEntry !== undefined) {
      throw new CliUsageError("Native OAuth setup cannot import an existing local client entry.");
    }
    if (options.verify === true) {
      throw new CliUsageError("Option '--verify' is unavailable for native OAuth setup because no upstream call runs before browser authorization.");
    }
    const incompatible = [
      "preset",
      "credentialEnv",
      "npmPackage",
      "dockerImage",
      "headerName",
      "headerPrefix",
      "oauthClientSecretsFile",
      "localCommand",
      "args",
      "cwd",
      "acceptLocalCommand"
    ].find((name) => options[name as keyof SetupCommandOptions] !== undefined);
    if (incompatible !== undefined) {
      throw new CliUsageError(`Option '--${flagName(incompatible)}' is unavailable for endpoint-first native OAuth setup.`);
    }
    await runNativeOAuthSetup(options, context, {
      ...(context.nativeOAuthFetch === undefined ? {} : { fetch: context.nativeOAuthFetch })
    });
    return { verification: "not-applicable", exitCode: 0, reports: [] };
  }
  if (
    options.config !== undefined ||
    options.description !== undefined ||
    options.makeDefault === true ||
    options.profile !== undefined ||
    options.upstream !== undefined
  ) {
    throw new CliUsageError("Options '--config', '--profile', '--upstream', '--description', and '--make-default' require '--native-oauth' with guided setup.");
  }
  if (options.importFile !== undefined || options.importEntry !== undefined) {
    if (options.verify === true) {
      throw new CliUsageError("Option '--verify' is unavailable for imported client entries because Miftah does not infer a reviewed provider adapter.");
    }
    await runClientEntryImportSetup(options, context);
    // Imported client entries are intentionally untrusted/manual. They do not
    // inherit a reviewed provider adapter and are never launched during import.
    return { verification: "not-applicable", exitCode: 0, reports: [] };
  }
  const created = await runInitCommand({ ...options, interactive: true }, context);
  if (created.providerAdapter?.diagnostics.safeReadProbe === undefined) {
    return { verification: "not-applicable", exitCode: 0, reports: [] };
  }
  const decision = options.verify === true ? "verify" : await confirmReadiness(context, "every account now");
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

async function confirmReadiness(context: InitCommandContext, target: string): Promise<ReadinessDecision> {
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
      line.question(`Run the reviewed safe readiness check for ${target}? (yes/no) [no]: `).then((value): ReadinessDecision => {
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
