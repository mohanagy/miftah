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
  restartOnCrash?: boolean;
  maxRestarts?: number;
  secretValues?: readonly string[];
  onStderr?: (profile: string, message: string) => void;
}

export interface UpstreamHealth {
  profile: string;
  status: "stopped" | "running" | "failed";
  pid?: number | null;
  error?: string;
}

export class UpstreamProcessManager {
  private readonly sessions = new Map<string, UpstreamSession>();
  private readonly health = new Map<string, UpstreamHealth>();
  private readonly starts = new Map<string, Promise<UpstreamSession>>();
  private readonly secretValuesSet = new Set<string>();
  private readonly options: Required<Pick<UpstreamManagerOptions, "startupTimeoutMs" | "restartOnCrash" | "maxRestarts">> &
    Omit<UpstreamManagerOptions, "startupTimeoutMs" | "restartOnCrash" | "maxRestarts">;

  constructor(
    private readonly upstream: UpstreamConfig,
    private readonly profiles: Record<string, ProfileConfig>,
    options: UpstreamManagerOptions = {}
  ) {
    this.options = {
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      restartOnCrash: options.restartOnCrash ?? true,
      maxRestarts: options.maxRestarts ?? 3,
      ...options
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
    return [...this.health.values()];
  }

  getSecretValues(): string[] {
    return [...this.secretValuesSet];
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
    this.health.set(profile, { profile, status: "stopped" });
  }

  async listTools(profile: string, _upstreamName?: string): Promise<Tool[]> {
    void _upstreamName;
    try {
      return (await (await this.get(profile)).listTools()).tools;
    } catch (error) {
      throw new MiftahError("UPSTREAM_TOOL_LIST_FAILED", `UPSTREAM_TOOL_LIST_FAILED: unable to list tools for '${profile}'`, {
        cause: redactSecrets(error instanceof Error ? error.message : String(error), this.options.secretValues ?? [])
      });
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
        this.health.set(profile, { profile, status: "failed", error: "upstream process closed" });
      }
    };
    const client = new Client({ name: "miftah", version: "0.1.0" });
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
      this.health.set(profile, { profile, status: "running", pid });
      return session;
    } catch (error) {
      await transport.close().catch(() => undefined);
      this.health.set(profile, {
        profile,
        status: "failed",
        error: redactSecrets(error instanceof Error ? error.message : String(error), this.options.secretValues ?? [])
      });
      throw error;
    }
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
