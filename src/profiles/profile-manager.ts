import type { ProfileConfig } from "../config/types.js";
import { MiftahError } from "../utils/errors.js";

interface ProfileCollection {
  defaultProfile: string;
  profiles: Record<string, ProfileConfig>;
}

export interface ProfileManagerOptions {
  allowProfileSwitchingFromMcp?: boolean;
  lockToProfile?: string | null;
}

export interface ProfileInfo {
  name: string;
  description: string;
  tags: string[];
  envKeys: string[];
}

export class ProfileManager {
  private activeProfile: string;
  private revision = 0;
  private readonly collection: ProfileCollection;
  private readonly options: ProfileManagerOptions;

  constructor(collection: ProfileCollection, options: ProfileManagerOptions = {}) {
    this.collection = collection;
    this.activeProfile = options.lockToProfile ?? collection.defaultProfile;
    this.options = options;
  }

  current(): { activeProfile: string; defaultProfile: string; revision: number } {
    return { activeProfile: this.activeProfile, defaultProfile: this.collection.defaultProfile, revision: this.revision };
  }

  switch(profile: string): { previousProfile: string; activeProfile: string; revision: number } {
    if (this.options.allowProfileSwitchingFromMcp === false || this.options.lockToProfile) {
      throw new MiftahError("PROFILE_SWITCH_DISABLED", "PROFILE_SWITCH_DISABLED: profile switching is disabled");
    }
    this.ensureExists(profile);
    const previousProfile = this.activeProfile;
    this.activeProfile = profile;
    this.revision += 1;
    return { previousProfile, activeProfile: profile, revision: this.revision };
  }

  reset(): { previousProfile: string; activeProfile: string; revision: number } {
    const previousProfile = this.activeProfile;
    this.activeProfile = this.collection.defaultProfile;
    this.revision += 1;
    return { previousProfile, activeProfile: this.activeProfile, revision: this.revision };
  }

  get(profile = this.activeProfile): ProfileConfig {
    this.ensureExists(profile);
    return this.collection.profiles[profile]!;
  }

  list(): ProfileInfo[] {
    return Object.entries(this.collection.profiles).map(([name, profile]) => this.toInfo(name, profile));
  }

  info(profile: string): ProfileInfo {
    this.ensureExists(profile);
    return this.toInfo(profile, this.collection.profiles[profile]!);
  }

  private toInfo(name: string, profile: ProfileConfig): ProfileInfo {
    return {
      name,
      description: profile.description ?? "",
      tags: profile.tags ?? [],
      envKeys: Object.keys(profile.env ?? {})
    };
  }

  private ensureExists(profile: string): void {
    if (!this.collection.profiles[profile]) {
      throw new MiftahError("PROFILE_NOT_FOUND", `PROFILE_NOT_FOUND: profile '${profile}' does not exist`);
    }
  }
}
