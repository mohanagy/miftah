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
  requireProfileSwitchConfirmation?: boolean;
  allowProfileLockingFromMcp?: boolean;
  lockToProfile?: string | null;
}

export interface ProfileManagerRuntimeOptions {
  /** Internal clock injection for deterministic lease transitions. */
  now?: () => Date;
}

export type ProfileLeaseStatus =
  | { readonly state: "not-required" }
  | {
      readonly state: "required";
      readonly profile: string;
      readonly requiredForRisk: readonly ("write" | "destructive")[];
    }
  | {
      readonly state: "active" | "expired";
      readonly profile: string;
      readonly expiresAt: string;
      readonly requiredForRisk: readonly ("write" | "destructive")[];
    };

export type ProfileLockStatus =
  | { readonly state: "none" }
  | { readonly state: "configured" | "runtime"; readonly profile: string; readonly lockedAt?: string };

export interface ProfileSelection {
  readonly selectionSource:
    | "configured-default"
    | "configured-lock"
    | "persisted-workspace"
    | "persisted-global"
    | "prior-session"
    | "mcp-switch"
    | "reset";
  readonly selectedAt: string;
  readonly scope: ProfileStateScope;
  readonly confirmation: "not-required" | "not-confirmed" | "confirmed";
  readonly stateDiagnostic?: ProfileStateDiagnostic;
  readonly lease: ProfileLeaseStatus;
  readonly lock: ProfileLockStatus;
}

type ProfileSelectionMetadata = Omit<ProfileSelection, "lease" | "lock">;

interface ActiveProfileLease {
  readonly profile: string;
  readonly expiresAtMs: number;
  readonly expiresAt: string;
  readonly requiredForRisk: readonly ("write" | "destructive")[];
}

interface RuntimeProfileLock {
  readonly profile: string;
  readonly lockedAt: string;
}

interface DurableSelection {
  readonly profile: string;
  readonly selectedAt: string;
}

interface ProfileMutationSnapshot {
  readonly activeProfile: string;
  readonly revision: number;
  readonly selection: ProfileSelectionMetadata;
  readonly lease?: ActiveProfileLease;
  readonly runtimeLock?: RuntimeProfileLock;
  readonly durableSelection?: DurableSelection;
}

export interface ProfileTransitionOptions {
  /** Rejects an asynchronous transition if selection state changed before it can commit. */
  expectedRevision?: number;
  /** @internal An opaque, one-time confirmation proof minted by the connected MCP server. */
  confirmation?: object;
}

export interface ProfileTransitionConfirmationRequest {
  readonly proof: object;
  readonly action: "switch" | "reset";
  readonly profile: string;
  readonly revision: number;
}

type ProfileTransitionConfirmationVerifier = (request: ProfileTransitionConfirmationRequest) => boolean;

const transitionConfirmationVerifiers = new WeakMap<ProfileManager, ProfileTransitionConfirmationVerifier>();

/** @internal Binds a manager to the server that mints one-time confirmation proofs for its MCP connection. */
export function bindProfileTransitionConfirmationVerifier(
  manager: ProfileManager,
  verifier: ProfileTransitionConfirmationVerifier
): void {
  if (transitionConfirmationVerifiers.has(manager)) {
    throw new Error("A profile transition confirmation verifier is already bound to this profile manager.");
  }
  transitionConfirmationVerifiers.set(manager, verifier);
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
  private readonly now: () => Date;
  private selection: ProfileSelectionMetadata;
  private lease: ActiveProfileLease | undefined;
  private runtimeLock: RuntimeProfileLock | undefined;
  private durableSelection: DurableSelection | undefined;
  private transitions: Promise<void> = Promise.resolve();

  constructor(
    collection: ProfileCollection,
    options: ProfileManagerOptions = {},
    stateOptions?: ProfileStateOptions,
    runtimeOptions: ProfileManagerRuntimeOptions = {}
  ) {
    this.collection = collection;
    this.activeProfile = options.lockToProfile ?? collection.defaultProfile;
    this.options = options;
    this.scope = stateOptions === undefined ? "process" : profileStateScope(stateOptions);
    this.stateStore = stateOptions === undefined ? undefined : new ProfileStateStore(stateOptions);
    this.now = runtimeOptions.now ?? (() => new Date());
    this.selection = {
      selectionSource: options.lockToProfile ? "configured-lock" : "configured-default",
      selectedAt: this.now().toISOString(),
      scope: this.scope,
      confirmation: this.initialConfirmation()
    };
  }

  current(): { activeProfile: string; defaultProfile: string; revision: number } & ProfileSelection {
    return {
      activeProfile: this.activeProfile,
      defaultProfile: this.collection.defaultProfile,
      revision: this.revision,
      ...this.selection,
      lease: this.leaseStatus(),
      lock: this.lockStatus()
    };
  }

  async initialize(): Promise<void> {
    if (this.options.lockToProfile || this.stateStore === undefined || !this.stateStore.persistent) return;
    const stored = await this.stateStore.load();
    if (stored.kind === "valid") {
      if (Object.hasOwn(this.collection.profiles, stored.profile)) {
        this.activeProfile = stored.profile;
        this.selection = {
          selectionSource: this.scope === "workspace" ? "persisted-workspace" : "persisted-global",
          selectedAt: stored.selectedAt,
          scope: this.scope,
          confirmation: this.initialConfirmation()
        };
        this.durableSelection = { profile: stored.profile, selectedAt: stored.selectedAt };
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
    await this.enqueue(async () => {
      this.lease = undefined;
      this.runtimeLock = undefined;
      if (this.scope !== "session") {
        this.revision += 1;
        if (this.selection.selectionSource === "mcp-switch" || this.selection.selectionSource === "reset") {
          this.selection = {
            ...this.selection,
            selectionSource: "prior-session",
            confirmation: this.initialConfirmation()
          };
        }
        return;
      }
      this.activeProfile = this.options.lockToProfile ?? this.collection.defaultProfile;
      this.revision += 1;
      this.selection = {
        selectionSource: this.options.lockToProfile ? "configured-lock" : "configured-default",
        selectedAt: this.now().toISOString(),
        scope: this.scope,
        confirmation: this.initialConfirmation()
      };
    });
  }

  switch(
    profile: string,
    transition: ProfileTransitionOptions = {}
  ): { previousProfile: string; activeProfile: string; revision: number } {
    this.ensureSwitchingEnabled();
    return this.commit(profile, "mcp-switch", transition);
  }

  async switchPersisted(
    profile: string,
    transition: ProfileTransitionOptions = {}
  ): Promise<{ previousProfile: string; activeProfile: string; revision: number }> {
    return this.enqueue(async () => {
      this.ensureSwitchingEnabled();
      return this.persistAndCommit(profile, "mcp-switch", transition);
    });
  }

  reset(transition: ProfileTransitionOptions = {}): { previousProfile: string; activeProfile: string; revision: number } {
    this.ensureSwitchingEnabled();
    return this.commit(this.collection.defaultProfile, "reset", transition);
  }

  async resetPersisted(
    transition: ProfileTransitionOptions = {}
  ): Promise<{ previousProfile: string; activeProfile: string; revision: number }> {
    return this.enqueue(async () => {
      this.ensureSwitchingEnabled();
      return this.persistAndCommit(this.collection.defaultProfile, "reset", transition);
    });
  }

  /**
   * Runs an in-memory or durable profile mutation, then rolls it back if its required audit transition cannot be written.
   * The caller must serialize related side effects around this method.
   */
  async mutateAudited<Result>(
    mutate: () => Result | Promise<Result>,
    writeAudit: (result: Result) => Promise<void>
  ): Promise<Result> {
    const snapshot = this.captureMutationSnapshot();
    const result = await mutate();
    try {
      await writeAudit(result);
      return result;
    } catch (error) {
      try {
        await this.restoreMutationSnapshot(snapshot);
      } catch {
        throw new MiftahError(
          "PROFILE_STATE_WRITE_FAILED",
          "PROFILE_STATE_WRITE_FAILED: unable to roll back profile state after a required audit transition failed"
        );
      }
      throw error;
    }
  }

  /** Locks the currently selected profile for this MCP session without persisting any lock state. */
  lock(): { profile: string; lockedAt: string; revision: number } {
    this.ensureLockingEnabled();
    const lockedAt = this.now().toISOString();
    this.runtimeLock = { profile: this.activeProfile, lockedAt };
    this.revision += 1;
    return { profile: this.activeProfile, lockedAt, revision: this.revision };
  }

  /** Clears a session-bound runtime lock while preserving stronger configured locks. */
  unlock(): { profile: string; revision: number } {
    this.ensureLockingEnabled();
    const profile = this.runtimeLock?.profile ?? this.activeProfile;
    if (this.runtimeLock !== undefined) {
      this.runtimeLock = undefined;
      this.revision += 1;
    }
    return { profile, revision: this.revision };
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
    if (!Object.hasOwn(this.collection.profiles, profile)) {
      throw new MiftahError("PROFILE_NOT_FOUND", `PROFILE_NOT_FOUND: profile '${profile}' does not exist`);
    }
  }

  private ensureSwitchingEnabled(): void {
    if (this.options.allowProfileSwitchingFromMcp === false || this.options.lockToProfile) {
      throw new MiftahError("PROFILE_SWITCH_DISABLED", "PROFILE_SWITCH_DISABLED: profile switching is disabled");
    }
    if (this.runtimeLock !== undefined) {
      throw new MiftahError(
        "PROFILE_LOCKED",
        `PROFILE_LOCKED: profile '${this.runtimeLock.profile}' is locked for this session`
      );
    }
  }

  private ensureLockingEnabled(): void {
    if (this.options.lockToProfile) {
      throw new MiftahError("PROFILE_LOCKED", "PROFILE_LOCKED: configured profile locks cannot be changed at runtime");
    }
    if (this.options.allowProfileLockingFromMcp !== true) {
      throw new MiftahError(
        "PROFILE_LOCKING_DISABLED",
        "PROFILE_LOCKING_DISABLED: runtime profile locking is disabled"
      );
    }
  }

  private confirmationFor(
    profile: string,
    selectionSource: Extract<ProfileSelection["selectionSource"], "mcp-switch" | "reset">,
    transition: ProfileTransitionOptions
  ): ProfileSelection["confirmation"] {
    if (this.options.requireProfileSwitchConfirmation !== true) return "not-required";
    const verifier = transitionConfirmationVerifiers.get(this);
    const action = selectionSource === "mcp-switch" ? "switch" : "reset";
    if (
      transition.confirmation === undefined ||
      transition.expectedRevision === undefined ||
      verifier?.({ proof: transition.confirmation, action, profile, revision: transition.expectedRevision }) !== true
    ) {
      throw new MiftahError(
        "PROFILE_SWITCH_CONFIRMATION_REQUIRED",
        "PROFILE_SWITCH_CONFIRMATION_REQUIRED: profile switch requires confirmation"
      );
    }
    return "confirmed";
  }

  private ensureExpectedRevision(transition: ProfileTransitionOptions): void {
    if (transition.expectedRevision !== undefined && transition.expectedRevision !== this.revision) {
      throw new MiftahError(
        "PROFILE_SELECTION_STALE",
        "PROFILE_SELECTION_STALE: profile selection changed before the transition could be applied"
      );
    }
  }

  private initialConfirmation(): ProfileSelection["confirmation"] {
    return this.options.requireProfileSwitchConfirmation === true ? "not-confirmed" : "not-required";
  }

  private commit(
    profile: string,
    selectionSource: Extract<ProfileSelection["selectionSource"], "mcp-switch" | "reset">,
    transition: ProfileTransitionOptions
  ): { previousProfile: string; activeProfile: string; revision: number } {
    this.ensureExists(profile);
    this.ensureExpectedRevision(transition);
    const confirmation = this.confirmationFor(profile, selectionSource, transition);
    const previousProfile = this.activeProfile;
    this.activeProfile = profile;
    this.revision += 1;
    const selectedAt = this.now();
    this.selection = {
      selectionSource,
      selectedAt: selectedAt.toISOString(),
      scope: this.scope,
      confirmation
    };
    this.issueLease(profile, selectedAt);
    return { previousProfile, activeProfile: profile, revision: this.revision };
  }

  private async persistAndCommit(
    profile: string,
    selectionSource: Extract<ProfileSelection["selectionSource"], "mcp-switch" | "reset">,
    transition: ProfileTransitionOptions
  ): Promise<{ previousProfile: string; activeProfile: string; revision: number }> {
    this.ensureExists(profile);
    this.ensureExpectedRevision(transition);
    const confirmation = this.confirmationFor(profile, selectionSource, transition);
    const selectedAt = this.now();
    const selectedAtIso = selectedAt.toISOString();
    if (this.stateStore?.persistent) {
      try {
        await this.stateStore.save(profile, selectedAtIso);
      } catch {
        throw new MiftahError(
          "PROFILE_STATE_WRITE_FAILED",
          "PROFILE_STATE_WRITE_FAILED: unable to persist the active profile"
        );
      }
      this.durableSelection = { profile, selectedAt: selectedAtIso };
    }
    const previousProfile = this.activeProfile;
    this.activeProfile = profile;
    this.revision += 1;
    this.selection = {
      selectionSource,
      selectedAt: selectedAtIso,
      scope: this.scope,
      confirmation
    };
    this.issueLease(profile, selectedAt);
    return { previousProfile, activeProfile: profile, revision: this.revision };
  }

  private issueLease(profile: string, selectedAt: Date): void {
    const configuration = this.collection.profiles[profile]!.lease;
    if (configuration === undefined) {
      this.lease = undefined;
      return;
    }
    const expiresAtMs = selectedAt.getTime() + configuration.ttlMs;
    this.lease = {
      profile,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      requiredForRisk: [...configuration.requiredForRisk]
    };
  }

  private captureMutationSnapshot(): ProfileMutationSnapshot {
    return {
      activeProfile: this.activeProfile,
      revision: this.revision,
      selection: { ...this.selection },
      ...(this.lease === undefined
        ? {}
        : {
            lease: {
              ...this.lease,
              requiredForRisk: [...this.lease.requiredForRisk]
            }
          }),
      ...(this.runtimeLock === undefined ? {} : { runtimeLock: { ...this.runtimeLock } }),
      ...(this.durableSelection === undefined ? {} : { durableSelection: { ...this.durableSelection } })
    };
  }

  private async restoreMutationSnapshot(snapshot: ProfileMutationSnapshot): Promise<void> {
    let persistenceFailure: unknown;
    try {
      if (this.stateStore?.persistent) {
        if (snapshot.durableSelection === undefined) await this.stateStore.clear();
        else await this.stateStore.save(snapshot.durableSelection.profile, snapshot.durableSelection.selectedAt);
      }
    } catch (error) {
      persistenceFailure = error;
    }
    this.activeProfile = snapshot.activeProfile;
    this.revision = snapshot.revision;
    this.selection = { ...snapshot.selection };
    this.lease =
      snapshot.lease === undefined
        ? undefined
        : { ...snapshot.lease, requiredForRisk: [...snapshot.lease.requiredForRisk] };
    this.runtimeLock = snapshot.runtimeLock === undefined ? undefined : { ...snapshot.runtimeLock };
    this.durableSelection = snapshot.durableSelection === undefined ? undefined : { ...snapshot.durableSelection };
    if (persistenceFailure !== undefined) throw persistenceFailure;
  }

  private leaseStatus(): ProfileLeaseStatus {
    const configuration = this.collection.profiles[this.activeProfile]!.lease;
    if (configuration === undefined) return { state: "not-required" };
    if (this.lease === undefined || this.lease.profile !== this.activeProfile) {
      return {
        state: "required",
        profile: this.activeProfile,
        requiredForRisk: [...configuration.requiredForRisk]
      };
    }
    return {
      state: this.lease.expiresAtMs <= this.now().getTime() ? "expired" : "active",
      profile: this.lease.profile,
      expiresAt: this.lease.expiresAt,
      requiredForRisk: [...this.lease.requiredForRisk]
    };
  }

  private lockStatus(): ProfileLockStatus {
    if (this.options.lockToProfile) return { state: "configured", profile: this.options.lockToProfile };
    if (this.runtimeLock) {
      return { state: "runtime", profile: this.runtimeLock.profile, lockedAt: this.runtimeLock.lockedAt };
    }
    return { state: "none" };
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
