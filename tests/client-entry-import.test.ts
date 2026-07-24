import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate-config.js";
import {
  ClientEntryImportError,
  createImportedClientConfiguration,
  inspectClientConfiguration
} from "../src/setup/client-entry-import.js";

describe("client entry import", () => {
  it("lists supported client entries without returning their configuration values", () => {
    const document = JSON.stringify({
      mcpServers: {
        posthog: { command: "npx", args: ["--yes", "@posthog/mcp@1.2.3"] },
        sentry: { command: "npx", args: ["--yes", "@sentry/mcp-server@0.36.0"] }
      }
    });

    expect(inspectClientConfiguration(document)).toEqual({
      container: "mcpServers",
      entries: ["posthog", "sentry"]
    });
  });

  it("imports one reviewed Claude-compatible stdio entry into a validated safe-default configuration", () => {
    const config = createImportedClientConfiguration({
      configurationName: "posthog-work",
      document: JSON.stringify({
        mcpServers: {
          posthog: {
            command: "npx",
            args: ["--yes", "@posthog/mcp@1.2.3"]
          }
        }
      }),
      entry: "posthog"
    });

    expect(validateConfig(config)).toEqual(config);
    expect(config).toMatchObject({
      version: "3",
      name: "posthog-work",
      defaultProfile: "default",
      upstream: {
        transport: "stdio",
        command: "npx",
        args: ["--yes", "@posthog/mcp@1.2.3"]
      },
      profiles: { default: {} },
      security: { requireExplicitProfileForDestructive: true }
    });
  });

  it("imports an exact-version pnpm dlx launch without treating dlx as the package", () => {
    const config = createImportedClientConfiguration({
      configurationName: "posthog-work",
      document: JSON.stringify({
        mcpServers: {
          posthog: {
            command: "pnpm",
            args: ["dlx", "@posthog/mcp@1.2.3"]
          }
        }
      }),
      entry: "posthog"
    });

    expect(config.upstream).toMatchObject({
      transport: "stdio",
      command: "pnpm",
      args: ["dlx", "@posthog/mcp@1.2.3"]
    });
  });

  it.each([
    { command: "npx", args: ["-y", "@posthog/mcp@1.2.3"] },
    { command: "bunx", args: ["--bun", "--no-install", "--silent", "@posthog/mcp@1.2.3"] },
    { command: "pnpx", args: ["@posthog/mcp@1.2.3"] },
    { command: "uvx", args: ["--isolated", "mcp-search-console@0.3.2"] }
  ])("imports a known-safe exact package-runner launch: $command $args", ({ command, args }) => {
    const config = createImportedClientConfiguration({
      configurationName: "static-runner",
      document: JSON.stringify({
        mcpServers: {
          example: { command, args }
        }
      }),
      entry: "example"
    });

    expect(config.upstream).toMatchObject({ command, args });
  });

  it.each([
    { command: "npx", args: ["--yes", "-y", "@posthog/mcp@1.2.3"] },
    { command: "bunx", args: ["--silent", "--verbose", "@posthog/mcp@1.2.3"] },
    { command: "bunx", args: ["--bun", "--bun", "@posthog/mcp@1.2.3"] }
  ])("rejects duplicate or conflicting package-runner flags: $command $args", ({ command, args }) => {
    expect(() => createImportedClientConfiguration({
      configurationName: "conflicting-runner-flags",
      document: JSON.stringify({
        mcpServers: {
          example: { command, args }
        }
      }),
      entry: "example"
    })).toThrow("static launch");
  });

  it("keeps non-dlx pnpm subcommands outside the static launch grammar", () => {
    expect(() => createImportedClientConfiguration({
      configurationName: "unsupported-pnpm",
      document: JSON.stringify({
        mcpServers: {
          example: { command: "pnpm", args: ["exec", "unknown-command"] }
        }
      }),
      entry: "example"
    })).toThrow("static launch");
  });

  it.each([
    { command: "npx", args: ["-c", "@posthog/mcp@1.2.3"] },
    { command: "npx", args: ["--call", "@posthog/mcp@1.2.3"] },
    { command: "pnpm", args: ["dlx", "-c", "@posthog/mcp@1.2.3"] },
    { command: "pnpm", args: ["dlx", "--shell-mode", "@posthog/mcp@1.2.3"] },
    { command: "pnpx", args: ["-c", "@posthog/mcp@1.2.3"] },
    { command: "pnpx", args: ["--shell-mode", "@posthog/mcp@1.2.3"] }
  ])("rejects package-runner shell mode: $command $args", ({ command, args }) => {
    expect(() => createImportedClientConfiguration({
      configurationName: "shell-mode",
      document: JSON.stringify({
        mcpServers: {
          example: { command, args }
        }
      }),
      entry: "example"
    })).toThrow("static launch");
  });

  it.each([
    { command: "npx", args: ["--yes", "@posthog/mcp@1.2.3", "--skills"] },
    { command: "pnpm", args: ["dlx", "@posthog/mcp@1.2.3", "--skills"] },
    { command: "pnpx", args: ["@posthog/mcp@1.2.3", "--skills"] },
    { command: "uvx", args: ["mcp-search-console@0.3.2", "--isolated"] }
  ])("rejects arguments after a selected package: $command $args", ({ command, args }) => {
    expect(() => createImportedClientConfiguration({
      configurationName: "package-arguments",
      document: JSON.stringify({
        mcpServers: {
          example: { command, args }
        }
      }),
      entry: "example"
    })).toThrow("static launch");
  });

  it("imports a VS Code stdio entry with its argument boundaries and working directory intact", () => {
    const command = process.platform === "win32" ? "C:\\node.exe" : "/usr/local/bin/node";
    const script = process.platform === "win32" ? "C:\\workspace\\server.mjs" : "/workspace/server.mjs";
    const cwd = process.platform === "win32" ? "C:\\workspace" : "/workspace";
    const config = createImportedClientConfiguration({
      configurationName: "analytics-work",
      document: JSON.stringify({
        servers: {
          analytics: {
            type: "stdio",
            command,
            args: [script, "--readonly"],
            cwd
          }
        }
      }),
      entry: "analytics"
    });

    expect(config).toMatchObject({
      upstream: {
        transport: "stdio",
        command,
        args: [script, "--readonly"],
        cwd
      },
      profiles: { default: { policy: "readonly" } },
      policies: { readonly: { allowRisk: ["read"], denyRisk: ["write", "destructive"] } },
      tooling: { unknownToolRisk: "destructive" }
    });
  });

  it.each(["@posthog/mcp", "@posthog/mcp@1", "@posthog/mcp@1.2"])(
    "rejects an unpinned package-runner dependency: %s",
    (packageSpecifier) => {
      const document = JSON.stringify({
        mcpServers: {
          posthog: { command: "npx", args: ["--yes", packageSpecifier] }
        }
      });

      expect(() => createImportedClientConfiguration({ configurationName: "unpinned-package", document, entry: "posthog" })).toThrow(
        "static launch"
      );
    }
  );

  it.each(["", "describe Bearer value"])(
    "rejects an opaque argument value that cannot be proven to be static launch metadata: %j",
    (value) => {
      const document = JSON.stringify({
        mcpServers: {
          example: { command: "node", args: ["/workspace/server.mjs", "--label", value] }
        }
      });

      expect(() => createImportedClientConfiguration({ configurationName: "opaque-argument", document, entry: "example" })).toThrow(
        "static launch"
      );
    }
  );

  it("requires explicit selection when an imported document has more than one entry", () => {
    const document = JSON.stringify({
      mcpServers: {
        one: { command: "one" },
        two: { command: "two" }
      }
    });

    expect(() => createImportedClientConfiguration({ configurationName: "multiple", document })).toThrow(ClientEntryImportError);
    expect(() => createImportedClientConfiguration({ configurationName: "multiple", document })).toThrow("Select one MCP entry");
  });

  it("requires explicit selection even when a client document has one entry", () => {
    const document = JSON.stringify({
      mcpServers: {
        one: { command: "one" }
      }
    });

    expect(() => createImportedClientConfiguration({ configurationName: "one", document })).toThrow(ClientEntryImportError);
    expect(() => createImportedClientConfiguration({ configurationName: "one", document })).toThrow("Select one MCP entry");
  });

  it.each([
    { env: { API_TOKEN: "gF7r2Uv9Qx" } },
    { headers: { Authorization: "Bearer gF7r2Uv9Qx" } },
    { args: ["--api-key=gF7r2Uv9Qx"] },
    { args: ["--http-header=Authorization: Bearer gF7r2Uv9Qx"] },
    { args: ["--metadata=Authorization: Bearer gF7r2Uv9Qx"] },
    { args: ["--metadata=Bearer gF7r2Uv9Qx"] },
    { args: ["--url=https://user:gF7r2Uv9Qx@example.test/mcp"] },
    { args: ["--url=redis://:gF7r2Uv9Qx@cache.example/0"] },
    { args: ["--url=https://gF7r2Uv9Qx@example.test/mcp"] },
    { args: ["--metadata=Token gF7r2Uv9Qx"] },
    { args: ["--myApiKey=gF7r2Uv9Qx"] },
    { args: ["--token-value=gF7r2Uv9Qx"] },
    { args: ["--endpoint=https://example.test/mcp?token=gF7r2Uv9Qx"] },
    { args: ["--jwt=gF7r2Uv9Qx"] },
    { args: ["--metadata=JWT gF7r2Uv9Qx"] },
    { args: ["--url=https://example.test/mcp?signature=gF7r2Uv9Qx"] },
    { args: ["--url=https://example.test/mcp?sig=gF7r2Uv9Qx"] },
    { command: "https://gF7r2Uv9Qx@example.test/mcp" },
    { command: "node?token=gF7r2Uv9Qx" },
    { command: "env", args: ["FOO=gF7r2Uv9Qx", "node", "server.mjs"] },
    { command: "node", args: ["-e", "require(\"./server\").start(\"gF7r2Uv9Qx\")"] },
    { command: "python3", args: ["-c", "start(\"gF7r2Uv9Qx\")"] },
    { args: ["--header", "Authorization: Bearer gF7r2Uv9Qx"] },
    { args: ["-H", "Authorization: Bearer gF7r2Uv9Qx"] },
    { args: ["--auth=gF7r2Uv9Qx"] },
    { args: ["--private-key=gF7r2Uv9Qx"] },
    { args: ["--access-key=gF7r2Uv9Qx"] },
    { args: ["--key=gF7r2Uv9Qx"] },
    { args: ["--bearer=gF7r2Uv9Qx"] },
    { args: ["--pass=gF7r2Uv9Qx"] },
    { args: ["-uadmin:gF7r2Uv9Qx"] },
    { args: ["-bsession=gF7r2Uv9Qx"] },
    { shell: true }
  ])("rejects credential-bearing or shell-shaped client input without echoing values", (unsafe) => {
    const secret = "gF7r2Uv9Qx";
    const document = JSON.stringify({
      mcpServers: {
        unsafe: { command: "node", ...unsafe }
      }
    });

    let error: unknown;
    try {
      createImportedClientConfiguration({ configurationName: "unsafe", document, entry: "unsafe" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ClientEntryImportError);
    expect(error).toHaveProperty("message", expect.not.stringContaining(secret));
  });

  it("rejects a foreign-platform absolute working directory", () => {
    const foreignCwd = process.platform === "win32" ? "/workspace" : "C:\\workspace";
    const document = JSON.stringify({
      mcpServers: {
        example: { command: "node", args: ["server.mjs"], cwd: foreignCwd }
      }
    });

    expect(() => createImportedClientConfiguration({ configurationName: "foreign-cwd", document, entry: "example" })).toThrow(
      "working directory"
    );
  });

  it("rejects a foreign-platform command path that only appears absolute", () => {
    const command = process.platform === "win32" ? "/opt/MCP Server/node" : "C:\\Program Files\\node.exe";
    const document = JSON.stringify({
      mcpServers: {
        example: { command }
      }
    });

    expect(() => createImportedClientConfiguration({ configurationName: "foreign-command", document, entry: "example" })).toThrow(
      "executable"
    );
  });

  it("rejects a foreign-platform command path without spaces", () => {
    const command = process.platform === "win32" ? "/usr/bin/node" : "C:\\node.exe";
    const document = JSON.stringify({
      mcpServers: {
        example: { command }
      }
    });

    expect(() => createImportedClientConfiguration({ configurationName: "foreign-command", document, entry: "example" })).toThrow(
      "executable"
    );
  });
});
