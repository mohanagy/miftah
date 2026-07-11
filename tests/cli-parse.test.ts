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
    expectUsageError(["validate", "unexpected"]);
    expectUsageError(["--version", "validate"]);
    expectUsageError(["version", "--version"]);
    expectUsageError(["--help", "--version"]);
  });
});
