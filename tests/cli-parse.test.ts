import { describe, expect, it } from "vitest";
import {
  CLI_COMMANDS,
  CliUsageError,
  parseCli,
  renderCommandHelp,
  renderRootHelp
} from "../src/cli/parse.js";

function expectUsageError(argv: string[]): void {
  expect(() => parseCli(argv)).toThrow(CliUsageError);
}

describe("CLI parser", () => {
  it("parses default serve options without loading configuration", () => {
    expect(parseCli(["--config", "missing-config.json"])).toEqual({
      kind: "run",
      command: "serve",
      options: { config: "missing-config.json" }
    });
  });

  it("accepts the explicit HTTP transport for serve", () => {
    expect(parseCli(["serve", "--transport", "http", "--config=wrapper.json"])).toEqual({
      kind: "run",
      command: "serve",
      options: { transport: "http", config: "wrapper.json" }
    });
    expect(parseCli(["--transport=stdio"])).toEqual({
      kind: "run",
      command: "serve",
      options: { transport: "stdio" }
    });
    expectUsageError(["serve", "--transport", "websocket"]);
  });

  it("parses only an explicit loopback Console launch with an optional port", () => {
    expect(parseCli(["console", "--config", "wrapper.json", "--port", "43127"])).toEqual({
      kind: "run",
      command: "console",
      options: { config: "wrapper.json", port: "43127" }
    });
    expect(renderCommandHelp("console")).toContain("--port <number>");
    expectUsageError(["serve", "--port", "43127"]);
  });

  it("accepts command options before and after commands, including equals values", () => {
    expect(parseCli(["--config=wrapper.json", "doctor", "--json"])).toEqual({
      kind: "run",
      command: "doctor",
      options: { config: "wrapper.json", json: true }
    });
    expect(parseCli(["--profile", "work", "list-tools", "--config", "wrapper.json"])).toEqual({
      kind: "run",
      command: "list-tools",
      options: { config: "wrapper.json", profile: "work" }
    });
    expect(parseCli(["--follow", "logs", "--config=wrapper.json"])).toEqual({
      kind: "run",
      command: "logs",
      options: { config: "wrapper.json", follow: true }
    });
    expect(parseCli(["audit-export", "--config", "wrapper.json", "--output=review.jsonl"])).toEqual({
      kind: "run",
      command: "audit-export",
      options: { config: "wrapper.json", output: "review.jsonl" }
    });
    expect(parseCli(["--json", "audit-verify", "--config=wrapper.json"])).toEqual({
      kind: "run",
      command: "audit-verify",
      options: { config: "wrapper.json", json: true }
    });
    expect(parseCli(["migrate-config", "--config", "wrapper.json", "--write"])).toEqual({
      kind: "run",
      command: "migrate-config",
      options: { config: "wrapper.json", write: true }
    });
  });

  it("parses nested connection and OAuth lifecycle commands", () => {
    expect(
      parseCli([
        "connection",
        "add",
        "--config",
        "wrapper.json",
        "--profile",
        "production",
        "--upstream",
        "default",
        "--issuer",
        "https://auth.example.com",
        "--client-registration",
        "dynamic",
        "--scope",
        "openid",
        "--scope=profile",
        "--write"
      ])
    ).toEqual({
      kind: "run",
      command: "connection add",
      options: {
        config: "wrapper.json",
        profile: "production",
        upstream: "default",
        issuer: "https://auth.example.com",
        clientRegistration: "dynamic",
        scopes: ["openid", "profile"],
        write: true
      }
    });
    expect(parseCli(["connection", "list", "--config=wrapper.json", "--client", "claude-desktop"])).toEqual({
      kind: "run",
      command: "connection list",
      options: { config: "wrapper.json", client: "claude-desktop" }
    });
    expect(parseCli(["connection", "status", "--config=wrapper.json", "--connection", "oauthconn:fixture"])).toEqual({
      kind: "run",
      command: "connection status",
      options: { config: "wrapper.json", connection: "oauthconn:fixture" }
    });
    expect(parseCli(["connection", "test", "--config=wrapper.json", "--profile", "production"])).toEqual({
      kind: "run",
      command: "connection test",
      options: { config: "wrapper.json", profile: "production" }
    });
    expect(parseCli(["auth", "connect", "--config=wrapper.json", "--connection", "oauthconn:fixture"])).toEqual({
      kind: "run",
      command: "auth connect",
      options: { config: "wrapper.json", connection: "oauthconn:fixture" }
    });
    expect(parseCli(["auth", "reauth", "--config=wrapper.json", "--profile", "production", "--non-interactive"])).toEqual({
      kind: "run",
      command: "auth reauth",
      options: { config: "wrapper.json", profile: "production", nonInteractive: true }
    });
    expect(parseCli(["auth", "disconnect", "--config=wrapper.json", "--connection", "oauthconn:fixture"])).toEqual({
      kind: "run",
      command: "auth disconnect",
      options: { config: "wrapper.json", connection: "oauthconn:fixture" }
    });
  });

  it("accepts a leading dash in an explicitly assigned option value", () => {
    expect(parseCli(["--config=-leading.json", "validate"])).toEqual({
      kind: "run",
      command: "validate",
      options: { config: "-leading.json" }
    });
  });

  it("gives init's positional name and name option unambiguous results", () => {
    expect(parseCli(["init", "example", "--preset=generic", "--output", "example.json"])).toEqual({
      kind: "run",
      command: "init",
      options: { name: "example", preset: "generic", output: "example.json" }
    });
    expect(parseCli(["--name", "named-example", "init"])).toEqual({
      kind: "run",
      command: "init",
      options: { name: "named-example" }
    });
    expectUsageError(["init", "example", "--name", "named-example"]);
  });

  it("parses all init-only onboarding options before or after init, including equals values", () => {
    expect(
      parseCli([
        "init",
        "gsc",
        "--preset=google-search-console",
        "--oauth-client-secrets-file=/Users/example/.config/gsc/client-secrets.json"
      ])
    ).toEqual({
      kind: "run",
      command: "init",
      options: {
        name: "gsc",
        preset: "google-search-console",
        oauthClientSecretsFile: "/Users/example/.config/gsc/client-secrets.json"
      }
    });
    expect(
      parseCli([
        "--interactive",
        "--client=all",
        "--credential-env",
        "MCP_TOKEN",
        "init",
        "--name=remote",
        "--preset=streamable-http",
        "--url=https://mcp.example.com/v1",
        "--header-name=Authorization",
        "--header-prefix=Bearer ",
        "--output=remote.json"
      ])
    ).toEqual({
      kind: "run",
      command: "init",
      options: {
        interactive: true,
        client: "all",
        credentialEnv: "MCP_TOKEN",
        name: "remote",
        preset: "streamable-http",
        url: "https://mcp.example.com/v1",
        headerName: "Authorization",
        headerPrefix: "Bearer ",
        output: "remote.json"
      }
    });
    expect(parseCli(["--npm-package", "@scope/server@1.2.3", "init", "--preset", "generic-npx"])).toEqual({
      kind: "run",
      command: "init",
      options: { npmPackage: "@scope/server@1.2.3", preset: "generic-npx" }
    });
    expect(
      parseCli([
        "init",
        "--preset=generic-docker",
        "--docker-image=ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      ])
    ).toEqual({
      kind: "run",
      command: "init",
      options: {
        preset: "generic-docker",
        dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    });
  });

  it("renders root and per-command help from every documented command", () => {
    const rootHelp = renderRootHelp();

    for (const command of Object.keys(CLI_COMMANDS) as Array<keyof typeof CLI_COMMANDS>) {
      const metadata = CLI_COMMANDS[command];
      expect(rootHelp).toContain(command);
      expect(rootHelp).toContain(metadata.description);
      expect(renderCommandHelp(command)).toContain(`miftah ${command}`);
    }
    expect(renderCommandHelp("doctor")).toContain("--config <file>");
    expect(renderCommandHelp("doctor")).toContain("--json");
    expect(renderCommandHelp("logs")).toContain("Continue reading audit logs as they are appended or rotated.");
    expect(renderCommandHelp("audit-export")).toContain("--include-arguments");
    expect(renderCommandHelp("audit-verify")).toContain("--json");
    const initHelp = renderCommandHelp("init");
    expect(initHelp).toContain("--interactive");
    expect(initHelp).toContain("--client <claude-desktop|claude-code|cursor|vscode|all>");
    expect(initHelp).toContain("--client <claude-desktop|claude-code|cursor|vscode|all>  Print client configuration snippets.");
    expect(initHelp).toContain("--credential-env <name>");
    expect(initHelp).toContain("--npm-package <package>");
    expect(initHelp).toContain("--docker-image <image>");
    expect(initHelp).toContain("--url <url>");
    expect(initHelp).toContain("--header-name <name>");
    expect(initHelp).toContain("--header-prefix <prefix>");
    expect(initHelp).toContain("--oauth-client-secrets-file <file>");
    expect(renderCommandHelp("connection add")).toContain("miftah connection add");
    expect(renderCommandHelp("connection add")).toContain("--scope <scope>");
    expect(renderCommandHelp("auth reauth")).toContain("--non-interactive");
  });

  it("returns help without requiring a command and recognizes help around commands", () => {
    expect(parseCli(["--help"])).toEqual({ kind: "help" });
    expect(parseCli(["-h", "validate"])).toEqual({ kind: "help", command: "validate" });
    expect(parseCli(["doctor", "-h"])).toEqual({ kind: "help", command: "doctor" });
  });

  it("returns version invocations while preserving the JSON compatibility option", () => {
    expect(parseCli(["--version", "--json"])).toEqual({ kind: "version", json: true });
    expect(parseCli(["version", "--json"])).toEqual({ kind: "version", json: true });
  });

  it("rejects invalid grammar as typed usage errors", () => {
    expectUsageError(["unknown-command"]);
    expectUsageError(["validate", "--unknown"]);
    expectUsageError(["validate", "--config"]);
    expectUsageError(["validate", "--config", "--json"]);
    expectUsageError(["validate", "--config", "one.json", "--config=two.json"]);
    expectUsageError(["schema", "--config", "wrapper.json"]);
    expectUsageError(["validate", "--interactive"]);
    expectUsageError(["doctor", "--client", "cursor"]);
    expectUsageError(["serve", "--credential-env", "MCP_TOKEN"]);
    expectUsageError(["logs", "--npm-package", "@scope/server@1.2.3"]);
    expectUsageError(["audit-export", "--follow"]);
    expectUsageError(["audit-verify", "--output", "review.jsonl"]);
    expectUsageError(["migrate-config", "--output", "replacement.json"]);
    expectUsageError(["schema", "--docker-image", "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]);
    expectUsageError(["version", "--url", "https://mcp.example.com"]);
    expectUsageError(["validate", "--header-name", "Authorization"]);
    expectUsageError(["doctor", "--header-prefix", "Bearer "]);
    expectUsageError(["init", "--client"]);
    expectUsageError(["init", "--credential-env"]);
    expectUsageError(["init", "--npm-package"]);
    expectUsageError(["init", "--docker-image"]);
    expectUsageError(["init", "--url"]);
    expectUsageError(["init", "--header-name"]);
    expectUsageError(["init", "--header-prefix"]);
    expectUsageError(["init", "--oauth-client-secrets-file"]);
    expectUsageError(["init", "--interactive", "--interactive"]);
    expectUsageError(["init", "--client=cursor", "--client=cursor"]);
    expectUsageError(["init", "--credential-env=MCP_TOKEN", "--credential-env=MCP_TOKEN"]);
    expectUsageError(["init", "--npm-package=server@1.2.3", "--npm-package=server@1.2.3"]);
    expectUsageError([
      "init",
      "--docker-image=ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "--docker-image=ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    ]);
    expectUsageError(["init", "--url=https://one.example", "--url=https://two.example"]);
    expectUsageError(["init", "--header-name=Authorization", "--header-name=Authorization"]);
    expectUsageError(["init", "--header-prefix=Bearer", "--header-prefix=Bearer"]);
    expectUsageError([
      "init",
      "--oauth-client-secrets-file=/one.json",
      "--oauth-client-secrets-file=/two.json"
    ]);
    expectUsageError(["validate", "unexpected"]);
    expectUsageError(["connection"]);
    expectUsageError(["connection", "unknown"]);
    expectUsageError(["auth"]);
    expectUsageError(["auth", "unknown"]);
    expectUsageError(["connection", "list", "unexpected"]);
    expectUsageError(["connection", "list", "--issuer", "https://auth.example.com"]);
    expectUsageError(["auth", "disconnect", "--non-interactive"]);
    expectUsageError(["--version", "validate"]);
    expectUsageError(["version", "--version"]);
    expectUsageError(["--help", "--version"]);
  });
});
