import type { ConfigMigrationSource } from "../cli/migrate-config.js";
import type { MiftahConfig } from "../config/types.js";

/**
 * An in-memory configuration captured from a verified, opened catalog entry.
 * This stays inside the Console process and is never serialized to its HTTP API.
 */
export interface ConsoleTrustedConfiguration {
  readonly config: MiftahConfig;
  /** Opaque digest used to bind a user selection to exactly the verified bytes. */
  readonly contentDigest: string;
  /** Exact source bytes/fingerprint for an explicitly requested guarded mutation. */
  readonly migrationSource: ConfigMigrationSource;
}
