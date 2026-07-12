import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRiskAnnotations } from "../../policy/policy-types.js";
import { MiftahError } from "../../utils/errors.js";

export interface DiscoveredTools {
  upstreamName?: string;
  tools: Tool[];
}

export interface ToolDiscoveryResult {
  discovered: DiscoveredTools[];
  incomplete: boolean;
}

export interface RegisteredTool {
  readonly exposedName: string;
  readonly originalName: string;
  readonly upstreamName?: string;
  readonly profile: string;
  readonly fingerprint: string;
  readonly annotations?: ToolRiskAnnotations;
}

export interface ToolSnapshot {
  readonly profile: string;
  readonly fingerprint: string;
  getTools(): Tool[];
  resolve(exposedName: string): RegisteredTool | undefined;
  isComplete(): boolean;
}

export type ToolDiscovery = (profile: string) => Promise<ToolDiscoveryResult>;
export type ToolNameResolver = (name: string, upstreamName?: string) => string;

interface SnapshotState extends ToolSnapshot {
  generation: number;
}

interface PendingSnapshot {
  generation: number;
  promise: Promise<SnapshotState>;
}

/**
 * Builds profile-specific snapshots atomically and retries incomplete discovery on the next request.
 */
export class ToolRegistry {
  private readonly snapshots = new Map<string, SnapshotState>();
  private readonly pending = new Map<string, PendingSnapshot>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly discover: ToolDiscovery,
    private readonly resolveName: ToolNameResolver
  ) {}

  async get(profile: string): Promise<ToolSnapshot> {
    for (;;) {
      const generation = this.generation(profile);
      const cached = this.snapshots.get(profile);
      if (cached?.generation === generation && cached.isComplete()) return cached;

      const current = this.pending.get(profile);
      if (current?.generation === generation) {
        const snapshot = await current.promise;
        if (this.generation(profile) === generation) return snapshot;
      } else {
        const pending: PendingSnapshot = {
          generation,
          promise: this.build(profile, generation)
        };
        this.pending.set(profile, pending);
        try {
          const snapshot = await pending.promise;
          if (this.generation(profile) === generation) {
            this.snapshots.set(profile, snapshot);
            return snapshot;
          }
        } finally {
          if (this.pending.get(profile) === pending) this.pending.delete(profile);
        }
      }
    }
  }

  peek(profile: string): ToolSnapshot | undefined {
    const snapshot = this.snapshots.get(profile);
    return snapshot?.generation === this.generation(profile) ? snapshot : undefined;
  }

  invalidate(profile: string): void {
    this.generations.set(profile, this.generation(profile) + 1);
    this.snapshots.delete(profile);
  }

  hasSameTools(left: ToolSnapshot | undefined, right: ToolSnapshot | undefined): boolean {
    return left !== undefined && right !== undefined && left.fingerprint === right.fingerprint;
  }

  private generation(profile: string): number {
    return this.generations.get(profile) ?? 0;
  }

  private async build(profile: string, generation: number): Promise<SnapshotState> {
    const discovery = await this.discover(profile);
    const discovered = discovery.discovered;
    const routes = new Map<string, RegisteredTool>();
    const tools: Tool[] = [];

    for (const { upstreamName, tools: upstreamTools } of [...discovered].sort(compareUpstreams)) {
      for (const tool of [...upstreamTools].sort(compareTools)) {
        const exposedName = this.resolveName(tool.name, upstreamName);
        if (routes.has(exposedName)) {
          throw new MiftahError(
            "TOOL_COLLISION",
            `TOOL_COLLISION: multiple upstream tools resolve to '${exposedName}' for profile '${profile}'`
          );
        }
        const exposedTool = { ...cloneTool(tool), name: exposedName };
        routes.set(exposedName, {
          exposedName,
          originalName: tool.name,
          upstreamName,
          profile,
          fingerprint: canonicalJson(exposedTool),
          annotations: normalizeRiskAnnotations(tool)
        });
        tools.push(exposedTool);
      }
    }

    const snapshotTools = tools.map(cloneTool);
    return {
      generation,
      profile,
      fingerprint: canonicalJson(snapshotTools),
      getTools: () => snapshotTools.map(cloneTool),
      resolve: (exposedName) => cloneRegisteredTool(routes.get(exposedName)),
      isComplete: () => !discovery.incomplete
    };
  }
}

function compareUpstreams(left: DiscoveredTools, right: DiscoveredTools): number {
  return (left.upstreamName ?? "").localeCompare(right.upstreamName ?? "");
}

function compareTools(left: Tool, right: Tool): number {
  return left.name.localeCompare(right.name);
}

function cloneTool(tool: Tool): Tool {
  return structuredClone(tool);
}

function cloneRegisteredTool(tool: RegisteredTool | undefined): RegisteredTool | undefined {
  return tool === undefined
    ? undefined
    : {
        ...tool,
        ...(tool.annotations === undefined ? {} : { annotations: { ...tool.annotations } })
      };
}

function normalizeRiskAnnotations(tool: Tool): ToolRiskAnnotations | undefined {
  const annotations = tool.annotations;
  if (annotations === undefined) return undefined;
  const readOnlyHint = booleanHint(annotations.readOnlyHint);
  const destructiveHint = booleanHint(annotations.destructiveHint);
  const idempotentHint = booleanHint(annotations.idempotentHint);
  const openWorldHint = booleanHint(annotations.openWorldHint);
  if (
    readOnlyHint === undefined &&
    destructiveHint === undefined &&
    idempotentHint === undefined &&
    openWorldHint === undefined
  ) {
    return undefined;
  }
  return {
    ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
    ...(destructiveHint === undefined ? {} : { destructiveHint }),
    ...(idempotentHint === undefined ? {} : { idempotentHint }),
    ...(openWorldHint === undefined ? {} : { openWorldHint })
  };
}

function booleanHint(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
