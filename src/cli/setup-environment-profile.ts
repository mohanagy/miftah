import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  runEnvironmentProfileAddition,
  type EnvironmentProfileAdditionReport
} from "../setup/environment-profile-onboarding.js";
import { CliUsageError, type CliOptions } from "./parse.js";
import type { InitCommandContext } from "./init.js";

export type EnvironmentProfileSetupOptions = Pick<
  CliOptions,
  "config" | "profile" | "description" | "credentialEnv" | "makeDefault"
>;

export interface EnvironmentProfileSetupResult {
  readonly configPath: string;
  readonly report: EnvironmentProfileAdditionReport;
}

interface EnvironmentProfileValues {
  readonly configPath: string;
  readonly profile: string;
  readonly description?: string;
  readonly credentialEnv: string;
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

function parseYesNo(value: string | undefined): boolean {
  switch (value?.toLowerCase()) {
    case "y":
    case "yes":
      return true;
    case "n":
    case "no":
      return false;
    default:
      usageError("Answer 'yes' or 'no' when choosing the durable default profile.");
  }
}

async function collectValues(
  options: EnvironmentProfileSetupOptions,
  context: InitCommandContext
): Promise<EnvironmentProfileValues> {
  if (options.config === undefined) usageError("Adding an environment-backed account requires --config.");
  if (!isTty(context)) {
    if (options.profile === undefined || options.credentialEnv === undefined) {
      usageError("Adding an environment-backed account requires --profile and --credential-env when no TTY is available.");
    }
    return {
      configPath: options.config,
      profile: options.profile,
      ...(options.description === undefined ? {} : { description: options.description }),
      credentialEnv: options.credentialEnv,
      makeDefault: options.makeDefault === true
    };
  }

  const line = createInterface({ input: context.input, output: context.output, terminal: true });
  try {
    const profile = options.profile ?? await prompt(line, "New account profile name");
    const description = options.description ?? await prompt(line, "Account profile description (optional)");
    const credentialEnv = options.credentialEnv ?? await prompt(
      line,
      "Environment variable that holds this account's credential"
    );
    const defaultAnswer = options.makeDefault === true
      ? "yes"
      : await prompt(line, "Make this the durable default profile? (yes/no)", "no");
    if (profile === undefined || credentialEnv === undefined || defaultAnswer === undefined) {
      usageError("Adding an environment-backed account requires a profile and environment variable name.");
    }
    return {
      configPath: options.config,
      profile,
      ...(description === undefined ? {} : { description }),
      credentialEnv,
      makeDefault: parseYesNo(defaultAnswer)
    };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("Environment-backed account setup was cancelled.");
  } finally {
    line.close();
  }
}

/**
 * Adds one static-credential account only when the existing configuration has
 * one reviewed simple environment binding. The user supplies an environment
 * variable name, not a secret value, and setup never launches the upstream.
 */
export async function runEnvironmentProfileSetup(
  options: EnvironmentProfileSetupOptions,
  context: InitCommandContext
): Promise<EnvironmentProfileSetupResult> {
  const values = await collectValues(options, context);
  if (values.profile.includes("\0")) usageError("Profile name must not contain a NUL character.");
  const configPath = resolveConfigPath(values.configPath, context.cwd);
  const report = await runEnvironmentProfileAddition({
    configPath,
    profile: values.profile,
    ...(values.description === undefined ? {} : { description: values.description }),
    credentialEnv: values.credentialEnv,
    ...(values.makeDefault ? { makeDefault: true } : {})
  });
  context.output.write(`Added environment-backed account profile '${report.profile}' to ${configPath}.\n`);
  context.output.write("Miftah saved only an environment-variable reference; it did not read or store a credential value.\n");
  if (values.makeDefault) {
    context.output.write("The durable default changed. Restart or open a new MCP client connection before expecting it to take effect.\n");
  }
  return { configPath, report };
}
