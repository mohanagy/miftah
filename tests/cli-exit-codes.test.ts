import { describe, expect, it } from "vitest";
import { CliUsageError } from "../src/cli/parse.js";
import {
  CLI_EXIT_CODES,
  ERROR_EXIT_CODES,
  exitCodeForError,
  type CliExitCode
} from "../src/cli/exit-codes.js";
import { MiftahError, type MiftahErrorCode } from "../src/utils/errors.js";

const expectedErrorExitCodes: Record<MiftahErrorCode, CliExitCode> = {
  CONFIG_NOT_FOUND: CLI_EXIT_CODES.config,
  CONFIG_INVALID_JSON: CLI_EXIT_CODES.config,
  CONFIG_SCHEMA_INVALID: CLI_EXIT_CODES.config,
  CONFIG_UNKNOWN_OPTION: CLI_EXIT_CODES.config,
  UNSUPPORTED_CONFIG_VERSION: CLI_EXIT_CODES.config,
  DEFAULT_PROFILE_NOT_FOUND: CLI_EXIT_CODES.config,
  POLICY_NOT_FOUND: CLI_EXIT_CODES.config,
  ROUTING_PROFILE_NOT_FOUND: CLI_EXIT_CODES.config,
  LOCK_PROFILE_NOT_FOUND: CLI_EXIT_CODES.config,
  UPSTREAM_NOT_FOUND: CLI_EXIT_CODES.config,
  UNSUPPORTED_CONFIG_OPTION: CLI_EXIT_CODES.config,
  PROFILE_NOT_FOUND: CLI_EXIT_CODES.config,
  PROFILE_SWITCH_DISABLED: CLI_EXIT_CODES.config,
  SECRET_ENV_MISSING: CLI_EXIT_CODES.secret,
  SECRET_PROVIDER_FAILED: CLI_EXIT_CODES.secret,
  UPSTREAM_START_FAILED: CLI_EXIT_CODES.upstream,
  UPSTREAM_INIT_FAILED: CLI_EXIT_CODES.upstream,
  UPSTREAM_SHUTDOWN_TIMEOUT: CLI_EXIT_CODES.upstream,
  UPSTREAM_CONCURRENCY_LIMIT: CLI_EXIT_CODES.upstream,
  UPSTREAM_RESTART_LIMIT_EXCEEDED: CLI_EXIT_CODES.upstream,
  UPSTREAM_TOOL_LIST_FAILED: CLI_EXIT_CODES.upstream,
  UPSTREAM_DISCOVERY_FAILED: CLI_EXIT_CODES.upstream,
  UPSTREAM_CALL_FAILED: CLI_EXIT_CODES.upstream,
  UPSTREAM_HTTP_ERROR: CLI_EXIT_CODES.upstream,
  UPSTREAM_PROTOCOL_ERROR: CLI_EXIT_CODES.upstream,
  AUDIT_WRITE_FAILED: CLI_EXIT_CODES.operation,
  UPSTREAM_SELECTION_AMBIGUOUS: CLI_EXIT_CODES.upstream,
  ROUTING_AMBIGUOUS: CLI_EXIT_CODES.policy,
  ROUTING_BLOCKED: CLI_EXIT_CODES.policy,
  POLICY_BLOCKED: CLI_EXIT_CODES.policy,
  POLICY_CONFIRMATION_REQUIRED: CLI_EXIT_CODES.policy,
  TOOL_COLLISION: CLI_EXIT_CODES.operation,
  TOOL_NOT_FOUND: CLI_EXIT_CODES.operation,
  TOOL_SCHEMA_MISMATCH: CLI_EXIT_CODES.operation,
  RESOURCE_COLLISION: CLI_EXIT_CODES.operation,
  RESOURCE_NOT_FOUND: CLI_EXIT_CODES.operation,
  RESOURCE_CURSOR_INVALID: CLI_EXIT_CODES.operation,
  RESOURCE_DISCOVERY_INVALIDATED: CLI_EXIT_CODES.operation,
  PROMPT_COLLISION: CLI_EXIT_CODES.operation,
  PROMPT_NOT_FOUND: CLI_EXIT_CODES.operation,
  PROMPT_CURSOR_INVALID: CLI_EXIT_CODES.operation,
  PROMPT_DISCOVERY_INVALIDATED: CLI_EXIT_CODES.operation
};

describe("CLI exit-code mapping", () => {
  it("maps every declared Miftah error code explicitly", () => {
    expect(ERROR_EXIT_CODES).toEqual(expectedErrorExitCodes);
  });

  it("keeps configuration diagnostic collisions distinct from runtime policy and upstream failures", () => {
    expect(ERROR_EXIT_CODES.POLICY_NOT_FOUND).toBe(CLI_EXIT_CODES.config);
    expect(ERROR_EXIT_CODES.POLICY_BLOCKED).toBe(CLI_EXIT_CODES.policy);
    expect(ERROR_EXIT_CODES.UPSTREAM_NOT_FOUND).toBe(CLI_EXIT_CODES.config);
    expect(ERROR_EXIT_CODES.UPSTREAM_START_FAILED).toBe(CLI_EXIT_CODES.upstream);
    expect(ERROR_EXIT_CODES.UPSTREAM_SELECTION_AMBIGUOUS).toBe(CLI_EXIT_CODES.upstream);
    expect(ERROR_EXIT_CODES.ROUTING_PROFILE_NOT_FOUND).toBe(CLI_EXIT_CODES.config);
    expect(ERROR_EXIT_CODES.ROUTING_BLOCKED).toBe(CLI_EXIT_CODES.policy);
  });

  it("maps usage and unclassified errors without changing their output handling", () => {
    expect(exitCodeForError(new CliUsageError("invalid command line"))).toBe(CLI_EXIT_CODES.usage);
    expect(exitCodeForError(new MiftahError("SECRET_ENV_MISSING", "missing secret"))).toBe(CLI_EXIT_CODES.secret);
    expect(exitCodeForError(new Error("unexpected failure"))).toBe(CLI_EXIT_CODES.operation);
  });
});
