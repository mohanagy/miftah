import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Stream } from "node:stream";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProfileConfig, UpstreamConfig } from "../config/types.js";
import { expandEnvironmentReferences } from "../config/env-expand.js";
import { redactSecrets } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";
import { UpstreamSession } from "./upstream-session.js";

export interface UpstreamManagerOptions {
  startupTimeoutMs?: number;
  secretValues?: readonly string[];
  onStderr?: (profile: string, message: string) => void;
}

export type UpstreamCapability = "tools" | "resources" | "prompts";
export type UpstreamCapabilityState = "unknown" | "available" | "failed";
export type UpstreamProcessState = "stopped" | "starting" | "running" | "failed";
export type UpstreamState = UpstreamProcessState | "degraded";

export interface UpstreamCapabilityHealth {
  state: UpstreamCapabilityState;
  lastTransition: string;
  error?: string;
}

export interface UpstreamHealth {
  profile: string;
  upstreamName: string;
  /** @deprecated Use state. */
  status: UpstreamState;
  state: UpstreamState;
  processState: UpstreamProcessState;
  lastTransition: string;
  restartCount: number;
  pid?: number | null;
  error?: string;
  capabilities: Record<UpstreamCapability, UpstreamCapabilityHealth>;
}

export class UpstreamProcessManager {
  private readonly sessions = new Map<string, UpstreamSession>();
  private readonly health = new Map<string, UpstreamHealth>();
  private readonly starts = new Map<string, Promise<UpstreamSession>>();
  private readonly secretValuesSet = new Set<string>();
  private readonly startAttempts = new Map<string, number>();
  private readonly processErrors = new Map<string, string>();
  private readonly healthListeners = new Set<(health: UpstreamHealth) => void>();
  private readonly options: Required<Pick<UpstreamManagerOptions, "startupTimeoutMs">> &
    Omit<UpstreamManagerOptions, "startupTimeoutMs">;

  constructor(
    private readonly upstream: UpstreamConfig,
    private readonly profiles: Record<string, ProfileConfig>,
    options: UpstreamManagerOptions = {},
    private readonly upstreamName = "default"
  ) {
    this.options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000
    };
  }

  async get(profile: string, _upstreamName?: string): Promise<UpstreamSession> {
    void _upstreamName;
    const current = this.sessions.get(profile);
    if (current) return current;
    const pending = this.starts.get(profile);
    if (pending) return pending;
    const start = this.start(profile);
    this.starts.set(profile, start);
    try {
      return await start;
    } finally {
      this.starts.delete(profile);
    }
  }

  listHealth(): UpstreamHealth[] {
    return [...this.health.values()].map((health) => structuredClone(health));
  }

  getSecretValues(): string[] {
    return [...this.secretValuesSet];
  }

  addHealthListener(listener: (health: UpstreamHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  recordCapabilitySuccess(profile: string, capability: UpstreamCapability, _upstreamName?: string): void {
    void _upstreamName;
    this.recordCapability(profile, capability, "available");
  }

  recordCapabilityFailure(
    profile: string,
    capability: UpstreamCapability,
    error: unknown,
    _upstreamName?: string
  ): void {
    void _upstreamName;
    this.recordCapability(
      profile,
      capability,
      "failed",
      redactSecrets(error instanceof Error ? error.message : String(error), this.options.secretValues ?? [])
    );
  }

  async restart(profile: string, _upstreamName?: string): Promise<UpstreamSession> {
    void _upstreamName;
    await this.closeProfile(profile);
    return this.get(profile);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((profile) => this.closeProfile(profile)));
  }

  async closeProfile(profile: string): Promise<void> {
    const session = this.sessions.get(profile);
    this.sessions.delete(profile);
    if (session) {
      await session.close();
    }
    this.setProcessState(profile, "stopped", { resetCapabilities: true });
  }

  async listTools(profile: string, _upstreamName?: string): Promise<Tool[]> {
    void _upstreamName;
    try {
      const tools = (await (await this.get(profile)).listTools()).tools;
      this.recordCapabilitySuccess(profile, "tools");
      return tools;
    } catch (error) {
      const failure = new MiftahError("UPSTREAM_TOOL_LIST_FAILED", `UPSTREAM_TOOL_LIST_FAILED: unable to list tools for '${profile}'`, {
        cause: redactSecrets(error instanceof Error ? error.message : String(error), this.options.secretValues ?? [])
      });
      this.recordCapabilityFailure(profile, "tools", failure);
      throw failure;
    }
  }

  private async start(profile: string): Promise<UpstreamSession> {
    const profileConfig = this.profiles[profile];
    if (!profileConfig) {
      throw new MiftahError("PROFILE_NOT_FOUND", `PROFILE_NOT_FOUND: profile '${profile}' does not exist`);
    }
    if (this.upstream.transport === "stdio" && !this.upstream.command) {
      throw new MiftahError(
        "UPSTREAM_START_FAILED",
        "UPSTREAM_START_FAILED: stdio upstream requires a command"
      );
    }
    this.startAttempts.set(profile, (this.startAttempts.get(profile) ?? 0) + 1);
    this.setProcessState(profile, "starting", { resetCapabilities: true });

    const resolvedEnvironment = {
      ...(this.upstream.env ? expandEnvironmentReferences(this.upstream.env) : {}),
      ...(profileConfig.env ? expandEnvironmentReferences(profileConfig.env) : {})
    };
    const resolvedHeaders = {
      ...(this.upstream.headers ? expandEnvironmentReferences(this.upstream.headers) : {}),
      ...(profileConfig.headers ? expandEnvironmentReferences(profileConfig.headers) : {})
    };
    for (const [key, value] of Object.entries({ ...resolvedEnvironment, ...resolvedHeaders })) {
      if (/(token|secret|password|api[_-]?key|auth|private|credential)/i.test(key) && value.length > 0) {
        this.secretValuesSet.add(value);
      }
    }

    let transport: Transport;
    let pid: number | null = null;
    let stderr: Stream | null = null;
    if (this.upstream.transport === "stdio") {
      const environment = {
        ...getDefaultEnvironment(),
        ...resolvedEnvironment
      };
      const stdioTransport = new StdioClientTransport({
        command: this.upstream.command!,
        args: profileConfig.args ?? this.upstream.args ?? [],
        env: environment,
        ...(profileConfig.cwd ?? this.upstream.cwd ? { cwd: profileConfig.cwd ?? this.upstream.cwd } : {}),
        stderr: "pipe"
      });
      transport = stdioTransport;
      stderr = stdioTransport.stderr;
    } else {
      if (!this.upstream.url) {
        throw new MiftahError("UPSTREAM_START_FAILED", "UPSTREAM_START_FAILED: remote upstream requires a url");
      }
      const options = Object.keys(resolvedHeaders).length > 0 ? { requestInit: { headers: resolvedHeaders } } : undefined;
      transport =
        this.upstream.transport === "sse"
          ? new SSEClientTransport(new URL(this.upstream.url), options)
          : new StreamableHTTPClientTransport(new URL(this.upstream.url), options);
    }
    stderr?.on("data", (chunk: Buffer) => {
      this.options.onStderr?.(
        profile,
        redactSecrets(chunk.toString("utf8"), this.options.secretValues ?? [])
      );
    });
    transport.onclose = () => {
      if (this.sessions.get(profile)) {
        this.sessions.delete(profile);
        this.setProcessState(profile, "failed", { error: "upstream process closed", resetCapabilities: true });
      }
    };
    const client = new Client({ name: "miftah", version: "0.1.1" });
    const startPromise = client.connect(transport).then(
      () => new UpstreamSession(profile, client, () => client.close()),
      async (error: unknown) => {
        await transport.close().catch(() => undefined);
        throw new MiftahError(
          "UPSTREAM_INIT_FAILED",
          `UPSTREAM_INIT_FAILED: could not initialize profile '${profile}'`,
          { cause: redactSecrets(error instanceof Error ? error.message : String(error), this.options.secretValues ?? []) }
        );
      }
    );

    try {
      const session = await withTimeout(startPromise, this.options.startupTimeoutMs);
      this.sessions.set(profile, session);
      if ("pid" in transport && typeof transport.pid === "number") pid = transport.pid;
      this.setProcessState(profile, "running", { pid });
      return session;
    } catch (error) {
      await transport.close().catch(() => undefined);
      this.setProcessState(profile, "failed", {
          error: redactSecrets(error instanceof Error ? error.message : String(error), this.options.secretValues ?? [])
      });
      throw error;
    }
  }

  private recordCapability(
    profile: string,
    capability: UpstreamCapability,
    state: UpstreamCapabilityState,
    error?: string
  ): void {
    const current = this.health.get(profile) ?? this.healthEntry(profile, "stopped");
    const capabilities = structuredClone(current.capabilities);
    capabilities[capability] = {
      state,
      lastTransition: new Date().toISOString(),
      ...(error === undefined ? {} : { error })
    };
    this.publishHealth(
      this.healthEntry(profile, current.processState, {
        pid: current.pid,
        capabilities
      })
    );
  }

  private setProcessState(
    profile: string,
    processState: UpstreamProcessState,
    options: { pid?: number | null; error?: string; resetCapabilities?: boolean } = {}
  ): void {
    if (processState === "failed" && options.error !== undefined) {
      this.processErrors.set(profile, options.error);
    } else if (processState !== "failed") {
      this.processErrors.delete(profile);
    }
    const current = this.health.get(profile);
    this.publishHealth(
      this.healthEntry(profile, processState, {
        pid: options.pid,
        capabilities: options.resetCapabilities ? this.initialCapabilities() : current?.capabilities
      })
    );
  }

  private healthEntry(
    profile: string,
    processState: UpstreamProcessState,
    options: { pid?: number | null; capabilities?: Record<UpstreamCapability, UpstreamCapabilityHealth> } = {}
  ): UpstreamHealth {
    const capabilities = options.capabilities ?? this.initialCapabilities();
    const capabilityFailure = Object.values(capabilities)
      .filter((capability) => capability.state === "failed")
      .at(-1);
    const state: UpstreamState =
      processState === "running" && capabilityFailure !== undefined ? "degraded" : processState;
    const error = processState === "failed" ? this.processErrors.get(profile) : capabilityFailure?.error;
    return {
      profile,
      upstreamName: this.upstreamName,
      status: state,
      state,
      processState,
      lastTransition: new Date().toISOString(),
      restartCount: Math.max(0, (this.startAttempts.get(profile) ?? 0) - 1),
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(error === undefined ? {} : { error }),
      capabilities
    };
  }

  private initialCapabilities(): Record<UpstreamCapability, UpstreamCapabilityHealth> {
    const lastTransition = new Date().toISOString();
    return {
      tools: { state: "unknown", lastTransition },
      resources: { state: "unknown", lastTransition },
      prompts: { state: "unknown", lastTransition }
    };
  }

  private publishHealth(health: UpstreamHealth): void {
    this.health.set(health.profile, health);
    for (const listener of this.healthListeners) listener(structuredClone(health));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new MiftahError("UPSTREAM_START_FAILED", `UPSTREAM_START_FAILED: startup timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
