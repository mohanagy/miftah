import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  runProviderAccountAddition,
  type ProviderAccountAdditionReport
} from "../setup/provider-account-onboarding.js";
import { CliUsageError, type CliOptions } from "./parse.js";
import type { InitCommandContext } from "./init.js";

export type ProviderAccountSetupOptions = Pick<
  CliOptions,
  "config" | "profile" | "description" | "oauthClientSecretsFile" | "makeDefault"
>;

export interface ProviderAccountSetupResult {
  readonly configPath: string;
  readonly report: ProviderAccountAdditionReport;
}

interface ProviderAccountValues {
  readonly configPath: string;
  readonly profile: string;
  readonly description?: string;
  readonly credentialFile: string;
  readonly makeDefault: boolean;
}

function usageError(message: string): never {
  throw new CliUsageError(message);
}

function isTty(context: InitCommandContext): boolean {
  return context.input.isTTY === true && context.output.isTTY === true;
}

function resolveConfigPath(configPath: string, cwd: string): string {
  if (configPath.includes("\0")) usageError("Configuration path must not contain a NUL character.");
  return resolve(cwd, configPath);
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
  options: ProviderAccountSetupOptions,
  context: InitCommandContext
): Promise<ProviderAccountValues> {
  if (options.config === undefined) usageError("Adding a provider-owned account requires --config.");
  if (!isTty(context)) {
    if (options.profile === undefined || options.oauthClientSecretsFile === undefined) {
      usageError("Adding a provider-owned account requires --profile and --oauth-client-secrets-file when no TTY is available.");
    }
    return {
      configPath: options.config,
      profile: options.profile,
      ...(options.description === undefined ? {} : { description: options.description }),
      credentialFile: options.oauthClientSecretsFile,
      makeDefault: options.makeDefault === true
    };
  }

  const line = createInterface({ input: context.input, output: context.output, terminal: true });
  try {
    const profile = options.profile ?? await prompt(line, "New account profile name");
    const description = options.description ?? await prompt(line, "Account profile description (optional)");
    const credentialFile = options.oauthClientSecretsFile ?? await prompt(line, "Provider credential-file path (absolute)");
    const defaultAnswer = options.makeDefault === true
      ? "yes"
      : await prompt(line, "Make this the durable default profile? (yes/no)", "no");
    if (profile === undefined || credentialFile === undefined || defaultAnswer === undefined) {
      usageError("Adding a provider-owned account requires a profile and credential-file path.");
    }
    const normalizedDefault = defaultAnswer.toLowerCase();
    if (normalizedDefault !== "yes" && normalizedDefault !== "y" && normalizedDefault !== "no" && normalizedDefault !== "n") {
      usageError("Answer 'yes' or 'no' when choosing the durable default profile.");
    }
    return {
      configPath: options.config,
      profile,
      ...(description === undefined ? {} : { description }),
      credentialFile,
      makeDefault: normalizedDefault === "yes" || normalizedDefault === "y"
    };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("Provider-owned account setup was cancelled.");
  } finally {
    line.close();
  }
}

/**
 * Adds one account only after the existing configuration proves it is wholly
 * inside a reviewed provider adapter. It never opens a browser or reads the
 * adapter-owned token cache; the provider performs its own login on readiness.
 */
export async function runProviderAccountSetup(
  options: ProviderAccountSetupOptions,
  context: InitCommandContext
): Promise<ProviderAccountSetupResult> {
  const values = await collectValues(options, context);
  const configPath = resolveConfigPath(values.configPath, context.cwd);
  const report = await runProviderAccountAddition({
    configPath,
    profile: values.profile,
    ...(values.description === undefined ? {} : { description: values.description }),
    credentialFile: values.credentialFile,
    ...(values.makeDefault ? { makeDefault: true } : {})
  });
  context.output.write(`Added provider-owned account profile '${report.profile}' to ${configPath}.\n`);
  context.output.write(
    `${report.adapter} owns browser login and its private token cache; Miftah did not read, copy, or delete that cache.\n`
  );
  if (values.makeDefault) {
    context.output.write("The durable default changed. Restart or open a new MCP client connection before expecting it to take effect.\n");
  }
  return { configPath, report };
}
