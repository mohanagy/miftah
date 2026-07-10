import { z } from "zod";
import { miftahConfigSchema } from "./schema.js";
import type { MiftahConfig } from "./types.js";
import { MiftahError, type MiftahErrorCode } from "../utils/errors.js";

/** Narrows custom Zod metadata to error codes emitted by config refinements. */
function isConfigIssueCode(value: unknown): value is MiftahErrorCode {
  return value === "DEFAULT_PROFILE_NOT_FOUND" || value === "POLICY_NOT_FOUND";
}

/** Reads a trusted Miftah error code from a custom Zod issue, if present. */
function getIssueCode(issue: z.ZodIssue): MiftahErrorCode | undefined {
  if (issue.code !== z.ZodIssueCode.custom) {
    return undefined;
  }
  const code = issue.params?.miftahCode;
  return isConfigIssueCode(code) ? code : undefined;
}

/** Validates unknown input and returns a normalized Miftah configuration. */
export function validateConfig(input: unknown): MiftahConfig {
  const result = miftahConfigSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    const code = result.error.issues.map(getIssueCode).find((issueCode) => issueCode !== undefined) ?? "CONFIG_SCHEMA_INVALID";
    throw new MiftahError(code, `${code}: ${message}`);
  }
  return result.data;
}
