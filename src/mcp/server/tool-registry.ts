import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRiskAnnotations } from "../../policy/policy-types.js";
import type { UpstreamRequestOptions } from "../../upstream/upstream-session.js";
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

export type ToolDiscovery = (profile: string, options?: UpstreamRequestOptions) => Promise<ToolDiscoveryResult>;
export type ToolNameResolver = (name: string, upstreamName?: string) => string;

interface SnapshotState extends ToolSnapshot {
  generation: number;
}

interface PendingSnapshot {
  generation: number;
  readonly controller: AbortController;
  readonly consumers: Set<PendingConsumer>;
  promise: Promise<SnapshotState>;
  settled: boolean;
}

interface PendingConsumer {
  readonly onprogress?: UpstreamRequestOptions["onprogress"];
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

  async get(profile: string, options?: UpstreamRequestOptions): Promise<ToolSnapshot> {
    for (;;) {
      if (options?.signal?.aborted) throw new Error("Tool discovery cancelled");
      const generation = this.generation(profile);
      const cached = this.snapshots.get(profile);
      if (cached?.generation === generation && cached.isComplete()) return cached;

      const existing = this.pending.get(profile);
      const pending =
        existing?.generation === generation && !existing.controller.signal.aborted && !existing.settled
          ? existing
          : this.createPending(profile, generation);
      if (this.pending.get(profile) !== pending) this.pending.set(profile, pending);
      const snapshot = await this.awaitPending(pending, options);
      if (this.generation(profile) === generation) return snapshot;
    }
  }

  peek(profile: string): ToolSnapshot | undefined {
    const snapshot = this.snapshots.get(profile);
    return snapshot?.generation === this.generation(profile) ? snapshot : undefined;
  }

  hasPending(profile: string): boolean {
    const pending = this.pending.get(profile);
    return (
      pending?.generation === this.generation(profile) &&
      !pending.settled &&
      !pending.controller.signal.aborted
    );
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

  private createPending(profile: string, generation: number): PendingSnapshot {
    const pending: PendingSnapshot = {
      generation,
      controller: new AbortController(),
      consumers: new Set(),
      promise: Promise.resolve(undefined as never),
      settled: false
    };
    pending.promise = Promise.resolve()
      .then(() => this.build(profile, generation, this.pendingRequestOptions(pending)))
      .then((snapshot) => {
        // A cancelled sole caller may be replaced with a new shared discovery
        // before the old upstream request finishes. Only the current pending
        // discovery may publish its result for this generation.
        if (this.generation(profile) === generation && this.pending.get(profile) === pending) {
          this.snapshots.set(profile, snapshot);
        }
        return snapshot;
      })
      .finally(() => {
        pending.settled = true;
        if (this.pending.get(profile) === pending) this.pending.delete(profile);
      });
    // Consumers may all cancel before a failed discovery settles. Keep the
    // shared completion observed so that rejection cannot become unhandled.
    void pending.promise.catch(() => undefined);
    return pending;
  }

  private async awaitPending(
    pending: PendingSnapshot,
    options?: UpstreamRequestOptions
  ): Promise<SnapshotState> {
    if (options?.signal?.aborted) throw new Error("Tool discovery cancelled");
    const consumer: PendingConsumer = { onprogress: options?.onprogress };
    pending.consumers.add(consumer);
    const signal = options?.signal;
    let abort: (() => void) | undefined;
    const cancelled = signal === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          abort = () => {
            pending.consumers.delete(consumer);
            this.abortPendingIfUnused(pending);
            reject(new Error("Tool discovery cancelled"));
          };
          signal.addEventListener("abort", abort, { once: true });
        });
    try {
      return await (cancelled === undefined ? pending.promise : Promise.race([pending.promise, cancelled]));
    } finally {
      if (abort !== undefined) signal?.removeEventListener("abort", abort);
      pending.consumers.delete(consumer);
      this.abortPendingIfUnused(pending);
    }
  }

  private abortPendingIfUnused(pending: PendingSnapshot): void {
    if (!pending.settled && pending.consumers.size === 0) pending.controller.abort();
  }

  private pendingRequestOptions(pending: PendingSnapshot): UpstreamRequestOptions {
    return {
      signal: pending.controller.signal,
      onprogress: (progress) => {
        for (const consumer of pending.consumers) consumer.onprogress?.(progress);
      }
    };
  }

  private async build(
    profile: string,
    generation: number,
    options?: UpstreamRequestOptions
  ): Promise<SnapshotState> {
    const discovery = await this.discover(profile, options);
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
