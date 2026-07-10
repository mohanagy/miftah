import { miftahConfigSchema } from "./schema.js";
import type { MiftahConfig } from "./types.js";
import { MiftahError } from "../utils/errors.js";

export function validateConfig(input: unknown): MiftahConfig {
  const result = miftahConfigSchema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    const code = message.includes("DEFAULT_PROFILE_NOT_FOUND")
      ? "DEFAULT_PROFILE_NOT_FOUND"
      : "CONFIG_SCHEMA_INVALID";
    throw new MiftahError(code, `${code}: ${message}`);
  }
  return result.data;
}
