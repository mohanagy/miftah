import { posix, win32 } from "node:path";
import { managementToolDescriptors } from "../mcp/server/management-tools.js";

export const CLIENT_NAMES = Object.freeze(["claude-desktop", "claude-code", "cursor", "vscode"] as const);

export type ClientName = (typeof CLIENT_NAMES)[number];
export type ClientSelection = ClientName | "all";

export interface ClientLauncher {
  command: string;
  args: readonly string[];
}

export interface ClientSnippetInput {
  serverName: string;
  configPath: string;
  launcher: ClientLauncher;
}

export interface ClientSnippet {
  client: ClientName;
  target: {
    label: string;
  };
  /** Non-secret handoff guidance that accompanies, but is not part of, the client JSON. */
  guidance: string;
  json: string;
}

export interface ClaudeCodePermissionGuidanceOptions {
  /** Includes only management tools exposed by delegated-agent approval mode. */
  delegatedAgentApproval: boolean;
}

export type ClaudeCodePermissionGuidance =
  | {
      kind: "snippet";
      target: { label: string };
      json: string;
    }
  | {
      kind: "manual";
      target: { label: string };
      message: string;
    };

export class ClientSnippetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientSnippetError";
  }
}

const targetLabels: Record<ClientName, string> = {
  "claude-desktop": "Claude Desktop settings config",
  "claude-code": "Claude Code project .mcp.json",
  cursor: "Cursor .cursor/mcp.json",
  vscode: "VS Code .vscode/mcp.json"
};

const claudeCodePermissionTarget = { label: "Claude Code settings permissions" };
const literalClaudeCodeServerName = /^[A-Za-z0-9-]+$/u;
const clientProfileGuidance =
  "One Miftah connector serves every named profile in this configuration. Merge this one entry, then select accounts through Miftah instead of adding duplicate client entries. The generated JSON contains launcher and configuration-path metadata, never credential values. A generated entry does not prove that a credential works or belongs to the intended account.";

/** Throws one stable input error for invalid client-snippet configuration. */
function inputError(message: string): never {
  throw new ClientSnippetError(message);
}

function isClientName(value: unknown): value is ClientName {
  return typeof value === "string" && (CLIENT_NAMES as readonly string[]).includes(value);
}

function isAbsolutePath(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path);
}

function validateInput(input: ClientSnippetInput): void {
  if (input === null || typeof input !== "object") {
    inputError("A snippet input object is required.");
  }
  if (typeof input.serverName !== "string" || input.serverName.length === 0) {
    inputError("A non-empty server name is required.");
  }
  if (typeof input.configPath !== "string" || input.configPath.includes("\0")) {
    inputError("Config path must not contain a NUL character.");
  }
  if (!isAbsolutePath(input.configPath)) {
    inputError("Config path must be absolute.");
  }
  if (input.launcher === null || typeof input.launcher !== "object") {
    inputError("A launcher object is required.");
  }
  if (typeof input.launcher?.command !== "string" || input.launcher.command.length === 0) {
    inputError("A non-empty launcher command is required.");
  }
  if (input.launcher.command.includes("\0")) {
    inputError("Launcher command must not contain a NUL character.");
  }
  if (!isAbsolutePath(input.launcher.command)) {
    inputError("Launcher command must be absolute.");
  }
  if (!Array.isArray(input.launcher.args)) {
    inputError("Every launcher argument must be a non-empty string.");
  }
  const launcherArguments = Array.from(input.launcher.args);
  if (launcherArguments.length === 0 || launcherArguments.some((argument) => typeof argument !== "string" || argument.length === 0)) {
    inputError("Every launcher argument must be a non-empty string.");
  }
  if (launcherArguments.some((argument) => argument.includes("\0"))) {
    inputError("Launcher arguments must not contain a NUL character.");
  }
  const entrypoint = launcherArguments[0];
  if (entrypoint === undefined || !isAbsolutePath(entrypoint)) {
    inputError("Miftah CLI entrypoint must be absolute.");
  }
  if (launcherArguments.some((argument) => argument === "--config" || argument.startsWith("--config="))) {
    inputError("Launcher arguments must not include '--config'; the snippet supplies it.");
  }
}

function renderedServer(input: ClientSnippetInput): { command: string; args: string[] } {
  return {
    command: input.launcher.command,
    args: [...input.launcher.args, "--config", input.configPath]
  };
}

function renderConfiguration(client: ClientName, input: ClientSnippetInput): object {
  const server = renderedServer(input);

  switch (client) {
    case "claude-desktop":
    case "claude-code":
      return { mcpServers: { [input.serverName]: server } };
    case "cursor":
      return { mcpServers: { [input.serverName]: { type: "stdio", ...server } } };
    case "vscode":
      return { servers: { [input.serverName]: { type: "stdio", ...server } } };
  }
}

/**
 * Renders one client-specific MCP entry together with non-secret account-switching guidance.
 *
 * @param client - The supported MCP client whose configuration shape should be rendered.
 * @param input - The validated launcher, server name, and absolute Miftah configuration path.
 * @returns A display-safe client handoff that contains no credential values.
 * @throws {ClientSnippetError} When the client or launcher input is not safe to render.
 */
export function renderClientSnippet(client: ClientName, input: ClientSnippetInput): ClientSnippet {
  if (!isClientName(client)) {
    inputError("Unsupported client.");
  }
  validateInput(input);
  return {
    client,
    target: { label: targetLabels[client] },
    guidance: clientProfileGuidance,
    json: JSON.stringify(renderConfiguration(client, input), undefined, 2)
  };
}

/**
 * Formats a generated client entry with its non-secret multi-profile handoff guidance.
 *
 * @param snippet - A generated client entry whose JSON has already been validated for display.
 * @returns Copy-ready text for a client configuration handoff; it never adds credential values.
 */
export function formatClientSnippetHandoff(snippet: ClientSnippet): string {
  return `${snippet.target.label} (${snippet.client}):\n${snippet.guidance}\n${snippet.json}\n`;
}

export function renderClientSnippets(selection: ClientSelection, input: ClientSnippetInput): ClientSnippet[] {
  if (selection === "all") {
    return CLIENT_NAMES.map((client) => renderClientSnippet(client, input));
  }
  return [renderClientSnippet(selection, input)];
}

/**
 * Renders defense-in-depth Claude Code review rules. These rules never replace
 * Miftah's server-side authorization and are intentionally not written to a
 * settings file because it may contain unrelated user policy.
 */
export function renderClaudeCodePermissionGuidance(
  serverName: string,
  options: ClaudeCodePermissionGuidanceOptions
): ClaudeCodePermissionGuidance {
  if (typeof serverName !== "string" || !literalClaudeCodeServerName.test(serverName)) {
    return {
      kind: "manual",
      target: claudeCodePermissionTarget,
      message:
        "Claude Code permission guidance was not generated because the configured server name is not a literal name matching [A-Za-z0-9-]+. Choose a literal server name and manually add exact management-tool rules to Claude Code settings."
    };
  }

  const ask = managementToolDescriptors({ delegatedAgentApproval: options.delegatedAgentApproval })
    .filter((descriptor) => descriptor.askInClaudeCode)
    .map((descriptor) => `mcp__${serverName}__${descriptor.name}`);
  return {
    kind: "snippet",
    target: claudeCodePermissionTarget,
    json: JSON.stringify({ permissions: { ask } }, undefined, 2)
  };
}
