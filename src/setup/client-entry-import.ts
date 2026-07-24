import { isAbsolute } from "node:path";
import { buildPresetConfig, PresetCatalogError } from "../config/presets.js";
import type { MiftahConfig } from "../config/types.js";
import { validateConfig } from "../config/validate-config.js";

const maximumDocumentBytes = 64 * 1024;
const shellMetacharacter = /[|&;<>`]/u;
const credentialFlag = /^(?:-(?:H|b|u).*$|--?(?:access[-_]?key|access[-_]?token|api[-_]?key|auth(?:orization)?|bearer|client[-_]?secret|cookie|credential(?:s)?|env(?:ironment)?|headers?|jwt|key|pass|password|passwd|private[-_]?key|secret|sig(?:nature)?|token|user)(?:=.*)?)$/iu;
const credentialOptionName = /(?:^|[-_])(?:access[-_]?key|access[-_]?token|api[-_]?key|auth(?:orization)?|bearer|client[-_]?secret|cookie|credential(?:s)?|env(?:ironment)?|headers?|jwt|key|pass|password|passwd|private[-_]?key|secret|sig(?:nature)?|token|user)(?:$|[-_])/iu;
const credentialValue = /^(?:(?:(?:proxy-)?authorization|cookie|(?:x-)?api[-_]?key|x[-_]?access[-_]?token|x[-_]?auth(?:orization)?)\s*:\s*\S+|(?:basic|bearer|jwt|token)\s+\S+)$/iu;
const credentialAssignment = /(?:^|[^A-Za-z0-9])(?:access[-_]?key|access[-_]?token|api[-_]?key|auth(?:orization)?|bearer|client[-_]?secret|cookie|credential(?:s)?|jwt|key|password|passwd|private[-_]?key|secret|sig(?:nature)?|token)(?==|:|[-_]|["']\s*:)/iu;
const embeddedCredentialScheme = /(?:^|=|,|:|\{|\[|"|')(?:api[-_ ]?key|basic|bearer|jwt|token)\s+\S+/iu;
const credentialUrlUserinfo = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s@]+@/u;
const uriScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const shellExecutable = /^(?:bash|cmd(?:\.exe)?|fish|powershell(?:\.exe)?|pwsh(?:\.exe)?|sh|zsh)$/iu;
const staticFlag = /^--?[A-Za-z][A-Za-z0-9-]*$/u;
const staticPackageSpecifier = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@v?\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/u;
const staticScriptPath = /^[A-Za-z0-9._~@%+\\/-]+$/u;
const staticScriptExtension = /\.(?:cjs|cts|js|mjs|mts|php|pl|py|rb|ts)$/iu;
const packageRunners = new Set(["bunx", "npx", "pnpm", "pnpx", "uvx"]);
const scriptRunners = new Set(["bun", "deno", "node", "perl", "php", "python", "python3", "ruby", "ts-node", "tsx"]);
const environmentWrappers = new Set(["env"]);
const staticLaunchError = "The selected MCP entry contains arguments outside Miftah's static launch grammar. Use advanced manual setup and configure secrets with references.";

export type ClientEntryContainer = "mcpServers" | "servers";

/** A redacted selection list. It intentionally never includes command, argument, or credential values. */
export interface ClientConfigurationInspection {
  readonly container: ClientEntryContainer;
  readonly entries: readonly string[];
}

/** Pure, explicitly selected input from a pasted or otherwise user-provided client configuration document. */
export interface ImportedClientConfigurationRequest {
  readonly configurationName: string;
  readonly document: string;
  readonly entry?: string;
}

export type ClientEntryImportErrorReason = "invalid" | "static-launch";

/** Stable no-secret input error for client-entry import. */
export class ClientEntryImportError extends Error {
  readonly reason: ClientEntryImportErrorReason;

  constructor(message: string, reason: ClientEntryImportErrorReason = "invalid") {
    super(message);
    this.name = "ClientEntryImportError";
    this.reason = reason;
  }
}

interface ParsedClientConfiguration {
  readonly container: ClientEntryContainer;
  readonly entries: Record<string, unknown>;
}

interface ImportedStdioEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

function importError(message: string, reason: ClientEntryImportErrorReason = "invalid"): never {
  throw new ClientEntryImportError(message, reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function foreignPlatformAbsolutePath(value: string): boolean {
  if (process.platform === "win32") {
    return value.startsWith("/");
  }
  return /^(?:[A-Za-z]:[\\/]|\\)/u.test(value);
}

function absolutePath(value: string): boolean {
  return isAbsolute(value) && !foreignPlatformAbsolutePath(value);
}

function safeText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0 || hasControlCharacter(value)) importError(message);
  return value;
}

function safeArgument(value: unknown): string {
  if (typeof value !== "string" || hasControlCharacter(value)) {
    importError("The selected MCP entry arguments must be strings without controls.");
  }
  return value;
}

function normalizeCredentialText(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1-$2");
}

function credentialBearingArgument(value: string): boolean {
  const normalized = normalizeCredentialText(value);
  const optionName = normalized.split(/[=:]/u, 1)[0] ?? normalized;
  return credentialOptionName.test(optionName)
    || credentialFlag.test(value)
    || credentialValue.test(value)
    || credentialAssignment.test(normalized)
    || embeddedCredentialScheme.test(normalized)
    || credentialUrlUserinfo.test(value);
}

function executableStem(command: string): string {
  const executableName = command.replaceAll("\\", "/").split("/").at(-1) ?? command;
  return executableName.replace(/\.(?:cmd|exe)$/iu, "").toLowerCase();
}

function staticFlagArgument(value: string): boolean {
  return staticFlag.test(value) && !credentialBearingArgument(value);
}

function staticScriptArgument(value: string): boolean {
  return !foreignPlatformAbsolutePath(value)
    && staticScriptExtension.test(value)
    && (staticScriptPath.test(value) || absolutePath(value))
    && !credentialBearingArgument(value);
}

function staticPackageArgument(value: string): boolean {
  return staticPackageSpecifier.test(value) && !credentialBearingArgument(value);
}

function validateStaticLaunchArguments(executable: string, args: readonly string[]): void {
  if (environmentWrappers.has(executable)) {
    importError(
      "Environment wrappers cannot be imported. Use Miftah secret references and advanced manual setup instead.",
      "static-launch"
    );
  }

  if (scriptRunners.has(executable)) {
    const [script, ...flags] = args;
    if (script === undefined || !staticScriptArgument(script) || !flags.every(staticFlagArgument)) {
      importError(staticLaunchError, "static-launch");
    }
    return;
  }

  if (packageRunners.has(executable)) {
    const packageIndex = args.findIndex((argument) => !staticFlagArgument(argument));
    const packageArgument = packageIndex < 0 ? undefined : args[packageIndex];
    if (packageArgument === undefined || !staticPackageArgument(packageArgument) || !args.slice(packageIndex + 1).every(staticFlagArgument)) {
      importError(staticLaunchError, "static-launch");
    }
    return;
  }

  if (!args.every(staticFlagArgument)) importError(staticLaunchError, "static-launch");
}

function safeEntryName(value: string): void {
  if (value.length === 0 || value.length > 256 || hasControlCharacter(value)) {
    importError("The client configuration contains an invalid MCP entry name.");
  }
}

function parseClientConfiguration(document: string): ParsedClientConfiguration {
  if (typeof document !== "string" || document.length === 0 || Buffer.byteLength(document, "utf8") > maximumDocumentBytes) {
    importError("The client configuration must be a non-empty JSON document no larger than 64 KiB.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    importError("The client configuration is not valid JSON.");
  }
  if (!isRecord(parsed)) importError("The client configuration must be a JSON object.");

  const hasMcpServers = Object.hasOwn(parsed, "mcpServers");
  const hasVsCodeServers = Object.hasOwn(parsed, "servers");
  if (hasMcpServers === hasVsCodeServers) {
    importError("The client configuration must contain exactly one supported MCP server container.");
  }
  const container: ClientEntryContainer = hasMcpServers ? "mcpServers" : "servers";
  const entries = parsed[container];
  if (!isRecord(entries) || Object.keys(entries).length === 0) {
    importError("The supported MCP server container must contain at least one entry.");
  }
  for (const entry of Object.keys(entries)) safeEntryName(entry);
  return { container, entries };
}

/** Lists selectable entries without parsing or returning any sensitive entry values. */
export function inspectClientConfiguration(document: string): ClientConfigurationInspection {
  const parsed = parseClientConfiguration(document);
  return { container: parsed.container, entries: Object.keys(parsed.entries).sort() };
}

function selectEntry(request: ImportedClientConfigurationRequest, parsed: ParsedClientConfiguration): unknown {
  const selected = request.entry;
  if (selected === undefined) {
    importError("Select one MCP entry before importing a client configuration.");
  }
  safeEntryName(selected);
  if (!Object.hasOwn(parsed.entries, selected)) {
    importError("The selected MCP entry does not exist in the client configuration.");
  }
  return parsed.entries[selected];
}

function selectedStdioEntry(value: unknown, container: ClientEntryContainer): ImportedStdioEntry {
  if (!isRecord(value)) importError("The selected MCP entry must be an object.");

  if (Object.hasOwn(value, "env") || Object.hasOwn(value, "headers")) {
    importError("Credential-bearing environment or header values cannot be imported. Configure a Miftah secret reference separately.");
  }
  if (Object.hasOwn(value, "shell")) {
    importError("Shell execution settings cannot be imported. Use an executable and argument array instead.");
  }
  for (const key of Object.keys(value)) {
    if (!["type", "command", "args", "cwd"].includes(key)) {
      importError("The selected MCP entry contains unsupported or credential-bearing fields.");
    }
  }
  if (value.type !== undefined && value.type !== "stdio") {
    importError("Only local stdio MCP entries can be imported in this setup flow.");
  }
  if (container === "servers" && value.type !== "stdio") {
    importError("VS Code MCP entries must declare type 'stdio' for this setup flow.");
  }

  const command = safeText(value.command, "The selected MCP entry requires a literal executable command.");
  if (shellMetacharacter.test(command)
    || uriScheme.test(command)
    || credentialBearingArgument(command)
    || foreignPlatformAbsolutePath(command)
    || (command.includes(" ") && !absolutePath(command))) {
    importError("The selected MCP command must be one executable, with arguments supplied separately.");
  }
  const executable = executableStem(command);
  if (shellExecutable.test(executable)) {
    importError("Shell executables cannot be imported. Use the upstream executable and argument array directly.");
  }

  const rawArgs = value.args ?? [];
  if (!Array.isArray(rawArgs)) importError("The selected MCP entry arguments must be an array of strings.");
  const args = rawArgs.map(safeArgument);
  if (args.some(credentialBearingArgument)) {
    importError("Credential-bearing MCP arguments cannot be imported. Configure a Miftah secret reference separately.");
  }
  validateStaticLaunchArguments(executable, args);

  if (value.cwd === undefined) return { command, args };
  const cwd = safeText(value.cwd, "The selected MCP working directory must be a literal absolute path.");
  if (!absolutePath(cwd)) importError("The selected MCP working directory must be a literal absolute path.");
  return { command, args, cwd };
}

function safeImportedConfig(name: string, upstream: ImportedStdioEntry): MiftahConfig {
  try {
    const baseline = buildPresetConfig(name, "generic", {});
    return validateConfig({
      ...baseline,
      description: `${name} imported from an existing MCP client entry`,
      upstream: {
        transport: "stdio",
        command: upstream.command,
        args: [...upstream.args],
        ...(upstream.cwd === undefined ? {} : { cwd: upstream.cwd })
      },
      profiles: {
        default: {
          description: "Imported MCP entry; configure authentication separately when required.",
          policy: "readonly"
        }
      },
      policies: { readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] } },
      tooling: { ...baseline.tooling, unknownToolRisk: "destructive" }
    });
  } catch (error) {
    if (error instanceof PresetCatalogError) {
      importError("The requested Miftah configuration name is not valid.");
    }
    if (error instanceof Error) {
      importError("The imported MCP entry could not be converted into a valid Miftah configuration.");
    }
    throw error;
  }
}

/**
 * Converts one explicitly selected, non-secret local stdio entry into a safe-default Miftah configuration.
 * This function is pure: it does not read files, start a process, write configuration, or mutate a client.
 */
export function createImportedClientConfiguration(request: ImportedClientConfigurationRequest): MiftahConfig {
  const parsed = parseClientConfiguration(request.document);
  const entry = selectedStdioEntry(selectEntry(request, parsed), parsed.container);
  return safeImportedConfig(request.configurationName, entry);
}
