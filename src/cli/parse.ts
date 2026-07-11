type ValueOptionName = "config" | "profile" | "output" | "preset" | "name";
type BooleanOptionName = "follow" | "json";
type CliOptionName = ValueOptionName | BooleanOptionName;

export interface CliOptions {
  readonly config?: string;
  readonly profile?: string;
  readonly output?: string;
  readonly preset?: string;
  readonly name?: string;
  readonly follow?: true;
  readonly json?: true;
}

interface CliCommandMetadata {
  readonly description: string;
  readonly arguments?: string;
  readonly options: readonly CliOptionName[];
}

export const CLI_COMMANDS = {
  serve: {
    description: "Start the MCP wrapper server.",
    options: ["config"]
  },
  validate: {
    description: "Validate a Miftah configuration.",
    options: ["config"]
  },
  doctor: {
    description: "Check configuration and upstream readiness.",
    options: ["config", "json"]
  },
  schema: {
    description: "Print the Miftah JSON schema.",
    options: []
  },
  init: {
    description: "Create a starter Miftah configuration.",
    arguments: "[name]",
    options: ["name", "preset", "output"]
  },
  "list-tools": {
    description: "List tools available for a profile.",
    options: ["config", "profile"]
  },
  "test-profile": {
    description: "Test an upstream profile.",
    options: ["config", "profile"]
  },
  logs: {
    description: "Print configured audit logs.",
    options: ["config", "follow"]
  },
  version: {
    description: "Print the Miftah version.",
    options: ["json"]
  }
} as const satisfies Record<string, CliCommandMetadata>;

export type CliCommand = keyof typeof CLI_COMMANDS;

export type CliInvocation =
  | { readonly kind: "help"; readonly command?: CliCommand }
  | { readonly kind: "version"; readonly json: boolean }
  | { readonly kind: "run"; readonly command: Exclude<CliCommand, "version">; readonly options: CliOptions };

type ValueOptionDefinition = {
  readonly name: ValueOptionName;
  readonly takesValue: true;
  readonly usage: string;
  readonly description: string;
};

type BooleanOptionDefinition = {
  readonly name: BooleanOptionName;
  readonly takesValue: false;
  readonly usage: string;
  readonly description: string;
};

type CliOptionDefinition = ValueOptionDefinition | BooleanOptionDefinition;

const OPTION_DEFINITIONS: Record<CliOptionName, CliOptionDefinition> = {
  config: {
    name: "config",
    takesValue: true,
    usage: "--config <file>",
    description: "Configuration file."
  },
  profile: {
    name: "profile",
    takesValue: true,
    usage: "--profile <name>",
    description: "Profile name."
  },
  output: {
    name: "output",
    takesValue: true,
    usage: "--output <file>",
    description: "Output configuration file."
  },
  preset: {
    name: "preset",
    takesValue: true,
    usage: "--preset <name>",
    description: "Starter configuration preset."
  },
  name: {
    name: "name",
    takesValue: true,
    usage: "--name <name>",
    description: "Configuration name."
  },
  follow: {
    name: "follow",
    takesValue: false,
    usage: "--follow",
    description: "Read audit logs as requested."
  },
  json: {
    name: "json",
    takesValue: false,
    usage: "--json",
    description: "Use machine-readable output when supported."
  }
};

const FLAG_DEFINITIONS: Record<string, CliOptionDefinition | "help" | "version"> = {
  "--config": OPTION_DEFINITIONS.config,
  "--profile": OPTION_DEFINITIONS.profile,
  "--output": OPTION_DEFINITIONS.output,
  "--preset": OPTION_DEFINITIONS.preset,
  "--name": OPTION_DEFINITIONS.name,
  "--follow": OPTION_DEFINITIONS.follow,
  "--json": OPTION_DEFINITIONS.json,
  "--help": "help",
  "-h": "help",
  "--version": "version",
  "-v": "version"
};

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function usageError(message: string): never {
  throw new CliUsageError(message);
}

function isCliCommand(value: string): value is CliCommand {
  return Object.hasOwn(CLI_COMMANDS, value);
}

function setValueOption(options: { [name: string]: unknown }, name: ValueOptionName, value: string): void {
  if (options[name] !== undefined) usageError(`Duplicate option '--${name}'.`);
  options[name] = value;
}

function setBooleanOption(options: { [name: string]: unknown }, name: BooleanOptionName): void {
  if (options[name] !== undefined) usageError(`Duplicate option '--${name}'.`);
  options[name] = true;
}

function allowedOptions(command: CliCommand): ReadonlySet<CliOptionName> {
  return new Set(CLI_COMMANDS[command].options);
}

function formatOption(definition: CliOptionDefinition): string {
  return `  ${definition.usage.padEnd(20)}${definition.description}`;
}

function commandUsage(command: CliCommand): string {
  const metadata: CliCommandMetadata = CLI_COMMANDS[command];
  return `miftah ${command}${metadata.arguments ? ` ${metadata.arguments}` : ""} [options]`;
}

export function renderRootHelp(): string {
  const commandLines = Object.entries(CLI_COMMANDS).map(([command, metadata]) => {
    const commandMetadata: CliCommandMetadata = metadata;
    const suffix = commandMetadata.arguments ? ` ${commandMetadata.arguments}` : "";
    return `  ${(command + suffix).padEnd(24)}${commandMetadata.description}`;
  });

  return [
    "Usage: miftah [command] [options]",
    "",
    "Commands:",
    ...commandLines,
    "",
    "Global options:",
    "  -h, --help              Show help.",
    "  -v, --version           Show the version."
  ].join("\n");
}

export function renderCommandHelp(command: CliCommand): string {
  const options = CLI_COMMANDS[command].options.map((name) => formatOption(OPTION_DEFINITIONS[name]));

  return [
    `Usage: ${commandUsage(command)}`,
    "",
    CLI_COMMANDS[command].description,
    "",
    "Options:",
    ...options,
    "  -h, --help            Show help."
  ].join("\n");
}

function validateCommandOptions(command: CliCommand, options: CliOptions): void {
  const allowed = allowedOptions(command);
  for (const name of Object.keys(options) as CliOptionName[]) {
    if (!allowed.has(name)) {
      usageError(`Option '--${name}' is not valid for command '${command}'.`);
    }
  }
}

function parseFlag(token: string): { readonly flag: string; readonly assignedValue?: string } {
  const equalsIndex = token.indexOf("=");
  return equalsIndex === -1
    ? { flag: token }
    : { flag: token.slice(0, equalsIndex), assignedValue: token.slice(equalsIndex + 1) };
}

export function parseCli(argv: readonly string[]): CliInvocation {
  const options: { [name: string]: unknown } = {};
  let command: CliCommand | undefined;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (token.startsWith("-")) {
      const { flag, assignedValue } = parseFlag(token);
      const definition = FLAG_DEFINITIONS[flag];
      if (definition === undefined) usageError(`Unknown option '${flag}'.`);
      if (definition === "help" || definition === "version") {
        if (assignedValue !== undefined) usageError(`Option '${flag}' does not take a value.`);
        if (definition === "help") {
          if (help) usageError("Duplicate option '--help'.");
          help = true;
        } else {
          if (version) usageError("Duplicate option '--version'.");
          version = true;
        }
        continue;
      }

      if (!definition.takesValue) {
        if (assignedValue !== undefined) usageError(`Option '${flag}' does not take a value.`);
        setBooleanOption(options, definition.name);
        continue;
      }

      const value = assignedValue ?? argv[++index];
      if (value === undefined || (assignedValue === undefined && value.startsWith("-"))) {
        usageError(`Option '${flag}' requires a value.`);
      }
      if (value.length === 0) usageError(`Option '${flag}' requires a value.`);
      setValueOption(options, definition.name, value);
      continue;
    }

    if (command === undefined) {
      if (!isCliCommand(token)) usageError(`Unknown command '${token}'.`);
      command = token;
      continue;
    }

    if (command === "init" && options.name === undefined) {
      options.name = token;
      continue;
    }
    if (command === "init") usageError("The init command accepts only one name.");
    usageError(`Unexpected positional argument '${token}'.`);
  }

  if (help && version) usageError("Options '--help' and '--version' cannot be combined.");
  if (version) {
    if (command !== undefined) usageError("Option '--version' cannot be combined with a command.");
    for (const name of Object.keys(options) as CliOptionName[]) {
      if (name !== "json") usageError(`Option '--${name}' is not valid with '--version'.`);
    }
    return { kind: "version", json: options.json === true };
  }

  const effectiveCommand = command ?? "serve";
  const typedOptions = options as CliOptions;
  validateCommandOptions(effectiveCommand, typedOptions);

  if (help) {
    return command === undefined && Object.keys(options).length === 0
      ? { kind: "help" }
      : { kind: "help", command: effectiveCommand };
  }
  if (effectiveCommand === "version") return { kind: "version", json: typedOptions.json === true };

  return { kind: "run", command: effectiveCommand, options: typedOptions };
}
