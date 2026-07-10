/** Stable error codes exposed to Miftah callers and command-line consumers. */
export type MiftahErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID_JSON"
  | "CONFIG_SCHEMA_INVALID"
  | "DEFAULT_PROFILE_NOT_FOUND"
  | "POLICY_NOT_FOUND"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_SWITCH_DISABLED"
  | "SECRET_ENV_MISSING"
  | "SECRET_PROVIDER_FAILED"
  | "UPSTREAM_START_FAILED"
  | "UPSTREAM_INIT_FAILED"
  | "UPSTREAM_TOOL_LIST_FAILED"
  | "UPSTREAM_CALL_FAILED"
  | "ROUTING_AMBIGUOUS"
  | "ROUTING_BLOCKED"
  | "POLICY_BLOCKED"
  | "TOOL_COLLISION";

/** Error carrying a machine-readable Miftah code and optional structured context. */
export class MiftahError extends Error {
  readonly code: MiftahErrorCode;
  readonly details?: Record<string, unknown>;

  /** Creates a Miftah error with a stable code, message, and optional diagnostic details. */
  constructor(code: MiftahErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MiftahError";
    this.code = code;
    this.details = details;
  }
}
