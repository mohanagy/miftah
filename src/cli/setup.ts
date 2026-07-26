import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { runProfileReadiness, type ProfileReadinessReport } from "../setup/profile-readiness.js";
import {
  ClientEntryImportError,
  inspectClientConfiguration
} from "../setup/client-entry-import.js";
import { readClientEntryImportFile } from "../setup/client-entry-import-file.js";
import { loadConfig } from "../config/load-config.js";
import { getProviderAdapterForAccountProvisioning } from "../config/provider-adapters.js";
import { MiftahError } from "../utils/errors.js";
import { CliUsageError } from "./parse.js";
import type { CliOptions } from "./parse.js";
import { runInitCommand, type InitCommandContext, type InitCommandOptions } from "./init.js";
import {
  runClientEntryImportSetup,
  runClientEntryImportSetupFromDocument
} from "./setup-client-entry-import.js";
import { runNativeOAuthSetup } from "./setup-native-oauth.js";
import { runProviderAccountSetup } from "./setup-provider-account.js";
import { runEnvironmentProfileSetup } from "./setup-environment-profile.js";

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
type AccountAdditionKind = "provider" | "environment";
type GuidedSetupStartingPoint = "connector" | "remote" | "local" | "remote-sign-in" | "import";

interface InteractivePromptSession {
  prompt(label: string, defaultValue?: string): Promise<string | undefined>;
  close(): void;
}

function flagName(option: string): string {
  return option.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function isTty(context: InitCommandContext): boolean {
  return context.input.isTTY === true && context.output.isTTY === true;
}

function createInteractivePromptSession(
  context: InitCommandContext,
  cancellationMessage: string
): InteractivePromptSession {
  const line = createInterface({ input: context.input, output: context.output, terminal: true });
  const cancelled = Symbol("cancelled");
  let resolveCancellation: (value: typeof cancelled) => void = () => undefined;
  const cancellation = new Promise<typeof cancelled>((resolve) => {
    resolveCancellation = resolve;
  });
  const cancel = () => resolveCancellation(cancelled);
  line.once("close", cancel);
  line.once("SIGINT", cancel);

  return {
    async prompt(label: string, defaultValue?: string): Promise<string | undefined> {
      const suffix = defaultValue === undefined ? ": " : ` [${defaultValue}]: `;
      const answer = await Promise.race([cancellation, line.question(`${label}${suffix}`)]);
      if (answer === cancelled) throw new CliUsageError(cancellationMessage);
      const value = answer.trim();
      return value === "" ? defaultValue : value;
    },
    close(): void {
      line.removeListener("close", cancel);
      line.removeListener("SIGINT", cancel);
      line.close();
    }
  };
}

function hasExplicitNewConfigurationInput(options: SetupCommandOptions): boolean {
  return [
    options.name,
    options.preset,
    options.output,
    options.client,
    options.credentialEnv,
    options.npmPackage,
    options.dockerImage,
    options.url,
    options.headerName,
    options.headerPrefix,
    options.oauthClientSecretsFile,
    options.localCommand,
    options.args,
    options.cwd,
    options.acceptLocalCommand,
    options.googleSearchConsoleProfiles,
    options.defaultProfile,
    options.verify
  ].some((value) => value !== undefined);
}

async function chooseGuidedSetupStartingPoint(context: InitCommandContext): Promise<GuidedSetupStartingPoint> {
  const prompts = createInteractivePromptSession(context, "Guided setup was cancelled.");
  try {
    const answer = (await prompts.prompt(
      "What do you already have? (connector, remote HTTPS, local executable, browser sign-in, import)",
      "connector"
    ))?.toLowerCase();
    if (answer === "connector" || answer === "new" || answer === "n" || answer === "preset" || answer === "package") {
      return "connector";
    }
    if (answer === "remote" || answer === "remote-https" || answer === "remote https" || answer === "https" || answer === "url") {
      return "remote";
    }
    if (answer === "local" || answer === "executable" || answer === "command") return "local";
    if (
      answer === "browser-sign-in" ||
      answer === "browser sign-in" ||
      answer === "remote-sign-in" ||
      answer === "remote sign-in" ||
      answer === "sign-in" ||
      answer === "browser"
    ) {
      return "remote-sign-in";
    }
    if (answer === "import" || answer === "i") return "import";
    throw new CliUsageError(
      "Choose 'connector' for a known connector or pinned package, 'remote' for a generic HTTPS MCP endpoint, 'local' for an executable plus arguments, 'browser-sign-in' when the MCP opens a browser, or 'import' for an existing client entry."
    );
  } finally {
    prompts.close();
  }
}

function selectedGuidedClientEntry(answer: string | undefined, entries: readonly string[]): string {
  if (answer === undefined || answer.length === 0) {
    throw new CliUsageError("Choose one listed MCP entry by number or exact name.");
  }
  if (entries.includes(answer)) return answer;
  if (/^[1-9][0-9]*$/u.test(answer)) {
    const index = Number(answer) - 1;
    if (index >= 0 && index < entries.length) return entries[index]!;
  }
  throw new CliUsageError("Choose one listed MCP entry by number or exact name.");
}

/**
 * Keeps a selected existing client entry outcome-first without granting it any
 * authority: source bytes stay private, only safe entry names are rendered,
 * and the existing shared importer performs the sole conversion and write.
 */
async function runGuidedClientEntryImport(context: InitCommandContext): Promise<void> {
  const prompts = createInteractivePromptSession(context, "Guided client-entry import was cancelled.");
  try {
    const importFile = await prompts.prompt("Client configuration file (absolute path)");
    if (importFile === undefined) throw new CliUsageError("Choose an absolute client configuration file before importing.");

    let document: string;
    let entries: readonly string[];
    try {
      document = await readClientEntryImportFile(importFile);
      entries = inspectClientConfiguration(document).entries;
    } catch (error) {
      if (error instanceof ClientEntryImportError) throw new CliUsageError(error.message);
      throw error;
    }
    context.output.write(`Available MCP entries (names only):\n${entries.map((entry, index) => `${index + 1}. ${entry}\n`).join("")}`);
    const importEntry = selectedGuidedClientEntry(
      await prompts.prompt("MCP entry to import (number or exact name)"),
      entries
    );
    const name = await prompts.prompt("Configuration name", "miftah-import");
    if (name === undefined) throw new CliUsageError("Choose a configuration name before importing.");
    const output = await prompts.prompt("Output location", `${name}.miftah.json`);
    if (output === undefined) throw new CliUsageError("Choose an output location before importing.");
    const client = await prompts.prompt(
      "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)"
    );

    await runClientEntryImportSetupFromDocument({
      name,
      output,
      ...(client === undefined ? {} : { client }),
      importFile,
      importEntry
    }, context, document);
  } finally {
    prompts.close();
  }
}

async function accountAdditionKind(options: SetupCommandOptions, context: InitCommandContext): Promise<AccountAdditionKind> {
  if (options.config === undefined) {
    throw new CliUsageError("Adding an account profile requires --config.");
  }
  if (options.config.includes("\0")) {
    throw new CliUsageError("Configuration path must not contain a NUL character.");
  }
  const config = await loadConfig(resolve(context.cwd, options.config));
  return getProviderAdapterForAccountProvisioning(config)?.accountProvisioning === undefined ? "environment" : "provider";
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
      throw new CliUsageError(`Option '--${flagName(incompatible)}' is unavailable when adding an account profile.`);
    }
    const kind = await accountAdditionKind(options, context);
    if (kind === "environment") {
      if (options.oauthClientSecretsFile !== undefined) {
        throw new CliUsageError("Option '--oauth-client-secrets-file' is unavailable when adding an environment-backed account.");
      }
      if (options.verify === true) {
        throw new CliUsageError(
          "Option '--verify' is unavailable when adding an environment-backed account because this configuration has no provider-declared readiness check."
        );
      }
      await runEnvironmentProfileSetup(options, context);
      return { verification: "not-applicable", exitCode: 0, reports: [] };
    }
    if (options.credentialEnv !== undefined) {
      throw new CliUsageError("Option '--credential-env' is unavailable when adding a provider-owned account.");
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
  let guidedPreset: "streamable-http" | "local-stdio" | undefined;
  if (isTty(context) && !hasExplicitNewConfigurationInput(options)) {
    const startingPoint = await chooseGuidedSetupStartingPoint(context);
    if (startingPoint === "import") {
      await runGuidedClientEntryImport(context);
      return { verification: "not-applicable", exitCode: 0, reports: [] };
    }
    if (startingPoint === "remote-sign-in") {
      await runNativeOAuthSetup(options, context, {
        ...(context.nativeOAuthFetch === undefined ? {} : { fetch: context.nativeOAuthFetch })
      });
      return { verification: "not-applicable", exitCode: 0, reports: [] };
    }
    if (startingPoint === "remote" || startingPoint === "local") {
      guidedPreset = startingPoint === "remote" ? "streamable-http" : "local-stdio";
    }
  }
  const created = await runInitCommand({
    ...options,
    interactive: true,
    ...(guidedPreset === undefined ? {} : { preset: guidedPreset })
  }, context);
  if (
    created.config.version === "3" &&
    created.config.upstream?.transport === "streamable-http" &&
    created.config.oauth === undefined
  ) {
    context.output.write(
      "Generic remote setup did not discover authentication or call the endpoint. If this MCP needs browser sign-in, start 'miftah setup' again and choose 'browser-sign-in'.\n"
    );
  }
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
