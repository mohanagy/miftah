import { describe, expect, it } from "vitest";
import { formatUpstreamStartupFailure } from "../src/cli/error-output.js";
import { MiftahError } from "../src/utils/errors.js";

describe("CLI upstream error output", () => {
  it("renders an actionable test-profile failure from safe structured details", () => {
    const error = new MiftahError(
      "UPSTREAM_INIT_FAILED",
      "UPSTREAM_INIT_FAILED: could not initialize profile 'google-personal'",
      {
        startupDiagnostic: {
          errorCode: "UPSTREAM_INIT_FAILED",
          kind: "process-exit",
          cause: "ModuleNotFoundError: No module named 'mcp.server.fastmcp'",
          exitCode: 1,
          truncated: false,
          remediation: "Correct the upstream command or dependency and retry."
        }
      }
    );

    const output = formatUpstreamStartupFailure(error, {
      configPath: "/Users/example/My Config/miftah.json",
      profile: "google-personal"
    });

    expect(output).toContain(error.message);
    expect(output).toContain("Cause: ModuleNotFoundError");
    expect(output).toContain("Exit code: 1");
    expect(output).toContain("Remediation: Correct the upstream command or dependency and retry.");
    expect(output).toContain(
      "miftah test-profile --config '/Users/example/My Config/miftah.json' --profile 'google-personal'"
    );
  });

  it("shell-quotes diagnostic command arguments", () => {
    const error = new MiftahError("UPSTREAM_INIT_FAILED", "UPSTREAM_INIT_FAILED", {
      startupDiagnostic: {
        errorCode: "UPSTREAM_INIT_FAILED",
        kind: "initialization",
        cause: "safe cause",
        truncated: false,
        remediation: "Retry."
      }
    });

    expect(formatUpstreamStartupFailure(error, {
      configPath: "/tmp/$HOME/config.json",
      profile: "team's-profile"
    })).toContain("--config '/tmp/$HOME/config.json' --profile 'team'\\\\''s-profile'");
  });

  it("falls back to the safe top-level message for unrelated errors", () => {
    const error = new MiftahError("CONFIG_NOT_FOUND", "CONFIG_NOT_FOUND: configuration file was not found");

    expect(formatUpstreamStartupFailure(error, { configPath: "config.json", profile: "work" })).toBe(error.message);
  });
});
