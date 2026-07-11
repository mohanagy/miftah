import { posix, win32 } from "node:path";

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
  json: string;
}

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

function inputError(message: string): never {
  throw new ClientSnippetError(message);
}

function isClientName(value: string): value is ClientName {
  return (CLIENT_NAMES as readonly string[]).includes(value);
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
  if (!Array.isArray(input.launcher.args) || input.launcher.args.length === 0 || input.launcher.args.some((argument) => typeof argument !== "string" || argument.length === 0)) {
    inputError("Every launcher argument must be a non-empty string.");
  }
  if (input.launcher.args.some((argument) => argument.includes("\0"))) {
    inputError("Launcher arguments must not contain a NUL character.");
  }
  const entrypoint = input.launcher.args[0];
  if (entrypoint === undefined || !isAbsolutePath(entrypoint)) {
    inputError("Miftah CLI entrypoint must be absolute.");
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

export function renderClientSnippet(client: ClientName, input: ClientSnippetInput): ClientSnippet {
  if (!isClientName(client)) {
    inputError(`Unsupported client '${client}'.`);
  }
  validateInput(input);
  return {
    client,
    target: { label: targetLabels[client] },
    json: JSON.stringify(renderConfiguration(client, input), undefined, 2)
  };
}

export function renderClientSnippets(selection: ClientSelection, input: ClientSnippetInput): ClientSnippet[] {
  if (selection === "all") {
    return CLIENT_NAMES.map((client) => renderClientSnippet(client, input));
  }
  return [renderClientSnippet(selection, input)];
}
