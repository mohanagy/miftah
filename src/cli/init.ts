import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { validateConfig } from "../config/validate-config.js";
import { buildPresetConfig, PresetCatalogError } from "../config/presets.js";
import type { GoogleSearchConsoleProfileOptions, PresetBuildOptions } from "../config/presets.js";
import type { MiftahConfig } from "../config/types.js";
import { getProviderAdapterForPreset } from "../config/provider-adapters.js";
import type { ProviderAdapterDefinition } from "../config/provider-adapters.js";
import {
  createSetupConfigurationPlan,
  publishSetupConfigurationPlan,
  type SetupConfigurationPlan
} from "../setup/setup-configuration.js";
import {
  CLIENT_NAMES,
  ClientSnippetError,
  renderClaudeCodePermissionGuidance,
  renderClientSnippets
} from "./client-snippets.js";
import type {
  ClaudeCodePermissionGuidance,
  ClientLauncher,
  ClientSelection,
  ClientSnippet
} from "./client-snippets.js";
import { CliUsageError } from "./parse.js";
import type { CliOptions } from "./parse.js";

export type InitCommandOptions = Pick<
  CliOptions,
  | "name"
  | "preset"
  | "output"
  | "interactive"
  | "client"
  | "credentialEnv"
  | "npmPackage"
  | "dockerImage"
  | "url"
  | "headerName"
  | "headerPrefix"
  | "oauthClientSecretsFile"
> & Pick<PresetBuildOptions, "googleSearchConsoleProfiles" | "defaultProfile">;

export interface InitCommandContext {
  readonly input: Readable & { readonly isTTY?: boolean };
  readonly output: Writable & { readonly isTTY?: boolean };
  readonly cwd: string;
  readonly launcher: ClientLauncher;
}

interface InitValues extends PresetBuildOptions {
  readonly name: string;
  readonly preset: string;
  readonly output: string;
  readonly client?: string;
}

interface InitPlan {
  readonly output: string;
  readonly configuration: SetupConfigurationPlan;
  readonly snippets: readonly ClientSnippet[];
  readonly claudeCodePermissionGuidance?: ClaudeCodePermissionGuidance;
  readonly providerAdapter?: ProviderAdapterDefinition;
}

interface Cancellation {
  readonly promise: Promise<never>;
  dispose(): void;
}

type PromptInterface = ReturnType<typeof createInterface>;

function usageError(message: string): never {
  throw new CliUsageError(message);
}

function isTty(context: InitCommandContext): boolean {
  return context.input.isTTY === true && context.output.isTTY === true;
}

function createCancellation(line: PromptInterface): Cancellation {
  let rejectCancellation: (reason: CliUsageError) => void = () => undefined;
  let cancelled = false;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  void promise.catch(() => undefined);
  const cancel = (message: string) => {
    if (cancelled) return;
    cancelled = true;
    rejectCancellation(new CliUsageError(message));
  };
  const onClose = () => cancel("Interactive init was cancelled because input closed.");
  const onSigint = () => cancel("Interactive init was cancelled.");

  line.once("close", onClose);
  line.once("SIGINT", onSigint);

  return {
    promise,
    dispose() {
      cancelled = true;
      line.removeListener("close", onClose);
      line.removeListener("SIGINT", onSigint);
    }
  };
}

async function prompt(
  line: PromptInterface,
  cancellation: Cancellation,
  label: string,
  defaultValue?: string,
  preserveTrailingWhitespace = false
): Promise<string | undefined> {
  const suffix = defaultValue === undefined ? ": " : ` [${defaultValue}]: `;
  const answer = await Promise.race([line.question(`${label}${suffix}`), cancellation.promise]);
  const value = preserveTrailingWhitespace ? answer.trimStart() : answer.trim();
  return value === "" ? defaultValue : value;
}

async function collectStreamableOptions(
  line: PromptInterface,
  cancellation: Cancellation,
  options: InitCommandOptions
): Promise<PresetBuildOptions> {
  const url = options.url ?? (await prompt(line, cancellation, "Streamable HTTPS URL"));
  const credentialEnv = options.credentialEnv ?? (await prompt(line, cancellation, "Credential environment variable name (optional)"));
  if (credentialEnv === undefined) {
    return {
      url,
      headerName: options.headerName,
      headerPrefix: options.headerPrefix
    };
  }

  return {
    url,
    credentialEnv,
    headerName: options.headerName ?? (await prompt(line, cancellation, "Credential header name")),
    headerPrefix: options.headerPrefix ?? (await prompt(
      line,
      cancellation,
      "Credential header prefix (optional)",
      undefined,
      true
    ))
  };
}

function parseAdditionalGoogleSearchConsoleAccount(value: string | undefined): boolean {
  switch (value?.toLowerCase()) {
    case "y":
    case "yes":
      return true;
    case "n":
    case "no":
      return false;
    default:
      usageError("Answer 'yes' or 'no' when asked to add another Google Search Console account.");
  }
}

async function collectGoogleSearchConsoleOptions(
  line: PromptInterface,
  cancellation: Cancellation,
  options: InitCommandOptions
): Promise<PresetBuildOptions> {
  if (options.googleSearchConsoleProfiles !== undefined) {
    return {
      oauthClientSecretsFile: options.oauthClientSecretsFile,
      googleSearchConsoleProfiles: options.googleSearchConsoleProfiles,
      defaultProfile: options.defaultProfile
    };
  }

  const googleSearchConsoleProfiles: GoogleSearchConsoleProfileOptions[] = [];
  do {
    const name = await prompt(
      line,
      cancellation,
      "Google account profile name",
      googleSearchConsoleProfiles.length === 0 ? "google-account-1" : undefined
    );
    const description = await prompt(line, cancellation, "Google account description (optional)");
    const oauthClientSecretsFile = options.oauthClientSecretsFile ?? (await prompt(
      line,
      cancellation,
      "Google OAuth client-secrets file (absolute path)"
    ));
    if (name === undefined || oauthClientSecretsFile === undefined) {
      usageError("Google Search Console setup requires a profile name and OAuth client-secrets file.");
    }
    googleSearchConsoleProfiles.push({
      name,
      ...(description === undefined ? {} : { description }),
      oauthClientSecretsFile
    });
  } while (parseAdditionalGoogleSearchConsoleAccount(await prompt(
    line,
    cancellation,
    "Add another Google account? (yes/no)",
    "no"
  )));

  const defaultProfile = options.defaultProfile ?? (await prompt(
    line,
    cancellation,
    "Default Google account profile",
    googleSearchConsoleProfiles[0]?.name
  ));
  if (defaultProfile === undefined) {
    usageError("Google Search Console setup requires an explicit default profile.");
  }
  return { googleSearchConsoleProfiles, defaultProfile };
}

async function collectPresetOptions(
  line: PromptInterface,
  cancellation: Cancellation,
  preset: string,
  options: InitCommandOptions
): Promise<PresetBuildOptions> {
  switch (preset) {
    case "google-search-console":
      return collectGoogleSearchConsoleOptions(line, cancellation, options);
    case "generic-npx":
      return {
        credentialEnv: options.credentialEnv,
        npmPackage: options.npmPackage ?? (await prompt(line, cancellation, "NPM package (exact package@semver)"))
      };
    case "generic-docker":
      return {
        credentialEnv: options.credentialEnv,
        dockerImage: options.dockerImage ?? (await prompt(line, cancellation, "Docker image (digest-pinned)"))
      };
    case "streamable-http":
      return collectStreamableOptions(line, cancellation, options);
    default:
      return {
        credentialEnv: options.credentialEnv,
        npmPackage: options.npmPackage,
        dockerImage: options.dockerImage,
        url: options.url,
        headerName: options.headerName,
        headerPrefix: options.headerPrefix,
        oauthClientSecretsFile: options.oauthClientSecretsFile
      };
  }
}

async function collectInteractiveValues(options: InitCommandOptions, context: InitCommandContext): Promise<InitValues> {
  if (!isTty(context)) {
    usageError("Option '--interactive' requires TTY input and output.");
  }

  const line = createInterface({ input: context.input, output: context.output, terminal: true });
  const cancellation = createCancellation(line);
  try {
    const name = options.name ?? (await prompt(line, cancellation, "Name", "miftah-wrapper"));
    const preset = options.preset ?? (await prompt(line, cancellation, "Catalog preset", "generic"));
    const presetOptions = await collectPresetOptions(line, cancellation, preset ?? "generic", options);
    const output = options.output ?? (await prompt(line, cancellation, "Output location", `${name}.miftah.json`));
    const client = options.client ?? (await prompt(
      line,
      cancellation,
      "Client (claude-desktop, claude-code, cursor, vscode, all; blank for config only)"
    ));

    if (name === undefined || preset === undefined || output === undefined) {
      usageError("Interactive init requires a name, preset, and output location.");
    }
    return { name, preset, output, client, ...presetOptions };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("Interactive init was cancelled.");
  } finally {
    cancellation.dispose();
    line.close();
  }
}

function nonInteractiveValues(options: InitCommandOptions): InitValues {
  const name = options.name ?? "miftah-wrapper";
  return {
    name,
    preset: options.preset ?? "generic",
    output: options.output ?? `${name}.miftah.json`,
    client: options.client,
    credentialEnv: options.credentialEnv,
    npmPackage: options.npmPackage,
    dockerImage: options.dockerImage,
    url: options.url,
    headerName: options.headerName,
    headerPrefix: options.headerPrefix,
    oauthClientSecretsFile: options.oauthClientSecretsFile,
    googleSearchConsoleProfiles: options.googleSearchConsoleProfiles,
    defaultProfile: options.defaultProfile
  };
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

/** Resolves user input into a validated, side-effect-free plan for `miftah init`. */
function buildInitPlan(values: InitValues, context: InitCommandContext): InitPlan {
  const output = resolveOutputPath(values.output, context.cwd);
  if (values.client !== undefined && !isClientSelection(values.client)) {
    usageError(`Unsupported client '${values.client}'.`);
  }

  let config: MiftahConfig;
  try {
    config = buildPresetConfig(values.name, values.preset, {
      credentialEnv: values.credentialEnv,
      npmPackage: values.npmPackage,
      dockerImage: values.dockerImage,
      url: values.url,
      headerName: values.headerName,
      headerPrefix: values.headerPrefix,
      oauthClientSecretsFile: values.oauthClientSecretsFile,
      googleSearchConsoleProfiles: values.googleSearchConsoleProfiles,
      defaultProfile: values.defaultProfile
    }, {
      configurationPath: output
    });
    validateConfig(config);
  } catch (error) {
    if (error instanceof PresetCatalogError) throw new CliUsageError(error.message);
    if (error instanceof Error) throw new CliUsageError(`Invalid init configuration: ${error.message}`);
    throw error;
  }

  let snippets: ClientSnippet[] = [];
  let claudeCodePermissionGuidance: ClaudeCodePermissionGuidance | undefined;
  if (values.client !== undefined) {
    try {
      snippets = renderClientSnippets(values.client, {
        serverName: config.name,
        configPath: output,
        launcher: context.launcher
      });
    } catch (error) {
      if (error instanceof ClientSnippetError) throw new CliUsageError(error.message);
      throw error;
    }
    if (values.client === "claude-code" || values.client === "all") {
      claudeCodePermissionGuidance = renderClaudeCodePermissionGuidance(config.name, {
        delegatedAgentApproval: config.security?.approvalMode === "delegated-agent"
      });
    }
  }

  return {
    output,
    configuration: createSetupConfigurationPlan({ configPath: output, config }),
    snippets,
    claudeCodePermissionGuidance,
    providerAdapter: getProviderAdapterForPreset(values.preset)
  };
}

function writeProviderAdapterGuidance(output: Writable, adapter: ProviderAdapterDefinition | undefined): void {
  if (adapter === undefined) return;
  const reauth = adapter.lifecycle.reauth;
  const reauthDescription = reauth.mechanism === "mcp-tool"
    ? `${reauth.owner} MCP tool '${reauth.name}'`
    : reauth.owner;
  const tokenCacheBoundary = adapter.authentication.tokenStore === "upstream-private"
    ? "Miftah will not read or manage the upstream token cache.\n"
    : "";
  output.write(
    `Provider adapter: ${adapter.displayName}\n` +
      `Credential ownership: ${adapter.authentication.credentialOwnership}\n` +
      `Browser handoff: ${adapter.authentication.browserHandoff}\n` +
      `Token store: ${adapter.authentication.tokenStore}\n` +
      `Identity evidence: ${adapter.identity.evidence}\n` +
      `Reauthentication: ${reauthDescription}\n` +
      `Disconnect/revocation: ${adapter.lifecycle.disconnect.owner}\n` +
      tokenCacheBoundary
  );
}

/** Writes copy-paste client configuration and optional Claude Code review guidance without modifying client settings. */
function writeSnippets(
  output: Writable,
  snippets: readonly ClientSnippet[],
  claudeCodePermissionGuidance: ClaudeCodePermissionGuidance | undefined
): void {
  for (const snippet of snippets) {
    output.write(`${snippet.target.label} (${snippet.client}):\n${snippet.json}\n`);
  }
  if (claudeCodePermissionGuidance === undefined) return;
  if (claudeCodePermissionGuidance.kind === "manual") {
    output.write(`${claudeCodePermissionGuidance.target.label}:\n${claudeCodePermissionGuidance.message}\n`);
    return;
  }
  output.write(
    `${claudeCodePermissionGuidance.target.label}:\n${claudeCodePermissionGuidance.json}\n` +
      "Manually merge this fragment into .claude/settings.local.json, .claude/settings.json, or ~/.claude/settings.json. It is client-side defense in depth; Miftah enforces authorization.\n"
  );
}

/** Creates a strict catalog config and optionally prints copy-paste client snippets. */
export async function runInitCommand(options: InitCommandOptions, context: InitCommandContext): Promise<void> {
  const values = options.interactive === true
    ? await collectInteractiveValues(options, context)
    : nonInteractiveValues(options);
  const plan = buildInitPlan(values, context);

  await mkdir(dirname(plan.output), { recursive: true });
  try {
    await publishSetupConfigurationPlan(plan.configuration);
  } catch (error) {
    if (isExistingOutputError(error)) {
      usageError(`Output '${plan.output}' already exists.`);
    }
    throw error;
  }
  context.output.write(`Created ${plan.output}\n`);
  writeProviderAdapterGuidance(context.output, plan.providerAdapter);
  writeSnippets(context.output, plan.snippets, plan.claudeCodePermissionGuidance);
}
