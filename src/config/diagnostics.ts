import { z } from "zod";
import type { MiftahErrorCode } from "../utils/errors.js";

export interface ConfigDiagnostic {
  code: MiftahErrorCode;
  path: string;
  severity: "error" | "warning";
  message: string;
  remediation: string;
}

function formatPath(path: (string | number)[]): string {
  return path.map(String).join(".") || "config";
}

function defaultRemediation(code: MiftahErrorCode): string {
  if (code === "UNSUPPORTED_CONFIG_OPTION") {
    return "Remove this option or use a supported alternative from `miftah schema`.";
  }
  return "Correct the value to match `miftah schema`.";
}

function isConfigIssueCode(value: unknown): value is MiftahErrorCode {
  return (
    value === "DEFAULT_PROFILE_NOT_FOUND" ||
    value === "POLICY_NOT_FOUND" ||
    value === "ROUTING_PROFILE_NOT_FOUND" ||
    value === "LOCK_PROFILE_NOT_FOUND" ||
    value === "UPSTREAM_NOT_FOUND" ||
    value === "UNSUPPORTED_CONFIG_VERSION" ||
    value === "UNSUPPORTED_CONFIG_OPTION"
  );
}

function customIssueCode(issue: z.ZodIssue): MiftahErrorCode | undefined {
  if (issue.code !== z.ZodIssueCode.custom) {
    return undefined;
  }
  const code = issue.params?.miftahCode;
  return isConfigIssueCode(code) ? code : undefined;
}

function customRemediation(issue: z.ZodIssue): string | undefined {
  if (issue.code !== z.ZodIssueCode.custom) {
    return undefined;
  }
  const remediation = issue.params?.remediation;
  return typeof remediation === "string" ? remediation : undefined;
}

export function diagnosticsFromZodError(error: z.ZodError): ConfigDiagnostic[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return issue.keys.map((key) => ({
        code: "CONFIG_UNKNOWN_OPTION" as const,
        path: formatPath([...issue.path, key]),
        severity: "error" as const,
        message: `Unknown configuration option '${key}'.`,
        remediation: "Remove it or replace it with a property from `miftah schema`."
      }));
    }

    const code = customIssueCode(issue) ?? "CONFIG_SCHEMA_INVALID";
    return [
      {
        code,
        path: formatPath(issue.path),
        severity: "error",
        message: issue.message,
        remediation: customRemediation(issue) ?? defaultRemediation(code)
      }
    ];
  });
}

export function formatConfigDiagnostics(diagnostics: readonly ConfigDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => `${diagnostic.path}: ${diagnostic.code}: ${diagnostic.message} ${diagnostic.remediation}`)
    .join("; ");
}
