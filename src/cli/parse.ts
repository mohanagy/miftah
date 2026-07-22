type ValueOptionName =
  | "config"
  | "profile"
  | "output"
  | "preset"
  | "name"
  | "client"
  | "credentialEnv"
  | "npmPackage"
  | "dockerImage"
  | "url"
  | "headerName"
  | "headerPrefix"
  | "transport"
  | "connection"
  | "upstream"
  | "issuer"
  | "clientRegistration"
  | "scopes";
type BooleanOptionName = "follow" | "json" | "interactive" | "includeArguments" | "write" | "nonInteractive";
type CliOptionName = ValueOptionName | BooleanOptionName;

export interface CliOptions {
  readonly config?: string;
  readonly profile?: string;
  readonly output?: string;
  readonly preset?: string;
  readonly name?: string;
  readonly client?: string;
  readonly credentialEnv?: string;
  readonly npmPackage?: string;
  readonly dockerImage?: string;
  readonly url?: string;
  readonly headerName?: string;
  readonly headerPrefix?: string;
  readonly transport?: "stdio" | "http";
  readonly connection?: string;
  readonly upstream?: string;
  readonly issuer?: string;
  readonly clientRegistration?: string;
  readonly scopes?: readonly string[];
  readonly follow?: true;
  readonly json?: true;
  readonly interactive?: true;
  readonly includeArguments?: true;
  readonly write?: true;
  readonly nonInteractive?: true;
}

interface CliCommandMetadata {
  readonly description: string;
  readonly arguments?: string;
  readonly options: readonly CliOptionName[];
}

export const CLI_COMMANDS = {
  serve: {
    description: "Start the MCP wrapper server.",
    options: ["config", "transport"]
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
    options: [
      "name",
      "preset",
      "output",
      "interactive",
      "client",
      "credentialEnv",
      "npmPackage",
      "dockerImage",
      "url",
      "headerName",
      "headerPrefix"
    ]
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
  "audit-export": {
    description: "Write a redacted audit journal export for support review.",
    options: ["config", "output", "includeArguments"]
  },
  "audit-verify": {
    description: "Verify retained audit journal integrity chains.",
    options: ["config", "json"]
  },
  "migrate-config": {
    description: "Plan or explicitly apply a safe configuration migration.",
    options: ["config", "write"]
  },
  "connection add": {
    description: "Plan or add an OAuth connection to an existing profile and upstream.",
    options: ["config", "connection", "profile", "upstream", "issuer", "clientRegistration", "scopes", "write"]
  },
  "connection list": {
    description: "List configured OAuth connections and optional client snippets.",
    options: ["config", "client"]
  },
  "connection status": {
    description: "Show redacted OAuth credential and verified-identity state.",
    options: ["config", "connection", "profile", "upstream"]
  },
  "connection test": {
    description: "Test one OAuth-backed upstream without opening a browser.",
    options: ["config", "connection", "profile", "upstream"]
  },
  "auth connect": {
    description: "Authorize one configured OAuth connection.",
    options: ["config", "connection", "profile", "upstream", "nonInteractive"]
  },
  "auth reauth": {
    description: "Replace one OAuth credential through a fresh authorization flow.",
    options: ["config", "connection", "profile", "upstream", "nonInteractive"]
  },
  "auth disconnect": {
    description: "Remove one OAuth credential from the native OS vault.",
    options: ["config", "connection", "profile", "upstream"]
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
  client: {
    name: "client",
    takesValue: true,
    usage: "--client <claude-desktop|claude-code|cursor|vscode|all>",
    description: "Print client configuration snippets."
  },
  credentialEnv: {
    name: "credentialEnv",
    takesValue: true,
    usage: "--credential-env <name>",
    description: "Environment variable name for a credential reference."
  },
  npmPackage: {
    name: "npmPackage",
    takesValue: true,
    usage: "--npm-package <package>",
    description: "Exact npm package spec for the generic-npx preset."
  },
  dockerImage: {
    name: "dockerImage",
    takesValue: true,
    usage: "--docker-image <image>",
    description: "Digest-pinned Docker image for the generic-docker preset."
  },
  url: {
    name: "url",
    takesValue: true,
    usage: "--url <url>",
    description: "HTTPS URL for the streamable-http preset."
  },
  headerName: {
    name: "headerName",
    takesValue: true,
    usage: "--header-name <name>",
    description: "Credential header name for the streamable-http preset."
  },
  headerPrefix: {
    name: "headerPrefix",
    takesValue: true,
    usage: "--header-prefix <prefix>",
    description: "Credential header prefix for the streamable-http preset."
  },
  transport: {
    name: "transport",
    takesValue: true,
    usage: "--transport <stdio|http>",
    description: "MCP transport for serve."
  },
  connection: {
    name: "connection",
    takesValue: true,
    usage: "--connection <ref>",
    description: "Opaque OAuth connection reference."
  },
  upstream: {
    name: "upstream",
    takesValue: true,
    usage: "--upstream <name>",
    description: "Named upstream, or 'default' for a singleton upstream."
  },
  issuer: {
    name: "issuer",
    takesValue: true,
    usage: "--issuer <url>",
    description: "Exact HTTPS OAuth issuer identifier."
  },
  clientRegistration: {
    name: "clientRegistration",
    takesValue: true,
    usage: "--client-registration <mode>",
    description: "Approved client registration mode or identifier."
  },
  scopes: {
    name: "scopes",
    takesValue: true,
    usage: "--scope <scope>",
    description: "Least-privilege OAuth scope; repeat for multiple scopes."
  },
  follow: {
    name: "follow",
    takesValue: false,
    usage: "--follow",
    description: "Continue reading audit logs as they are appended or rotated."
  },
  includeArguments: {
    name: "includeArguments",
    takesValue: false,
    usage: "--include-arguments",
    description: "Include stored audit arguments after redaction."
  },
  json: {
    name: "json",
    takesValue: false,
    usage: "--json",
    description: "Use machine-readable output when supported."
  },
  interactive: {
    name: "interactive",
    takesValue: false,
    usage: "--interactive",
    description: "Collect init settings through a TTY wizard."
  },
  write: {
    name: "write",
    takesValue: false,
    usage: "--write",
    description: "Apply the migration after creating a non-overwriteable backup."
  },
  nonInteractive: {
    name: "nonInteractive",
    takesValue: false,
    usage: "--non-interactive",
    description: "Return a typed diagnostic instead of opening a browser."
  }
};

const FLAG_DEFINITIONS: Record<string, CliOptionDefinition | "help" | "version"> = {
  "--config": OPTION_DEFINITIONS.config,
  "--profile": OPTION_DEFINITIONS.profile,
  "--output": OPTION_DEFINITIONS.output,
  "--preset": OPTION_DEFINITIONS.preset,
  "--name": OPTION_DEFINITIONS.name,
  "--client": OPTION_DEFINITIONS.client,
  "--credential-env": OPTION_DEFINITIONS.credentialEnv,
  "--npm-package": OPTION_DEFINITIONS.npmPackage,
  "--docker-image": OPTION_DEFINITIONS.dockerImage,
  "--url": OPTION_DEFINITIONS.url,
  "--header-name": OPTION_DEFINITIONS.headerName,
  "--header-prefix": OPTION_DEFINITIONS.headerPrefix,
  "--transport": OPTION_DEFINITIONS.transport,
  "--connection": OPTION_DEFINITIONS.connection,
  "--upstream": OPTION_DEFINITIONS.upstream,
  "--issuer": OPTION_DEFINITIONS.issuer,
  "--client-registration": OPTION_DEFINITIONS.clientRegistration,
  "--scope": OPTION_DEFINITIONS.scopes,
  "--follow": OPTION_DEFINITIONS.follow,
  "--include-arguments": OPTION_DEFINITIONS.includeArguments,
  "--json": OPTION_DEFINITIONS.json,
  "--interactive": OPTION_DEFINITIONS.interactive,
  "--write": OPTION_DEFINITIONS.write,
  "--non-interactive": OPTION_DEFINITIONS.nonInteractive,
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
  if (name === "scopes") {
    const existing = options.scopes;
    options.scopes = [...(Array.isArray(existing) ? existing : []), value];
    return;
  }
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
  return `  ${definition.usage.padEnd(Math.max(20, definition.usage.length + 2))}${definition.description}`;
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
  if (
    command === "serve" &&
    options.transport !== undefined &&
    options.transport !== "stdio" &&
    options.transport !== "http"
  ) {
    usageError("Option '--transport' must be either 'stdio' or 'http'.");
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
  let commandGroup: "connection" | "auth" | undefined;
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
      if (commandGroup === undefined && (token === "connection" || token === "auth")) {
        commandGroup = token;
        continue;
      }
      const candidate = commandGroup === undefined ? token : `${commandGroup} ${token}`;
      if (!isCliCommand(candidate)) usageError(`Unknown command '${candidate}'.`);
      command = candidate;
      commandGroup = undefined;
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
  if (commandGroup !== undefined) usageError(`Command '${commandGroup}' requires a subcommand.`);
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
