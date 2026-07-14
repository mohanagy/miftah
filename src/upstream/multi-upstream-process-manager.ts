import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MiftahConfig, ProfileConfig, ProfileIsolationConfig } from "../config/types.js";
import { assertProfileIsolationBindings } from "../isolation/profile-runtime-isolation.js";
import {
  UpstreamProcessManager,
  type UpstreamCapability,
  type UpstreamHealth,
  type UpstreamLifecycleEvent,
  type UpstreamManagerOptions
} from "./upstream-process-manager.js";
import { ProfileSessionLimiter } from "./profile-session-limiter.js";
import { UpstreamSession } from "./upstream-session.js";
import { MiftahError } from "../utils/errors.js";
import { SecretRedactor } from "../secrets/redact.js";

/** Coordinates named upstream managers while sharing profile-capacity accounting across the bundle. */
export class MultiUpstreamProcessManager {
  private readonly managers: Record<string, UpstreamProcessManager>;
  private readonly healthListeners = new Set<(health: UpstreamHealth) => void>();
  private readonly lifecycleListeners = new Set<(event: UpstreamLifecycleEvent) => void>();
  private readonly limiter: ProfileSessionLimiter;
  private readonly redactor: SecretRedactor;

  constructor(config: MiftahConfig, options: UpstreamManagerOptions = {}) {
    this.limiter = new ProfileSessionLimiter(options.maxConcurrentProfiles);
    this.redactor = options.redactor ?? new SecretRedactor();
    this.redactor.addAll(options.secretValues ?? []);
    this.managers = Object.fromEntries(
      Object.entries(config.upstreams ?? {}).map(([name, upstream]) => {
        const manager = new UpstreamProcessManager(
          upstream,
          scopedProfiles(config.profiles, name),
          { ...options, redactor: this.redactor },
          name,
          this.limiter
        );
        manager.addHealthListener((health) => this.publishHealth(health));
        manager.addLifecycleListener((event) => this.publishLifecycle(event));
        return [name, manager];
      })
    );
  }

  listUpstreams(): string[] {
    return Object.keys(this.managers);
  }

  get(profile: string, upstreamName?: string): Promise<UpstreamSession> {
    return this.manager(upstreamName).get(profile);
  }

  listTools(profile: string, upstreamName?: string): Promise<Tool[]> {
    return this.manager(upstreamName).listTools(profile);
  }

  restart(profile: string, upstreamName?: string): Promise<UpstreamSession> {
    return this.manager(upstreamName).restart(profile);
  }

  addHealthListener(listener: (health: UpstreamHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  addLifecycleListener(listener: (event: UpstreamLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  recordCapabilitySuccess(profile: string, capability: UpstreamCapability, upstreamName?: string): void {
    this.manager(upstreamName).recordCapabilitySuccess(profile, capability);
  }

  recordCapabilityFailure(
    profile: string,
    capability: UpstreamCapability,
    error: unknown,
    upstreamName?: string
  ): void {
    this.manager(upstreamName).recordCapabilityFailure(profile, capability, error);
  }

  async restartProfile(profile: string): Promise<void> {
    const results = await Promise.allSettled(Object.values(this.managers).map((manager) => manager.restart(profile)));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  async closeProfile(profile: string): Promise<void> {
    const results = await Promise.allSettled(Object.values(this.managers).map((manager) => manager.closeProfile(profile)));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  listHealth(): UpstreamHealth[] {
    return Object.values(this.managers)
      .flatMap((manager) => manager.listHealth())
      .sort((left, right) => left.profile.localeCompare(right.profile) || left.upstreamName.localeCompare(right.upstreamName));
  }

  getSecretValues(): string[] {
    return this.redactor.values();
  }

  getRedactor(): SecretRedactor {
    return this.redactor;
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.managers).map((manager) => manager.close()));
  }

  private manager(name?: string): UpstreamProcessManager {
    const configured = Object.values(this.managers);
    if (!name && configured.length > 1) {
      throw new MiftahError(
        "UPSTREAM_SELECTION_AMBIGUOUS",
        "UPSTREAM_SELECTION_AMBIGUOUS: select an upstream by name when multiple upstreams are configured"
      );
    }
    const selected = name ? this.managers[name] : configured[0];
    if (!selected) throw new Error(`No upstream configured${name ? ` named '${name}'` : ""}`);
    return selected;
  }

  private publishHealth(health: UpstreamHealth): void {
    this.notifyListeners(this.healthListeners, health, "health");
  }

  private publishLifecycle(event: UpstreamLifecycleEvent): void {
    this.notifyListeners(this.lifecycleListeners, event, "lifecycle");
  }

  private notifyListeners<Event>(
    listeners: ReadonlySet<(event: Event) => void>,
    event: Event,
    kind: "health" | "lifecycle"
  ): void {
    for (const listener of listeners) {
      try {
        listener(structuredClone(event));
      } catch {
        process.emitWarning(`MIFTAH_LISTENER_FAILED: ignored a failing ${kind} listener`, {
          code: "MIFTAH_LISTENER_FAILED"
        });
      }
    }
  }
}

function scopedProfiles(
  profiles: Record<string, ProfileConfig>,
  upstreamName: string
): Record<string, ProfileConfig> {
  return Object.fromEntries(
    Object.entries(profiles).map(([name, profile]) => {
      const override = profile.upstreams?.[upstreamName];
      return [
        name,
        {
          ...profile,
          env: { ...(profile.env ?? {}), ...(override?.env ?? {}) },
          args: override?.args ?? profile.args,
          cwd: override?.cwd ?? profile.cwd,
          headers: { ...(profile.headers ?? {}), ...(override?.headers ?? {}) },
          isolation: mergeProfileIsolation(profile.isolation, override?.isolation)
        }
      ];
    })
  );
}

export function mergeProfileIsolation(
  profileIsolation: ProfileIsolationConfig | undefined,
  upstreamIsolation: ProfileIsolationConfig | undefined
): ProfileIsolationConfig | undefined {
  const merged =
    profileIsolation === undefined
      ? upstreamIsolation
      : upstreamIsolation === undefined
        ? profileIsolation
        : {
            files: [...(profileIsolation.files ?? []), ...(upstreamIsolation.files ?? [])],
            containerVolumes: [...(profileIsolation.containerVolumes ?? []), ...(upstreamIsolation.containerVolumes ?? [])]
          };
  if (merged !== undefined) assertProfileIsolationBindings(merged);
  return merged;
}
