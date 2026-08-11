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
import {
  previewInitCommand,
  runInitCommand,
  type InitCommandContext,
  type InitCommandResult,
  type InitCommandOptions
} from "./init.js";
import {
  ClientEntryImportSetupError,
  runClientEntryImportSetup,
  runClientEntryImportSetupFromDocument
} from "./setup-client-entry-import.js";
import { runNativeOAuthSetup } from "./setup-native-oauth.js";
import { runProviderAccountSetup } from "./setup-provider-account.js";
import { runEnvironmentProfileSetup } from "./setup-environment-profile.js";
import {
  createSetupCompletion,
  inspectConfigEnvironment,
  type SetupCompletionClientHandoff,
  type SetupEnvironmentReadiness,
  type SetupCompletionVerification
} from "../setup/setup-completion.js";
import type { SetupDraft, SetupDraftStore } from "../setup/setup-draft.js";

/** `init` remains network-free; only guided `setup --verify` may run the reviewed provider probe. */
export type SetupCommandOptions = InitCommandOptions & Pick<
  CliOptions,
  | "config"
  | "description"
  | "makeDefault"
  | "upstream"
  | "plan"
  | "verify"
  | "importFile"
  | "importEntry"
  | "nativeOAuth"
  | "addProfile"
  | "profile"
  | "resume"
  | "discardDraft"
  | "oauthClientMetadataUrl"
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
type GuidedClientEntryImportResult = Awaited<ReturnType<typeof runClientEntryImportSetupFromDocument>>;
type GuidedClientEntryImportOutcome =
  | { readonly kind: "imported"; readonly result: GuidedClientEntryImportResult }
  | { readonly kind: "manual-recovery"; readonly name: string; readonly output: string; readonly client?: string };

const GUIDED_SETUP_STARTING_POINTS = [
  { value: "connector", label: "Known connector or pinned package" },
  { value: "remote", label: "Remote HTTPS endpoint" },
  { value: "local", label: "Local executable" },
  { value: "remote-sign-in", label: "Remote MCP with browser sign-in" },
  { value: "import", label: "Existing client entry" }
] as const satisfies readonly { readonly value: GuidedSetupStartingPoint; readonly label: string }[];

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
    options.oauthClientMetadataUrl,
    options.localCommand,
    options.args,
    options.cwd,
    options.acceptLocalCommand,
    options.googleSearchConsoleProfiles,
    options.defaultProfile,
    options.verify
  ].some((value) => value !== undefined);
}

function parseGuidedSetupStartingPoint(answer: string): GuidedSetupStartingPoint | undefined {
  if (
    answer === "1" ||
    answer === "connector" ||
    answer === "new" ||
    answer === "n" ||
    answer === "preset" ||
    answer === "package" ||
    answer === "known connector or pinned package"
  ) {
    return "connector";
  }
  if (
    answer === "2" ||
    answer === "remote" ||
    answer === "remote-https" ||
    answer === "remote https" ||
    answer === "https" ||
    answer === "url" ||
    answer === "remote https endpoint"
  ) {
    return "remote";
  }
  if (
    answer === "3" ||
    answer === "local" ||
    answer === "local executable" ||
    answer === "executable" ||
    answer === "command"
  ) {
    return "local";
  }
  if (
    answer === "4" ||
    answer === "browser-sign-in" ||
    answer === "browser sign in" ||
    answer === "remote-sign-in" ||
    answer === "remote sign in" ||
    answer === "sign-in" ||
    answer === "browser" ||
    answer === "remote mcp with browser sign-in"
  ) {
    return "remote-sign-in";
  }
  if (answer === "5" || answer === "import" || answer === "i" || answer === "existing client entry") return "import";
  return undefined;
}

function isGuidedSetupCancellation(answer: string): boolean {
  return answer === "cancel" || answer === "quit" || answer === "q";
}

function writeGuidedSetupStartingPointMenu(context: InitCommandContext): void {
  context.output.write("\nMiftah setup\n");
  context.output.write("Step 1 — Choose what you already have\n");
  for (const [index, startingPoint] of GUIDED_SETUP_STARTING_POINTS.entries()) {
    context.output.write(`  ${index + 1}. ${startingPoint.label}\n`);
  }
  context.output.write("Enter a number or name. Type 'cancel' to exit before anything is written.\n");
}

function guidedSetupStartingPointLabel(startingPoint: GuidedSetupStartingPoint): string {
  return GUIDED_SETUP_STARTING_POINTS.find((candidate) => candidate.value === startingPoint)!.label;
}

async function confirmGuidedSetupStartingPoint(
  prompts: InteractivePromptSession,
  context: InitCommandContext,
  startingPoint: GuidedSetupStartingPoint
): Promise<"continue" | "back"> {
  context.output.write("\nStep 2 — Confirm the setup path\n");
  context.output.write(`Selected: ${guidedSetupStartingPointLabel(startingPoint)}\n`);
  while (true) {
    const answer = (await prompts.prompt(
      "Continue with this setup path? (yes/back/cancel)",
      "yes"
    ))?.toLowerCase() ?? "yes";
    if (answer === "yes" || answer === "y") return "continue";
    if (answer === "back" || answer === "b") return "back";
    if (isGuidedSetupCancellation(answer)) throw new CliUsageError("Guided setup was cancelled.");
    context.output.write("Choose 'yes' to continue, 'back' to change the starting point, or 'cancel' to exit.\n");
  }
}

async function chooseGuidedSetupStartingPoint(context: InitCommandContext): Promise<GuidedSetupStartingPoint> {
  const prompts = createInteractivePromptSession(context, "Guided setup was cancelled.");
  try {
    while (true) {
      writeGuidedSetupStartingPointMenu(context);
      const answer = (await prompts.prompt("Choose a starting point (1-5 or name)", "1"))?.toLowerCase() ?? "1";
      if (isGuidedSetupCancellation(answer)) throw new CliUsageError("Guided setup was cancelled.");
      const startingPoint = parseGuidedSetupStartingPoint(answer);
      if (startingPoint === undefined) {
        context.output.write(
          "Choose 1-5, or enter connector, remote, local, browser sign-in, or import. Type 'cancel' to exit.\n"
        );
        continue;
      }
      if (await confirmGuidedSetupStartingPoint(prompts, context, startingPoint) === "continue") {
        return startingPoint;
      }
      context.output.write("Returning to the starting-point choices. No connection details were saved.\n");
    }
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
async function runGuidedClientEntryImport(
  context: InitCommandContext
): Promise<GuidedClientEntryImportOutcome> {
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

    try {
      const result = await runClientEntryImportSetupFromDocument({
        name,
        output,
        ...(client === undefined ? {} : { client }),
        importFile,
        importEntry
      }, context, document);
      return { kind: "imported", result };
    } catch (error) {
      if (!(error instanceof ClientEntryImportSetupError) || error.importReason === undefined) throw error;
      context.output.write(
        "Miftah did not import this entry or write a configuration from it. It did not retain its arguments, headers, environment values, or credentials.\n" +
          "Choose 'local' to re-enter a reviewed executable and literal arguments, or 'remote' for a canonical HTTPS endpoint. Configure authentication separately.\n"
      );
      return {
        kind: "manual-recovery",
        name,
        output,
        ...(client === undefined ? {} : { client })
      };
    }
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

function writeCliSetupCompletion(
  context: InitCommandContext,
  input: {
    readonly verification: SetupCompletionVerification;
    readonly clientHandoff: SetupCompletionClientHandoff;
    readonly profile?: string;
    readonly configPath?: string;
    readonly includeClientHandoff?: boolean;
    readonly environment?: SetupEnvironmentReadiness;
    readonly deferredClientHandoff?: string;
  }
): void {
  const completion = createSetupCompletion({
    surface: "cli",
    verification: input.verification,
    clientHandoff: input.clientHandoff,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    ...(input.environment === undefined ? {} : { environment: input.environment })
  });
  context.output.write(`${completion.verification.message}\n`);
  if (completion.verification.nextAction !== undefined) {
    context.output.write(`${completion.verification.nextAction}\n`);
  }
  if (completion.environment !== undefined) {
    context.output.write(`${completion.environment.message}\n`);
    if (completion.environment.nextAction !== undefined) {
      context.output.write(`${completion.environment.nextAction}\n`);
    }
  }
  if (input.deferredClientHandoff !== undefined) {
    context.output.write(input.deferredClientHandoff);
  }
  if (input.includeClientHandoff !== false) {
    context.output.write(`${completion.clientHandoff.message}\n`);
  }
}

async function finishCreatedSetup(
  options: Pick<SetupCommandOptions, "verify">,
  context: InitCommandContext,
  created: InitCommandResult
): Promise<SetupCommandResult> {
  const environment = inspectConfigEnvironment(created.config);
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
    writeCliSetupCompletion(context, {
      verification: "not-declared",
      clientHandoff: created.clientHandoff ?? "not-generated",
      configPath: created.output,
      environment,
      ...(created.deferredClientHandoff === undefined
        ? {}
        : { deferredClientHandoff: created.deferredClientHandoff })
    });
    return { verification: "not-applicable", exitCode: 0, reports: [] };
  }
  const decision = options.verify === true ? "verify" : await confirmReadiness(context, "every account now");
  if (decision === "skip") {
    context.output.write("First-success verification was skipped; the configuration was created but has not been tested with the provider.\n");
    writeCliSetupCompletion(context, {
      verification: "skipped",
      clientHandoff: created.clientHandoff ?? "not-generated",
      profile: created.config.defaultProfile,
      configPath: created.output,
      environment,
      ...(created.deferredClientHandoff === undefined
        ? {}
        : { deferredClientHandoff: created.deferredClientHandoff })
    });
    return { verification: "skipped", exitCode: 0, reports: [] };
  }
  if (decision === "cancelled") {
    context.output.write("First-success verification was cancelled after configuration creation; the configuration remains available.\n");
    writeCliSetupCompletion(context, {
      verification: "incomplete",
      clientHandoff: created.clientHandoff ?? "not-generated",
      profile: created.config.defaultProfile,
      configPath: created.output,
      environment,
      ...(created.deferredClientHandoff === undefined
        ? {}
        : { deferredClientHandoff: created.deferredClientHandoff })
    });
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
  writeCliSetupCompletion(context, {
    verification: incomplete ? "incomplete" : "complete",
    clientHandoff: created.clientHandoff ?? "not-generated",
    ...(incomplete ? { profile: created.config.defaultProfile } : {}),
    configPath: created.output,
    environment,
    ...(created.deferredClientHandoff === undefined
      ? {}
      : { deferredClientHandoff: created.deferredClientHandoff })
  });
  return { verification: incomplete ? "incomplete" : "complete", exitCode: incomplete ? 1 : 0, reports };
}

function setupDraftIncompatibleOption(options: SetupCommandOptions): string | undefined {
  return [
    "interactive",
    "config",
    "description",
    "makeDefault",
    "upstream",
    "plan",
    "verify",
    "importFile",
    "importEntry",
    "nativeOAuth",
    "addProfile",
    "profile",
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
    "oauthClientSecretsFile",
    "oauthClientMetadataUrl",
    "localCommand",
    "args",
    "cwd",
    "acceptLocalCommand",
    "googleSearchConsoleProfiles",
    "defaultProfile"
  ].find((name) => options[name as keyof SetupCommandOptions] !== undefined);
}

function setupDraftStore(context: InitCommandContext): SetupDraftStore {
  if (context.setupDraftStore === undefined) {
    throw new CliUsageError("Resumable setup is unavailable in this embedding.");
  }
  return context.setupDraftStore;
}

async function discardPublishedSetupDraft(
  store: SetupDraftStore,
  revision: number,
  context: InitCommandContext
): Promise<void> {
  try {
    await store.discard(revision);
  } catch (error) {
    const code = error instanceof MiftahError ? error.code : "SETUP_DRAFT_UNAVAILABLE";
    context.output.write(
      `Configuration was created, but Miftah could not clear the saved connector choice (${code}). Run 'miftah setup --discard-draft' to remove it later.\n`
    );
  }
}

/**
 * Starts the human-first setup journey while retaining `init` for scripts and
 * existing automation. Both entry points deliberately use the same planner,
 * validation, config writer, and client-handoff implementation.
 */
export async function runSetupCommand(options: SetupCommandOptions, context: InitCommandContext): Promise<SetupCommandResult> {
  if (options.resume === true && options.discardDraft === true) {
    throw new CliUsageError("Choose either '--resume' or '--discard-draft', not both.");
  }
  if (options.resume === true || options.discardDraft === true) {
    const incompatible = setupDraftIncompatibleOption(options);
    const option = options.resume === true ? "resume" : "discard-draft";
    if (incompatible !== undefined) {
      throw new CliUsageError(`Option '--${option}' cannot be combined with '--${flagName(incompatible)}'.`);
    }
    const store = setupDraftStore(context);
    const draft = await store.load();
    if (options.discardDraft === true) {
      if (draft === undefined) {
        context.output.write("No saved connector setup is available to discard.\n");
      } else {
        await store.discard(draft.revision);
        context.output.write("Discarded the saved connector setup choice.\n");
      }
      return { verification: "not-applicable", exitCode: 0, reports: [] };
    }
    if (!isTty(context)) {
      throw new CliUsageError("Option '--resume' requires TTY input and output so connection details can be re-entered.");
    }
    if (draft === undefined) {
      throw new CliUsageError("No saved connector setup is available to resume. Start 'miftah setup' and choose a connector first.");
    }
    context.output.write("Resuming the saved connector choice. Re-enter all connection details before Miftah creates a configuration.\n");
    const created = await runInitCommand({
      interactive: true,
      name: draft.name,
      preset: draft.preset
    }, { ...context, deferClientHandoff: true });
    await discardPublishedSetupDraft(store, draft.revision, context);
    return finishCreatedSetup(options, context, created);
  }
  if (options.plan === true) {
    const incompatible = [
      "interactive",
      "config",
      "description",
      "makeDefault",
      "upstream",
      "verify",
      "importFile",
      "importEntry",
      "nativeOAuth",
      "addProfile",
      "profile",
      "oauthClientMetadataUrl"
    ].find((name) => options[name as keyof SetupCommandOptions] !== undefined);
    if (incompatible !== undefined) {
      throw new CliUsageError(`Option '--${flagName(incompatible)}' is unavailable when printing a setup plan.`);
    }
    const preview = previewInitCommand(options, context);
    context.output.write(`${JSON.stringify(preview, null, 2)}\n`);
    return { verification: "not-applicable", exitCode: 0, reports: [] };
  }
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
      writeCliSetupCompletion(context, {
        verification: "skipped",
        clientHandoff: "not-generated",
        profile: added.report.profile,
        configPath: added.configPath,
        includeClientHandoff: false
      });
      return { verification: "skipped", exitCode: 0, reports: [] };
    }
    if (decision === "cancelled") {
      context.output.write("First-success verification was cancelled after the account was added; the configuration remains available.\n");
      writeCliSetupCompletion(context, {
        verification: "incomplete",
        clientHandoff: "not-generated",
        profile: added.report.profile,
        configPath: added.configPath,
        includeClientHandoff: false
      });
      return { verification: "incomplete", exitCode: 1, reports: [] };
    }
    try {
      const report = await runProfileReadiness(added.configPath, { profile: added.report.profile });
      writeReadinessReport(context, report);
      writeCliSetupCompletion(context, {
        verification: report.status === "ready" ? "complete" : "incomplete",
        clientHandoff: "not-generated",
        profile: added.report.profile,
        configPath: added.configPath,
        includeClientHandoff: false
      });
      return {
        verification: report.status === "ready" ? "complete" : "incomplete",
        exitCode: report.status === "ready" ? 0 : 1,
        reports: [report]
      };
    } catch (error) {
      const code = error instanceof MiftahError ? error.code : "UPSTREAM_CALL_FAILED";
      context.output.write(`Profile '${added.report.profile}': readiness did not complete (${code}).\n`);
      writeCliSetupCompletion(context, {
        verification: "incomplete",
        clientHandoff: "not-generated",
        profile: added.report.profile,
        configPath: added.configPath,
        includeClientHandoff: false
      });
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
    options.upstream !== undefined ||
    options.oauthClientMetadataUrl !== undefined
  ) {
    throw new CliUsageError("Options '--config', '--profile', '--upstream', '--description', '--make-default', and '--oauth-client-metadata-url' require '--native-oauth' with guided setup.");
  }
  if (options.importFile !== undefined || options.importEntry !== undefined) {
    if (options.verify === true) {
      throw new CliUsageError("Option '--verify' is unavailable for imported client entries because Miftah does not infer a reviewed provider adapter.");
    }
    const imported = await runClientEntryImportSetup(options, context);
    // Imported client entries are intentionally untrusted/manual. They do not
    // inherit a reviewed provider adapter and are never launched during import.
    writeCliSetupCompletion(context, {
      verification: "not-declared",
      clientHandoff: imported.clientHandoff ?? "not-generated",
      configPath: imported.output
    });
    return { verification: "not-applicable", exitCode: 0, reports: [] };
  }
  let guidedPreset: "streamable-http" | "local-stdio" | undefined;
  let recoveredManualConfiguration: Awaited<ReturnType<typeof runInitCommand>> | undefined;
  let checkpointedDraft: SetupDraft | undefined;
  let checkpointConnectorIntent = false;
  if (isTty(context) && !hasExplicitNewConfigurationInput(options)) {
    const startingPoint = await chooseGuidedSetupStartingPoint(context);
    if (startingPoint === "import") {
      const imported = await runGuidedClientEntryImport(context);
      if (imported.kind === "imported") {
        writeCliSetupCompletion(context, {
          verification: "not-declared",
          clientHandoff: imported.result.clientHandoff ?? "not-generated",
          configPath: imported.result.output
        });
        return { verification: "not-applicable", exitCode: 0, reports: [] };
      }
      recoveredManualConfiguration = await runInitCommand({
        ...options,
        name: imported.name,
        output: imported.output,
        interactive: true,
        ...(imported.client === undefined ? {} : { client: imported.client })
      }, { ...context, deferClientHandoff: true });
    }
    if (recoveredManualConfiguration === undefined && startingPoint === "remote-sign-in") {
      await runNativeOAuthSetup(options, context, {
        ...(context.nativeOAuthFetch === undefined ? {} : { fetch: context.nativeOAuthFetch })
      });
      return { verification: "not-applicable", exitCode: 0, reports: [] };
    }
    if (recoveredManualConfiguration === undefined && (startingPoint === "remote" || startingPoint === "local")) {
      guidedPreset = startingPoint === "remote" ? "streamable-http" : "local-stdio";
    }
    checkpointConnectorIntent = startingPoint === "connector";
  }
  const checkpointStore = context.setupDraftStore;
  const initContext = checkpointConnectorIntent && checkpointStore !== undefined
    ? {
        ...context,
        onSetupDraftIntent: async (intent: Parameters<NonNullable<InitCommandContext["onSetupDraftIntent"]>>[0]) => {
          try {
            checkpointedDraft = await checkpointStore.save(intent);
          } catch (error) {
            if (error instanceof MiftahError && error.code === "SETUP_DRAFT_INPUT_INVALID") {
              context.output.write(
                "This connector name or preset cannot be safely saved as a resumable setup choice; continuing without a resume point.\n"
              );
              return;
            }
            throw error;
          }
        }
      }
    : context;
  const created = recoveredManualConfiguration ?? await runInitCommand({
    ...options,
    interactive: true,
    ...(guidedPreset === undefined ? {} : { preset: guidedPreset })
  }, { ...initContext, deferClientHandoff: true });
  if (checkpointedDraft !== undefined && checkpointStore !== undefined) {
    await discardPublishedSetupDraft(checkpointStore, checkpointedDraft.revision, context);
  }
  return finishCreatedSetup(options, context, created);
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
