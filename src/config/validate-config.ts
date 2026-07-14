import type { z } from "zod";
import { miftahConfigSchema, miftahPublicConfigSchema } from "./schema.js";
import type { MiftahConfig } from "./types.js";
import { diagnosticsFromZodError, formatConfigDiagnostics } from "./diagnostics.js";
import { MiftahError } from "../utils/errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Post-Zod narrowing only; miftahPublicConfigSchema owns runtime identity acceptance and rejection. */
function isIdentityConfig(value: unknown): value is MiftahConfig["profiles"][string]["identity"] {
  if (!isRecord(value) || !isRecord(value.expected) || !isRecord(value.probe)) return false;
  const { expected, probe } = value;

  if (probe.resultFormat === "json") {
    return (
      probe.provider === undefined &&
      (expected.provider !== undefined ||
        expected.login !== undefined ||
        expected.organization !== undefined ||
        expected.host !== undefined)
    );
  }

  return (
    probe.resultFormat === "text" &&
    typeof expected.login === "string" &&
    expected.organization === undefined &&
    expected.host === undefined &&
    (expected.provider === undefined || typeof probe.provider === "string")
  );
}

function isMiftahConfig(value: z.output<typeof miftahPublicConfigSchema>): value is MiftahConfig {
  return Object.values(value.profiles).every(
    (profile) =>
      (profile.identity === undefined || isIdentityConfig(profile.identity)) &&
      Object.values(profile.upstreams ?? {}).every(
        (upstream) => upstream.identity === undefined || isIdentityConfig(upstream.identity)
      )
  );
}

function validationError(error: z.ZodError): MiftahError {
  const diagnostics = diagnosticsFromZodError(error);
  const code = diagnostics.find((diagnostic) => diagnostic.code !== "CONFIG_SCHEMA_INVALID")?.code ?? "CONFIG_SCHEMA_INVALID";
  return new MiftahError(code, `${code}: ${formatConfigDiagnostics(diagnostics)}`, { diagnostics });
}

/** Validates unknown input and returns a normalized Miftah configuration. */
export function validateConfig(input: unknown): MiftahConfig {
  const result = miftahConfigSchema.safeParse(input);
  if (!result.success) {
    throw validationError(result.error);
  }
  const publicResult = miftahPublicConfigSchema.safeParse(result.data);
  if (!publicResult.success) {
    throw validationError(publicResult.error);
  }
  if (!isMiftahConfig(publicResult.data)) {
    throw new MiftahError("CONFIG_SCHEMA_INVALID", "CONFIG_SCHEMA_INVALID: identity configuration is invalid");
  }
  return publicResult.data;
}
