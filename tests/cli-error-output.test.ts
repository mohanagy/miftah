import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatUpstreamStartupFailure } from "../src/cli/error-output.js";
import { MiftahError } from "../src/utils/errors.js";

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("process.platform descriptor was unavailable");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return callback();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

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

    const output = withPlatform("linux", () => formatUpstreamStartupFailure(error, {
      configPath: "/tmp/$HOME/config.json",
      profile: "team's-profile"
    }));

    expect(output).toContain("--config '/tmp/$HOME/config.json' --profile 'team'\"'\"'s-profile'");
  });

  it.runIf(process.platform !== "win32")("round-trips diagnostic command arguments through a POSIX shell", () => {
    const error = new MiftahError("UPSTREAM_INIT_FAILED", "UPSTREAM_INIT_FAILED", {
      startupDiagnostic: {
        errorCode: "UPSTREAM_INIT_FAILED",
        kind: "initialization",
        cause: "safe cause",
        truncated: false,
        remediation: "Retry."
      }
    });
    const configPath = "/tmp/$HOME/owner's config.json";
    const profile = "team's-profile";
    const output = formatUpstreamStartupFailure(error, { configPath, profile });
    const retryCommand = output
      .split("\n")
      .find((line) => line.startsWith("Retry: "))
      ?.slice("Retry: ".length);

    if (retryCommand === undefined) {
      throw new Error("Expected a retry command in the formatted diagnostic.");
    }
    expect(retryCommand).toBe(
      "miftah test-profile --config '/tmp/$HOME/owner'\"'\"'s config.json' --profile 'team'\"'\"'s-profile'"
    );
    const receivedArguments = execFileSync(
      "/bin/sh",
      ["-c", ['miftah() { printf "%s\\n" "$@"; }', retryCommand].join("\n")],
      { encoding: "utf8" }
    )
      .trimEnd()
      .split("\n");

    expect(receivedArguments).toEqual(["test-profile", "--config", configPath, "--profile", profile]);
  });

  it("renders Windows diagnostic command arguments explicitly for PowerShell", () => {
    const error = new MiftahError("UPSTREAM_INIT_FAILED", "UPSTREAM_INIT_FAILED", {
      startupDiagnostic: {
        errorCode: "UPSTREAM_INIT_FAILED",
        kind: "initialization",
        cause: "safe cause",
        truncated: false,
        remediation: "Retry."
      }
    });
    const output = withPlatform("win32", () => formatUpstreamStartupFailure(error, {
      configPath: "C:\\Miftah $env:USER owner's config.json",
      profile: "team's-profile"
    }));

    expect(output).toContain(
      "Retry in PowerShell: miftah test-profile --config 'C:\\Miftah $env:USER owner''s config.json' --profile 'team''s-profile'"
    );
  });

  it.runIf(process.platform === "win32")("round-trips diagnostic command arguments through PowerShell", () => {
    const error = new MiftahError("UPSTREAM_INIT_FAILED", "UPSTREAM_INIT_FAILED", {
      startupDiagnostic: {
        errorCode: "UPSTREAM_INIT_FAILED",
        kind: "initialization",
        cause: "safe cause",
        truncated: false,
        remediation: "Retry."
      }
    });
    const configPath = "C:\\Miftah $env:USER owner's config.json";
    const profile = "team's-profile";
    const output = formatUpstreamStartupFailure(error, { configPath, profile });
    const retryCommand = output
      .split("\n")
      .find((line) => line.startsWith("Retry in PowerShell: "))
      ?.slice("Retry in PowerShell: ".length);

    if (retryCommand === undefined) {
      throw new Error("Expected a PowerShell retry command in the formatted diagnostic.");
    }
    const receivedArguments = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "function miftah { $args | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)) } }",
          retryCommand
        ].join("; ")
      ],
      { encoding: "utf8" }
    )
      .trim()
      .split(/\r?\n/u)
      .map((value) => Buffer.from(value, "base64").toString("utf8"));

    expect(receivedArguments).toEqual(["test-profile", "--config", configPath, "--profile", profile]);
  });

  it("falls back to the safe top-level message for unrelated errors", () => {
    const error = new MiftahError("CONFIG_NOT_FOUND", "CONFIG_NOT_FOUND: configuration file was not found");

    expect(formatUpstreamStartupFailure(error, { configPath: "config.json", profile: "work" })).toBe(error.message);
  });
});
