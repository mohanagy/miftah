export type MiftahErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID_JSON"
  | "CONFIG_SCHEMA_INVALID"
  | "DEFAULT_PROFILE_NOT_FOUND"
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

export class MiftahError extends Error {
  readonly code: MiftahErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: MiftahErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MiftahError";
    this.code = code;
    this.details = details;
  }
}
