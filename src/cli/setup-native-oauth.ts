import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createSetupConfigurationPlan,
  publishSetupConfigurationPlan
} from "../setup/setup-configuration.js";
import { createSetupCompletion } from "../setup/setup-completion.js";
import {
  planNativeOAuthFirstRunConfiguration,
  runNativeOAuthAccountAddition
} from "../setup/native-oauth-onboarding.js";
import {
  CLIENT_NAMES,
  ClientSnippetError,
  formatClientSnippetHandoff,
  renderClaudeCodePermissionGuidance,
  renderClientSnippets
} from "./client-snippets.js";
import type { ClaudeCodePermissionGuidance, ClientSelection } from "./client-snippets.js";
import { CliUsageError } from "./parse.js";
import type { CliOptions } from "./parse.js";
import type { InitCommandContext } from "./init.js";

export type NativeOAuthSetupOptions = Pick<
  CliOptions,
  "config" | "name" | "description" | "profile" | "upstream" | "url" | "output" | "client" | "makeDefault"
>;

interface NativeOAuthSetupValues {
  readonly name: string;
  readonly profile: string;
  readonly description?: string;
  readonly resource: string;
  readonly output: string;
  readonly client?: string;
}

interface NativeOAuthExistingAccountValues {
  readonly configPath: string;
  readonly profile: string;
  readonly description?: string;
  readonly upstream: string;
  readonly makeDefault: boolean;
}

function usageError(message: string): never {
  throw new CliUsageError(message);
}

function isTty(context: InitCommandContext): boolean {
  return context.input.isTTY === true && context.output.isTTY === true;
}

function resolveOutputPath(output: string, cwd: string): string {
  if (output.includes("\0")) usageError("Output path must not contain a NUL character.");
  return resolve(cwd, output);
}

function isClientSelection(value: string): value is ClientSelection {
  return value === "all" || (CLIENT_NAMES as readonly string[]).includes(value);
}

function isExistingOutputError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function prompt(
  line: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string
): Promise<string | undefined> {
  const suffix = defaultValue === undefined ? ": " : ` [${defaultValue}]: `;
  const answer = (await line.question(`${label}${suffix}`)).trim();
  return answer.length === 0 ? defaultValue : answer;
}

async function collectValues(
  options: NativeOAuthSetupOptions,
  context: InitCommandContext
): Promise<NativeOAuthSetupValues> {
  const supplied = options.name !== undefined && options.profile !== undefined && options.url !== undefined;
  if (supplied) {
    return {
      name: options.name,
      profile: options.profile,
      ...(options.description === undefined ? {} : { description: options.description }),
      resource: options.url,
      output: options.output ?? `${options.name}.miftah.json`,
      client: options.client
    };
  }
  if (!isTty(context)) {
    usageError("Native OAuth setup requires --name, --profile, and --url when no TTY is available.");
  }

  const line = createInterface({ input: context.input, output: context.output, terminal: true });
  try {
    const name = options.name ?? await prompt(line, "Configuration name", "miftah-remote");
    const profile = options.profile ?? await prompt(line, "Account profile name", "default");
    const description = options.description ?? await prompt(line, "Account profile description (optional)");
    const resource = options.url ?? await prompt(line, "Remote MCP HTTPS URL");
    if (name === undefined || profile === undefined || resource === undefined) {
      usageError("Native OAuth setup requires a configuration name, account profile, and remote MCP HTTPS URL.");
    }
    const output = options.output ?? await prompt(line, "Output location", `${name}.miftah.json`);
    const client = options.client ?? await prompt(
      line,
      "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)"
    );
    if (output === undefined) usageError("Native OAuth setup requires an output location.");
    return {
      name,
      profile,
      ...(description === undefined ? {} : { description }),
      resource,
      output,
      ...(client === undefined ? {} : { client })
    };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("Native OAuth setup was cancelled.");
  } finally {
    line.close();
  }
}

async function collectExistingAccountValues(
  options: NativeOAuthSetupOptions,
  context: InitCommandContext
): Promise<NativeOAuthExistingAccountValues> {
  if (options.config === undefined) usageError("Adding a native OAuth account requires --config.");
  if (!isTty(context)) {
    if (options.profile === undefined) {
      usageError("Adding a native OAuth account requires --profile when no TTY is available.");
    }
    return {
      configPath: options.config,
      profile: options.profile,
      ...(options.description === undefined ? {} : { description: options.description }),
      upstream: options.upstream ?? "default",
      makeDefault: options.makeDefault === true
    };
  }

  const line = createInterface({ input: context.input, output: context.output, terminal: true });
  try {
    const profile = options.profile ?? await prompt(line, "New account profile name");
    const description = options.description ?? await prompt(line, "Account profile description (optional)");
    const upstream = options.upstream ?? await prompt(line, "Configured upstream", "default");
    const defaultAnswer = options.makeDefault === true
      ? "yes"
      : await prompt(line, "Make this the durable default profile? (yes/no)", "no");
    if (profile === undefined || upstream === undefined || defaultAnswer === undefined) {
      usageError("Adding a native OAuth account requires a profile and configured upstream.");
    }
    const normalizedDefault = defaultAnswer.toLowerCase();
    if (normalizedDefault !== "yes" && normalizedDefault !== "y" && normalizedDefault !== "no" && normalizedDefault !== "n") {
      usageError("Answer 'yes' or 'no' when choosing the durable default profile.");
    }
    return {
      configPath: options.config,
      profile,
      ...(description === undefined ? {} : { description }),
      upstream,
      makeDefault: normalizedDefault === "yes" || normalizedDefault === "y"
    };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("Native OAuth account setup was cancelled.");
  } finally {
    line.close();
  }
}

function writeClientHandoff(
  context: InitCommandContext,
  selection: string | undefined,
  name: string,
  output: string
): void {
  if (selection === undefined) return;
  if (!isClientSelection(selection)) usageError(`Unsupported client '${selection}'.`);
  try {
    const snippets = renderClientSnippets(selection, {
      serverName: name,
      configPath: output,
      launcher: context.launcher
    });
    for (const snippet of snippets) {
      context.output.write(formatClientSnippetHandoff(snippet));
    }
    if (selection !== "claude-code" && selection !== "all") return;
    const guidance: ClaudeCodePermissionGuidance = renderClaudeCodePermissionGuidance(name, {
      delegatedAgentApproval: false
    });
    if (guidance.kind === "manual") {
      context.output.write(`${guidance.target.label}:\n${guidance.message}\n`);
      return;
    }
    context.output.write(
      `${guidance.target.label}:\n${guidance.json}\n` +
        "Manually merge this fragment into .claude/settings.local.json, .claude/settings.json, or ~/.claude/settings.json. It is client-side defense in depth; Miftah enforces authorization.\n"
    );
  } catch (error) {
    if (error instanceof ClientSnippetError) usageError(error.message);
    throw error;
  }
}

function writeFirstRunCompletion(
  context: InitCommandContext,
  selection: string | undefined,
  configPath: string
): void {
  const completion = createSetupCompletion({
    surface: "cli",
    verification: "authorization-pending",
    clientHandoff: selection === undefined ? "not-generated" : "shown",
    configPath
  });
  context.output.write(`${completion.verification.message}\n`);
  context.output.write(`${completion.clientHandoff.message}\n`);
}

/**
 * Performs endpoint-first OAuth planning before any configuration path is created.
 * It does not launch a browser, dynamically register a client, or create a credential.
 */
export async function runNativeOAuthSetup(
  options: NativeOAuthSetupOptions,
  context: InitCommandContext,
  dependencies: { readonly fetch?: FetchLike } = {}
): Promise<void> {
  if (options.config !== undefined) {
    const incompatible = ["name", "url", "output", "client"].find(
      (name) => options[name as keyof NativeOAuthSetupOptions] !== undefined
    );
    if (incompatible !== undefined) {
      usageError(`Option '--${incompatible}' cannot be combined with '--config' when adding a native OAuth account.`);
    }
    const values = await collectExistingAccountValues(options, context);
    const result = await runNativeOAuthAccountAddition({
      configPath: resolveOutputPath(values.configPath, context.cwd),
      profile: values.profile,
      ...(values.description === undefined ? {} : { description: values.description }),
      upstream: values.upstream,
      ...(values.makeDefault ? { makeDefault: true } : {})
    }, {
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
    });
    context.output.write(`OAuth discovery completed for ${result.resource}.\n`);
    context.output.write(`Added account profile '${result.profile}' to ${resolveOutputPath(values.configPath, context.cwd)}.\n`);
    context.output.write("No browser authorization, client registration, or credential was created during setup.\n");
    return;
  }
  if (options.upstream !== undefined || options.makeDefault === true) {
    usageError("Options '--upstream' and '--make-default' require '--config' when adding a native OAuth account.");
  }
  const values = await collectValues(options, context);
  const output = resolveOutputPath(values.output, context.cwd);
  const plan = await planNativeOAuthFirstRunConfiguration({
    name: values.name,
    profile: values.profile,
    ...(values.description === undefined ? {} : { description: values.description }),
    resource: values.resource
  }, dependencies);
  context.output.write(`OAuth discovery completed for ${plan.discovery.resource}.\n`);
  context.output.write(
    `Server-advertised scopes: ${plan.discovery.advertisedScopes.length === 0
      ? "none"
      : plan.discovery.advertisedScopes.join(", ")}.\n`
  );
  context.output.write("No browser authorization, client registration, or credential was created during setup.\n");

  const configuration = createSetupConfigurationPlan({ configPath: output, config: plan.config });
  await mkdir(dirname(configuration.path), { recursive: true });
  try {
    await publishSetupConfigurationPlan(configuration);
  } catch (error) {
    if (isExistingOutputError(error)) usageError(`Output '${configuration.path}' already exists.`);
    throw error;
  }
  context.output.write(`Created ${configuration.path}\n`);
  writeClientHandoff(context, values.client, plan.config.name, configuration.path);
  writeFirstRunCompletion(context, values.client, configuration.path);
}
