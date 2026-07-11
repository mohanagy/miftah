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
    expectUsageError(["validate", "unexpected"]);
    expectUsageError(["--version", "validate"]);
    expectUsageError(["version", "--version"]);
    expectUsageError(["--help", "--version"]);
  });
});
