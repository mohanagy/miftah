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

function resolveConfigPath(configPath: string, cwd: string): string {
  if (configPath.includes("\0")) usageError("Configuration path must not contain a NUL character.");
  return resolve(cwd, configPath);
}

async function prompt(
  line: PromptInterface,
  cancellation: Cancellation,
  label: string,
  defaultValue?: string
): Promise<string | undefined> {
  const suffix = defaultValue === undefined ? ": " : ` [${defaultValue}]: `;
  const answer = (await Promise.race([line.question(`${label}${suffix}`), cancellation.promise])).trim();
  return answer.length === 0 ? defaultValue : answer;
}

function createCancellation(line: PromptInterface): Cancellation {
  let rejectCancellation: (reason: CliUsageError) => void = () => undefined;
  let cancelled = false;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  void promise.catch(() => undefined);
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    rejectCancellation(new CliUsageError("Environment-backed account setup was cancelled."));
  };
  line.once("close", cancel);
  line.once("SIGINT", cancel);

  return {
    promise,
    dispose() {
      cancelled = true;
      line.removeListener("close", cancel);
      line.removeListener("SIGINT", cancel);
    }
  };
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
  const cancellation = createCancellation(line);
  try {
    const profile = options.profile ?? await prompt(line, cancellation, "New account profile name");
    const description = options.description ?? await prompt(line, cancellation, "Account profile description (optional)");
    const credentialEnv = options.credentialEnv ?? await prompt(
      line,
      cancellation,
      "Environment variable that holds this account's credential"
    );
    const defaultAnswer = options.makeDefault === true
      ? "yes"
      : await prompt(line, cancellation, "Make this the durable default profile? (yes/no)", "no");
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
    cancellation.dispose();
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
  for (const action of report.actions) context.output.write(`${action}\n`);
  context.output.write("Miftah saved only an environment-variable reference; it did not read or store a credential value.\n");
  if (values.makeDefault) {
    context.output.write("The durable default changed. Restart or open a new MCP client connection before expecting it to take effect.\n");
  }
  return { configPath, report };
}
