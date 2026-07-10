import type { z } from "zod";
import { miftahConfigSchema, miftahPublicConfigSchema } from "./schema.js";
import type { MiftahConfig } from "./types.js";
import { diagnosticsFromZodError, formatConfigDiagnostics } from "./diagnostics.js";
import { MiftahError } from "../utils/errors.js";

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
  return publicResult.data;
}
