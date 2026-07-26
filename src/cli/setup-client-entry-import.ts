import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ClientEntryImportError,
  createImportedClientConfiguration
} from "../setup/client-entry-import.js";
import { readClientEntryImportFile } from "../setup/client-entry-import-file.js";
import {
  createSetupConfigurationPlan,
  publishSetupConfigurationPlan
} from "../setup/setup-configuration.js";
import {
  CLIENT_NAMES,
  ClientSnippetError,
  renderClaudeCodePermissionGuidance,
  renderClientSnippets,
  type ClientSelection
} from "./client-snippets.js";
import type { InitCommandContext, InitCommandOptions, InitCommandResult } from "./init.js";
import { CliUsageError } from "./parse.js";
import type { CliOptions } from "./parse.js";

type ClientEntryImportSetupOptions = InitCommandOptions & Pick<CliOptions, "importFile" | "importEntry">;

function usageError(message: string): never {
  throw new CliUsageError(message);
}

function isClientSelection(value: string): value is ClientSelection {
  return value === "all" || (CLIENT_NAMES as readonly string[]).includes(value);
}

function resolveOutputPath(output: string, cwd: string): string {
  if (output.includes("\0")) usageError("Output path must not contain a NUL character.");
  return resolve(cwd, output);
}

function isExistingOutputError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function rejectPresetOptions(options: ClientEntryImportSetupOptions): void {
  const incompatible = [
    options.preset,
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
    options.defaultProfile
  ].some((value) => value !== undefined);
  if (incompatible) {
    usageError("Client-entry import cannot be combined with a catalog preset or credential options.");
  }
}

function writeClientHandoff(options: ClientEntryImportSetupOptions, result: InitCommandResult, context: InitCommandContext): void {
  if (options.client === undefined) return;
  if (!isClientSelection(options.client)) usageError(`Unsupported client '${options.client}'.`);
  try {
    const snippets = renderClientSnippets(options.client, {
      serverName: result.config.name,
      configPath: result.output,
      launcher: context.launcher
    });
    for (const snippet of snippets) {
      context.output.write(`${snippet.target.label} (${snippet.client}):\n${snippet.json}\n`);
    }
    if (options.client === "claude-code" || options.client === "all") {
      const guidance = renderClaudeCodePermissionGuidance(result.config.name, {
        delegatedAgentApproval: result.config.security?.approvalMode === "delegated-agent"
      });
      if (guidance.kind === "manual") {
        context.output.write(`${guidance.target.label}:\n${guidance.message}\n`);
      } else {
        context.output.write(
          `${guidance.target.label}:\n${guidance.json}\n` +
            "Manually merge this fragment into .claude/settings.local.json, .claude/settings.json, or ~/.claude/settings.json. It is client-side defense in depth; Miftah enforces authorization.\n"
        );
      }
    }
  } catch (error) {
    if (error instanceof ClientSnippetError) usageError(error.message);
    throw error;
  }
}

/**
 * Publishes a safe Miftah configuration from one explicitly selected local stdio or HTTPS remote client entry.
 * It never edits, launches, or otherwise trusts the source MCP client configuration.
 */
export async function runClientEntryImportSetup(
  options: ClientEntryImportSetupOptions,
  context: InitCommandContext
): Promise<InitCommandResult> {
  if (options.importFile === undefined || options.importEntry === undefined) {
    usageError("Client-entry import requires both '--import-file <file>' and '--import-entry <name>'.");
  }
  let document: string;
  try {
    document = await readClientEntryImportFile(options.importFile);
  } catch (error) {
    if (error instanceof ClientEntryImportError) usageError(error.message);
    throw error;
  }
  return runClientEntryImportSetupFromDocument(options, context, document);
}

/**
 * Publishes from a document already read through the bounded verified source
 * reader. Guided import uses this to keep its displayed entry list and its
 * selected entry bound to the same source snapshot.
 */
export async function runClientEntryImportSetupFromDocument(
  options: ClientEntryImportSetupOptions,
  context: InitCommandContext,
  document: string
): Promise<InitCommandResult> {
  if (options.importFile === undefined || options.importEntry === undefined) {
    usageError("Client-entry import requires both '--import-file <file>' and '--import-entry <name>'.");
  }
  rejectPresetOptions(options);
  if (options.client !== undefined && !isClientSelection(options.client)) {
    usageError(`Unsupported client '${options.client}'.`);
  }

  const name = options.name ?? "miftah-wrapper";
  const output = resolveOutputPath(options.output ?? `${name}.miftah.json`, context.cwd);
  let config: InitCommandResult["config"];
  try {
    config = createImportedClientConfiguration({
      configurationName: name,
      document,
      entry: options.importEntry
    });
  } catch (error) {
    if (error instanceof ClientEntryImportError) usageError(error.message);
    throw error;
  }

  const plan = createSetupConfigurationPlan({ configPath: output, config });
  await mkdir(dirname(plan.path), { recursive: true });
  try {
    await publishSetupConfigurationPlan(plan);
  } catch (error) {
    if (isExistingOutputError(error)) usageError(`Output '${plan.path}' already exists.`);
    throw error;
  }

  const result: InitCommandResult = { output: plan.path, config };
  context.output.write(`Created ${plan.path}\n`);
  if (config.upstream?.transport === "streamable-http") {
    context.output.write(
      "Imported one HTTPS remote MCP entry without copying credentials. Miftah did not discover OAuth or call the upstream. Configure authentication separately when required.\n"
    );
  } else {
    context.output.write("Imported one local stdio MCP entry without copying credentials. Configure authentication separately when required.\n");
  }
  writeClientHandoff(options, result, context);
  return result;
}
