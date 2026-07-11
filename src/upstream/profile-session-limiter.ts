import { MiftahError } from "../utils/errors.js";

/**
 * Reserves a bounded number of distinct profile session bundles without evicting active processes.
 */
export class ProfileSessionLimiter {
  private readonly ownersByProfile = new Map<string, Set<string>>();

  constructor(private readonly maximumProfiles?: number) {}

  /** Acquires this owner's share of a profile slot, rejecting a new profile when the global limit is reached. */
  acquire(profile: string, owner: string): boolean {
    const existingOwners = this.ownersByProfile.get(profile);
    if (existingOwners?.has(owner)) return false;
    if (existingOwners === undefined && this.maximumProfiles !== undefined && this.ownersByProfile.size >= this.maximumProfiles) {
      throw new MiftahError(
        "UPSTREAM_CONCURRENCY_LIMIT",
        `UPSTREAM_CONCURRENCY_LIMIT: cannot start profile '${profile}' because ${this.maximumProfiles} profile session(s) are already active`
      );
    }
    const owners = existingOwners ?? new Set<string>();
    owners.add(owner);
    this.ownersByProfile.set(profile, owners);
    return true;
  }

  /** Releases an owner's share and frees the profile slot after its final upstream stops. */
  release(profile: string, owner: string): void {
    const owners = this.ownersByProfile.get(profile);
    if (!owners) return;
    owners.delete(owner);
    if (owners.size === 0) this.ownersByProfile.delete(profile);
  }
}
