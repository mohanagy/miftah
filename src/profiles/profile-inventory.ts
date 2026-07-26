import type { MiftahConfig } from "../config/types.js";

/** Fixed, non-secret metadata that identifies one configured account profile. */
export interface ProfileInventoryEntry {
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly policy?: string;
  /** Profile-level override names only; never their launch or credential data. */
  readonly upstreams?: readonly string[];
}

/** Read-only, redacted inventory for selecting or reviewing configured accounts. */
export interface ProfileInventory {
  readonly defaultProfile: string;
  readonly profiles: readonly ProfileInventoryEntry[];
}

/**
 * Projects a configuration to the small account inventory safe for CLI and
 * Console output. It neither resolves secret references nor returns launch,
 * header, environment, working-directory, identity, or OAuth data.
 */
export function profileInventory(config: MiftahConfig): ProfileInventory {
  return {
    defaultProfile: config.defaultProfile,
    profiles: Object.entries(config.profiles)
      .map(([name, profile]) => ({
        name,
        ...(profile.description === undefined ? {} : { description: profile.description }),
        ...(profile.tags === undefined ? {} : { tags: [...profile.tags] }),
        ...(profile.policy === undefined ? {} : { policy: profile.policy }),
        ...(profile.upstreams === undefined ? {} : { upstreams: Object.keys(profile.upstreams).sort() })
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}
