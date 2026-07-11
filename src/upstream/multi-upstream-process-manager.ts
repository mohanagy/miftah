import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MiftahConfig, ProfileConfig } from "../config/types.js";
import { UpstreamProcessManager, type UpstreamHealth, type UpstreamManagerOptions } from "./upstream-process-manager.js";
import { UpstreamSession } from "./upstream-session.js";
import { MiftahError } from "../utils/errors.js";

export class MultiUpstreamProcessManager {
  private readonly managers: Record<string, UpstreamProcessManager>;

  constructor(config: MiftahConfig, options: UpstreamManagerOptions = {}) {
    this.managers = Object.fromEntries(
      Object.entries(config.upstreams ?? {}).map(([name, upstream]) => [
        name,
        new UpstreamProcessManager(upstream, scopedProfiles(config.profiles, name), options)
      ])
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

  async restartProfile(profile: string): Promise<void> {
    await Promise.all(Object.values(this.managers).map((manager) => manager.restart(profile)));
  }

  listHealth(): UpstreamHealth[] {
    return Object.values(this.managers).flatMap((manager) => manager.listHealth());
  }

  getSecretValues(): string[] {
    return [...new Set(Object.values(this.managers).flatMap((manager) => manager.getSecretValues()))];
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
          headers: { ...(profile.headers ?? {}), ...(override?.headers ?? {}) }
        }
      ];
    })
  );
}
