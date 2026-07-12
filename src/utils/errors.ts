import type { ConfigDiagnostic } from "../config/diagnostics.js";

/** Stable error codes exposed to Miftah callers and command-line consumers. */
export type MiftahErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID_JSON"
  | "CONFIG_SCHEMA_INVALID"
  | "CONFIG_UNKNOWN_OPTION"
  | "UNSUPPORTED_CONFIG_VERSION"
  | "DEFAULT_PROFILE_NOT_FOUND"
  | "POLICY_NOT_FOUND"
  | "ROUTING_PROFILE_NOT_FOUND"
  | "LOCK_PROFILE_NOT_FOUND"
  | "UPSTREAM_NOT_FOUND"
  | "UNSUPPORTED_CONFIG_OPTION"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_SWITCH_DISABLED"
  | "SECRET_ENV_MISSING"
  | "SECRET_PROVIDER_FAILED"
  | "SECRET_PROVIDER_UNAVAILABLE"
  | "SECRET_PROVIDER_TIMEOUT"
  | "SECRET_PROVIDER_CANCELLED"
  | "SECRET_PROVIDER_LOCKED"
  | "SECRET_PROVIDER_NONINTERACTIVE"
  | "SECRET_REFERENCE_MALFORMED"
  | "SECRET_ITEM_MISSING"
  | "UPSTREAM_START_FAILED"
  | "UPSTREAM_INIT_FAILED"
  | "UPSTREAM_SHUTDOWN_TIMEOUT"
  | "UPSTREAM_CONCURRENCY_LIMIT"
  | "UPSTREAM_RESTART_LIMIT_EXCEEDED"
  | "UPSTREAM_TOOL_LIST_FAILED"
  | "UPSTREAM_DISCOVERY_FAILED"
  | "UPSTREAM_CALL_FAILED"
  | "UPSTREAM_HTTP_ERROR"
  | "UPSTREAM_PROTOCOL_ERROR"
  | "AUDIT_WRITE_FAILED"
  | "UPSTREAM_SELECTION_AMBIGUOUS"
  | "ROUTING_AMBIGUOUS"
  | "ROUTING_BLOCKED"
  | "POLICY_BLOCKED"
  | "POLICY_CONFIRMATION_REQUIRED"
  | "TOOL_COLLISION"
  | "TOOL_NOT_FOUND"
  | "TOOL_SCHEMA_MISMATCH"
  | "RESOURCE_COLLISION"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_CURSOR_INVALID"
  | "RESOURCE_DISCOVERY_INVALIDATED"
  | "PROMPT_COLLISION"
  | "PROMPT_NOT_FOUND"
  | "PROMPT_CURSOR_INVALID"
  | "PROMPT_DISCOVERY_INVALIDATED"
  | "IDENTITY_NOT_CONFIGURED"
  | "IDENTITY_MISMATCH"
  | "IDENTITY_PROBE_UNSUPPORTED"
  | "IDENTITY_VERIFICATION_FAILED";

export interface MiftahErrorDetails {
  readonly diagnostics?: readonly ConfigDiagnostic[];
  readonly [key: string]: unknown;
}

/** Error carrying a machine-readable Miftah code and optional structured context. */
export class MiftahError extends Error {
  readonly code: MiftahErrorCode;
  readonly details?: MiftahErrorDetails;

  /** Creates a Miftah error with a stable code, message, and optional diagnostic details. */
  constructor(code: MiftahErrorCode, message: string, details?: MiftahErrorDetails) {
    super(message);
    this.name = "MiftahError";
    this.code = code;
    this.details = details;
  }
}
