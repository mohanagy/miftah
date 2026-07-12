import type { ProfileConfig } from "../config/types.js";
import { MiftahError } from "../utils/errors.js";
import {
  ProfileStateStore,
  type ProfileStateDiagnostic,
  type ProfileStateOptions,
  type ProfileStateScope,
  profileStateScope
} from "./profile-state.js";

interface ProfileCollection {
  defaultProfile: string;
  profiles: Record<string, ProfileConfig>;
}

export interface ProfileManagerOptions {
  allowProfileSwitchingFromMcp?: boolean;
  lockToProfile?: string | null;
}

export interface ProfileSelection {
  readonly selectionSource:
    | "configured-default"
    | "configured-lock"
    | "persisted-workspace"
    | "persisted-global"
    | "mcp-switch"
    | "reset";
  readonly selectedAt: string;
  readonly scope: ProfileStateScope;
  readonly stateDiagnostic?: ProfileStateDiagnostic;
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
  private readonly stateStore: ProfileStateStore | undefined;
  private readonly scope: ProfileStateScope;
  private selection: ProfileSelection;
  private transitions: Promise<void> = Promise.resolve();

  constructor(
    collection: ProfileCollection,
    options: ProfileManagerOptions = {},
    stateOptions?: ProfileStateOptions
  ) {
    this.collection = collection;
    this.activeProfile = options.lockToProfile ?? collection.defaultProfile;
    this.options = options;
    this.scope = stateOptions === undefined ? "process" : profileStateScope(stateOptions);
    this.stateStore = stateOptions === undefined ? undefined : new ProfileStateStore(stateOptions);
    this.selection = {
      selectionSource: options.lockToProfile ? "configured-lock" : "configured-default",
      selectedAt: new Date().toISOString(),
      scope: this.scope
    };
  }

  current(): { activeProfile: string; defaultProfile: string; revision: number } & ProfileSelection {
    return {
      activeProfile: this.activeProfile,
      defaultProfile: this.collection.defaultProfile,
      revision: this.revision,
      ...this.selection
    };
  }

  async initialize(): Promise<void> {
    if (this.options.lockToProfile || this.stateStore === undefined || !this.stateStore.persistent) return;
    const stored = await this.stateStore.load();
    if (stored.kind === "valid") {
      if (this.collection.profiles[stored.profile]) {
        this.activeProfile = stored.profile;
        this.selection = {
          selectionSource: this.scope === "workspace" ? "persisted-workspace" : "persisted-global",
          selectedAt: stored.selectedAt,
          scope: this.scope
        };
      } else {
        this.selection = { ...this.selection, stateDiagnostic: "PROFILE_STATE_STALE" };
      }
      return;
    }
    if (stored.kind === "invalid") {
      this.selection = { ...this.selection, stateDiagnostic: "PROFILE_STATE_INVALID" };
    } else if (stored.kind === "unavailable") {
      this.selection = { ...this.selection, stateDiagnostic: "PROFILE_STATE_UNAVAILABLE" };
    }
  }

  /** Starts a fresh in-memory selection for one MCP session. */
  async beginSession(): Promise<void> {
    if (this.scope !== "session") return;
    await this.enqueue(async () => {
      this.activeProfile = this.options.lockToProfile ?? this.collection.defaultProfile;
      this.revision += 1;
      this.selection = {
        selectionSource: this.options.lockToProfile ? "configured-lock" : "configured-default",
        selectedAt: new Date().toISOString(),
        scope: this.scope
      };
    });
  }

  switch(profile: string): { previousProfile: string; activeProfile: string; revision: number } {
    this.ensureSwitchingEnabled();
    return this.commit(profile, "mcp-switch");
  }

  async switchPersisted(profile: string): Promise<{ previousProfile: string; activeProfile: string; revision: number }> {
    return this.enqueue(async () => {
      this.ensureSwitchingEnabled();
      return this.persistAndCommit(profile, "mcp-switch");
    });
  }

  reset(): { previousProfile: string; activeProfile: string; revision: number } {
    return this.commit(this.collection.defaultProfile, "reset");
  }

  async resetPersisted(): Promise<{ previousProfile: string; activeProfile: string; revision: number }> {
    return this.enqueue(() => this.persistAndCommit(this.collection.defaultProfile, "reset"));
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

  private ensureSwitchingEnabled(): void {
    if (this.options.allowProfileSwitchingFromMcp === false || this.options.lockToProfile) {
      throw new MiftahError("PROFILE_SWITCH_DISABLED", "PROFILE_SWITCH_DISABLED: profile switching is disabled");
    }
  }

  private commit(
    profile: string,
    selectionSource: Extract<ProfileSelection["selectionSource"], "mcp-switch" | "reset">
  ): { previousProfile: string; activeProfile: string; revision: number } {
    this.ensureExists(profile);
    const previousProfile = this.activeProfile;
    this.activeProfile = profile;
    this.revision += 1;
    this.selection = { selectionSource, selectedAt: new Date().toISOString(), scope: this.scope };
    return { previousProfile, activeProfile: profile, revision: this.revision };
  }

  private async persistAndCommit(
    profile: string,
    selectionSource: Extract<ProfileSelection["selectionSource"], "mcp-switch" | "reset">
  ): Promise<{ previousProfile: string; activeProfile: string; revision: number }> {
    this.ensureExists(profile);
    const selectedAt = new Date().toISOString();
    if (this.stateStore?.persistent) {
      try {
        await this.stateStore.save(profile, selectedAt);
      } catch {
        throw new MiftahError(
          "PROFILE_STATE_WRITE_FAILED",
          "PROFILE_STATE_WRITE_FAILED: unable to persist the active profile"
        );
      }
    }
    const previousProfile = this.activeProfile;
    this.activeProfile = profile;
    this.revision += 1;
    this.selection = { selectionSource, selectedAt, scope: this.scope };
    return { previousProfile, activeProfile: profile, revision: this.revision };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitions.then(operation, operation);
    this.transitions = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
