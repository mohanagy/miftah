import { describe, expect, it } from "vitest";
import {
  CLIENT_NAMES,
  ClientSnippetError,
  renderClientSnippet,
  renderClientSnippets
} from "../src/cli/client-snippets.js";

const posixInput = {
  serverName: "miftah server",
  configPath: "/Users/Ada Lovelace/Miftah/config.json",
  launcher: {
    command: "/Applications/Miftah/bin/node",
    args: ["/Applications/Miftah/dist/cli/main.js", "serve"]
  }
};

describe("client snippets", () => {
  it("renders the official Claude Desktop stdio configuration", () => {
    const snippet = renderClientSnippet("claude-desktop", posixInput);

    expect(snippet.client).toBe("claude-desktop");
    expect(snippet.target).toEqual({ label: "Claude Desktop settings config" });
    expect(JSON.parse(snippet.json)).toEqual({
      mcpServers: {
        "miftah server": {
          command: "/Applications/Miftah/bin/node",
          args: ["/Applications/Miftah/dist/cli/main.js", "serve", "--config", "/Users/Ada Lovelace/Miftah/config.json"]
        }
      }
    });
  });

  it("renders the official Claude Code project .mcp.json configuration", () => {
    const snippet = renderClientSnippet("claude-code", posixInput);

    expect(snippet.target).toEqual({ label: "Claude Code project .mcp.json" });
    expect(JSON.parse(snippet.json)).toEqual({
      mcpServers: {
        "miftah server": {
          command: "/Applications/Miftah/bin/node",
          args: ["/Applications/Miftah/dist/cli/main.js", "serve", "--config", "/Users/Ada Lovelace/Miftah/config.json"]
        }
      }
    });
  });

  it("renders the official Cursor stdio configuration", () => {
    const snippet = renderClientSnippet("cursor", posixInput);

    expect(snippet.target).toEqual({ label: "Cursor .cursor/mcp.json" });
    expect(JSON.parse(snippet.json)).toEqual({
      mcpServers: {
        "miftah server": {
          type: "stdio",
          command: "/Applications/Miftah/bin/node",
          args: ["/Applications/Miftah/dist/cli/main.js", "serve", "--config", "/Users/Ada Lovelace/Miftah/config.json"]
        }
      }
    });
  });

  it("renders the official VS Code stdio configuration", () => {
    const snippet = renderClientSnippet("vscode", posixInput);

    expect(snippet.target).toEqual({ label: "VS Code .vscode/mcp.json" });
    expect(JSON.parse(snippet.json)).toEqual({
      servers: {
        "miftah server": {
          type: "stdio",
          command: "/Applications/Miftah/bin/node",
          args: ["/Applications/Miftah/dist/cli/main.js", "serve", "--config", "/Users/Ada Lovelace/Miftah/config.json"]
        }
      }
    });
  });

  it("renders every supported client in a deterministic order", () => {
    const snippets = renderClientSnippets("all", posixInput);

    expect(CLIENT_NAMES).toEqual(["claude-desktop", "claude-code", "cursor", "vscode"]);
    expect(snippets.map((snippet) => snippet.client)).toEqual(CLIENT_NAMES);
  });

  it("preserves Windows paths and launcher values exactly in JSON arrays", () => {
    const command = String.raw`C:\Program Files\nodejs\node.exe`;
    const configPath = String.raw`C:\Users\Ada Lovelace\Miftah\config.json`;
    const entrypoint = String.raw`C:\Program Files\Miftah\dist\cli\main.js`;
    const snippet = renderClientSnippet("cursor", {
      serverName: "Miftah",
      configPath,
      launcher: { command, args: [entrypoint, "--label", "value with spaces; $(not-a-shell)"] }
    });
    const parsed = JSON.parse(snippet.json) as {
      mcpServers: Record<string, { command: string; args: string[]; shell?: unknown }>;
    };
    const server = parsed.mcpServers.Miftah;

    expect(server).toEqual({
      type: "stdio",
      command,
      args: [entrypoint, "--label", "value with spaces; $(not-a-shell)", "--config", configPath]
    });
    expect(server?.shell).toBeUndefined();
  });

  it("JSON-escapes ordinary Unicode and JSON-sensitive names without changing them", () => {
    const serverName = "Miftah \"東京\"\n\\";
    const snippet = renderClientSnippet("vscode", {
      ...posixInput,
      serverName,
      launcher: { command: "node\"quoted", args: ["line\nbreak", "\\slash"] }
    });
    const parsed = JSON.parse(snippet.json) as { servers: Record<string, { command: string; args: string[] }> };

    expect(parsed.servers[serverName]).toEqual({
      type: "stdio",
      command: "node\"quoted",
      args: ["line\nbreak", "\\slash", "--config", posixInput.configPath]
    });
  });

  it.each([
    [{ ...posixInput, serverName: "" }, "server name"],
    [{ ...posixInput, launcher: { ...posixInput.launcher, command: "" } }, "launcher command"],
    [{ ...posixInput, launcher: { ...posixInput.launcher, args: [""] } }, "launcher argument"],
    [{ ...posixInput, configPath: "relative/config.json" }, "absolute"],
    [{ ...posixInput, configPath: "/safe\u0000path/config.json" }, "NUL"]
  ])("rejects invalid input %#", (input, message) => {
    expect(() => renderClientSnippet("cursor", input)).toThrow(ClientSnippetError);
    expect(() => renderClientSnippet("cursor", input)).toThrow(message);
  });

  it("accepts UNC paths and rejects unrecognized client names at runtime", () => {
    const snippet = renderClientSnippet("claude-code", {
      ...posixInput,
      configPath: String.raw`\\server\share\miftah\config.json`
    });

    expect(JSON.parse(snippet.json).mcpServers["miftah server"].args.at(-1)).toBe(
      String.raw`\\server\share\miftah\config.json`
    );
    expect(() => renderClientSnippet("unsupported" as never, posixInput)).toThrow(ClientSnippetError);
    expect(() => renderClientSnippet("unsupported" as never, posixInput)).toThrow("Unsupported client");
  });
});
