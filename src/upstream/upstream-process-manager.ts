import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Stream } from "node:stream";
import type { ProfileConfig, UpstreamConfig } from "../config/types.js";
import { expandEnvironmentReferencesWithSecretValues } from "../config/env-expand.js";
import { SecretRedactor } from "../secrets/redact.js";
import { ProfileRuntimeIsolation } from "../isolation/profile-runtime-isolation.js";
import { MiftahError } from "../utils/errors.js";
import { ProfileSessionLimiter } from "./profile-session-limiter.js";
import { ProgressPreservingTransport, unwrapProgressPreservingTransport } from "./progress-preserving-transport.js";
import { asRemoteError, fetchSsePostWithStatusOnly } from "./remote-error.js";
import { UpstreamSession } from "./upstream-session.js";
import { MIFTAH_VERSION } from "../version.js";
import { mergeHeaders } from "./headers.js";
import { resolveWindowsStdioCommand } from "./windows-stdio-command.js";
import {
  ContainedStdioClientTransport,
  createContainedStdioClientTransport
} from "./contained-stdio-transport.js";

const defaultStartupTimeoutMs = 30_000;
const defaultShutdownTimeoutMs = 5_000;
const forcedGracefulCloseTimeoutMs = 100;
const defaultMaxRestarts = 3;
const initialRestartDelayMs = 100;
const maximumRestartDelayMs = 5_000;
const restartJitterFraction = 0.2;
const restartStabilityWindowMs = 30_000;
const credentialKeyPattern = /(token|secret|password|api[_-]?key|auth|private|credential|cookie)/i;

/**
 * Combines child-process environments with Windows' case-insensitive variable
 * semantics. Callers that preflight a launch must use this same precedence.
 */
export function mergeEnvironment(...environmentSets: Array<Record<string, string> | undefined>): Record<string, string> {
  if (process.platform !== "win32") return Object.assign({}, ...environmentSets);
  const merged = new Map<string, [string, string]>();
  for (const environment of environmentSets) {
    for (const [name, value] of Object.entries(environment ?? {})) {
      merged.set(name.toUpperCase(), [name, value]);
    }
  }
  return Object.fromEntries(merged.values());
}

/** Expands configured process environment values and applies the runtime's launch precedence. */
export function resolveProcessEnvironment(
  upstreamEnvironment: Record<string, string> | undefined,
  profileEnvironment: Record<string, string> | undefined
): { environment: Record<string, string>; secretValues: string[] } {
  const expandedUpstreamEnvironment = upstreamEnvironment
    ? expandEnvironmentReferencesWithSecretValues(upstreamEnvironment)
    : undefined;
  const expandedProfileEnvironment = profileEnvironment
    ? expandEnvironmentReferencesWithSecretValues(profileEnvironment)
    : undefined;
  return {
    environment: mergeEnvironment(
      getDefaultEnvironment(),
      expandedUpstreamEnvironment?.values,
      expandedProfileEnvironment?.values
    ),
    secretValues: [
      ...(expandedUpstreamEnvironment?.secretValues ?? []),
      ...(expandedProfileEnvironment?.secretValues ?? [])
    ]
  };
}

/** Configures lifecycle behavior, capacity, and redacted diagnostics for an upstream manager. */
export interface UpstreamManagerOptions {
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  idleTimeoutMs?: number;
  restartOnCrash?: boolean;
  maxRestarts?: number;
  maxConcurrentProfiles?: number;
  secretValues?: readonly string[];
  redactor?: SecretRedactor;
  isolation?: ProfileRuntimeIsolation;
  onStderr?: (profile: string, message: string) => void;
  /** Internal exact-binding OAuth provider factory for remote Streamable HTTP sessions. */
  oauthProvider?: (profile: string, upstreamName: string) => Promise<ManagedOAuthClientProvider | undefined>;
  /** Internal fetch boundary used by remote transports and deterministic loopback fixtures. */
  remoteFetch?: FetchLike;
}

/** OAuth provider capabilities the upstream manager needs to finish an interactive SDK flow. */
export interface ManagedOAuthClientProvider extends OAuthClientProvider {
  waitForAuthorizationCode(): Promise<string>;
  close(): Promise<void>;
}

export type UpstreamCapability = "tools" | "resources" | "prompts";
export type UpstreamCapabilityState = "unknown" | "available" | "failed";
export type UpstreamProcessState = "stopped" | "starting" | "running" | "failed";
export type UpstreamState = UpstreamProcessState | "degraded";
type ShutdownFailureReason = "shutdown-timeout" | "shutdown-error";
/** Identifies an intentional reason a profile's upstream process stopped. */
export type UpstreamStopReason = "idle" | "manual" | "restart" | "shutdown" | ShutdownFailureReason;

export type UpstreamLifecycleType = "start" | "start-failure" | "crash" | "restart" | "restart-failure" | "idle" | "shutdown";

/** Describes an observable upstream lifecycle transition. */
export interface UpstreamLifecycleEvent {
  type: UpstreamLifecycleType;
  profile: string;
  upstreamName: string;
  status: "success" | "failure";
  errorCode?: string;
}

export interface UpstreamCapabilityHealth {
  state: UpstreamCapabilityState;
  lastTransition: string;
  error?: string;
}

/** Describes the latest lifecycle and capability state for one profile/upstream pair. */
export interface UpstreamHealth {
  profile: string;
  upstreamName: string;
  /** @deprecated Use state. */
  status: UpstreamState;
  state: UpstreamState;
  processState: UpstreamProcessState;
  lastTransition: string;
  /** Number of automatic restart attempts, excluding manual restarts and idle wake-ups. */
  restartCount: number;
  pid?: number | null;
  error?: string;
  lastStopReason?: UpstreamStopReason;
  nextRestartAt?: string;
  restartLimitReached?: boolean;
  capabilities: Record<UpstreamCapability, UpstreamCapabilityHealth>;
}

type StartSource = "demand" | "manual" | "automatic";

interface TransportCloseSignal {
  readonly promise: Promise<void>;
  isClosed(): boolean;
  resolve(): void;
}

interface ManagedSession {
  readonly session: UpstreamSession;
  readonly transport: Transport;
  readonly transportClosed: TransportCloseSignal;
  readonly pid: number | null;
  readonly token: number;
  readonly generation: number;
  readonly oauthProvider?: ManagedOAuthClientProvider;
  inFlight: number;
  closing: boolean;
}

interface StartingAttempt {
  readonly transport: Transport;
  readonly transportClosed: TransportCloseSignal;
  readonly generation: number;
  readonly oauthProvider?: ManagedOAuthClientProvider;
  pid: number | null;
}

interface ScheduledRestart {
  readonly generation: number;
  readonly timer: NodeJS.Timeout;
  readonly promise: Promise<void>;
  resolve(): void;
}

/**
 * Holds a profile capacity reservation until every local child close signal has settled.
 * A clean idle handoff may reuse that same reservation; a forced or timed-out cleanup
 * promotes the gate and blocks another process for the profile.
 */
interface PendingTeardown {
  readonly signals: readonly TransportCloseSignal[];
  readonly reason: UpstreamStopReason;
  blocksReplacement: boolean;
}

interface TeardownLease {
  readonly teardown: PendingTeardown;
  readonly ownsTeardown: boolean;
}

type ResolvedOptions = Required<
  Pick<UpstreamManagerOptions, "startupTimeoutMs" | "shutdownTimeoutMs" | "restartOnCrash" | "maxRestarts">
> &
  Omit<UpstreamManagerOptions, "startupTimeoutMs" | "shutdownTimeoutMs" | "restartOnCrash" | "maxRestarts">;

function createCloseSignal(): TransportCloseSignal {
  let closed = false;
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    isClosed: () => closed,
    resolve: () => {
      if (closed) return;
      closed = true;
      resolvePromise?.();
    }
  };
}

/**
 * Owns one upstream process pool. Sessions are cached by profile and created only on demand.
 */
export class UpstreamProcessManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly health = new Map<string, UpstreamHealth>();
  private readonly starts = new Map<string, Promise<UpstreamSession>>();
  private readonly startingAttempts = new Map<string, StartingAttempt>();
  private readonly manualRestarts = new Map<string, Promise<UpstreamSession>>();
  private readonly automaticRestarts = new Map<string, ScheduledRestart>();
  private readonly pendingTeardowns = new Map<string, Set<PendingTeardown>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly stabilityTimers = new Map<string, NodeJS.Timeout>();
  private readonly generations = new Map<string, number>();
  private readonly startEpochs = new Map<string, number>();
  private readonly redactor: SecretRedactor;
  private readonly automaticRestartCounts = new Map<string, number>();
  private readonly consecutiveRestartAttempts = new Map<string, number>();
  private readonly restartExhausted = new Set<string>();
  private readonly processErrors = new Map<string, string>();
  private readonly healthListeners = new Set<(health: UpstreamHealth) => void>();
  private readonly lifecycleListeners = new Set<(event: UpstreamLifecycleEvent) => void>();
  private readonly options: ResolvedOptions;
  private readonly limiter: ProfileSessionLimiter;
  private nextToken = 0;
  private closed = false;

  constructor(
    private readonly upstream: UpstreamConfig,
    private readonly profiles: Record<string, ProfileConfig>,
    options: UpstreamManagerOptions = {},
    private readonly upstreamName = "default",
    limiter?: ProfileSessionLimiter
  ) {
    this.options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? defaultStartupTimeoutMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs,
      restartOnCrash: options.restartOnCrash ?? false,
      maxRestarts: options.maxRestarts ?? defaultMaxRestarts
    };
    this.redactor = options.redactor ?? new SecretRedactor();
    this.redactor.addAll(options.secretValues ?? []);
    this.limiter = limiter ?? new ProfileSessionLimiter(options.maxConcurrentProfiles);
  }

  /** Returns the live session or starts it after any scheduled recovery completes. */
  async get(profile: string, _upstreamName?: string): Promise<UpstreamSession> {
    void _upstreamName;
    this.assertOpen();
    const manualRestart = this.manualRestarts.get(profile);
    if (manualRestart) return manualRestart;
    const automaticRestart = this.automaticRestarts.get(profile);
    if (automaticRestart) {
      await automaticRestart.promise;
      return this.get(profile);
    }
    const current = this.sessions.get(profile);
    if (current && !current.closing) return current.session;
    this.assertRestartAvailable(profile);
    return this.startOnce(profile, "demand");
  }

  listHealth(): UpstreamHealth[] {
    return [...this.health.values()].map((health) => structuredClone(health));
  }

  /** Returns every configured or dynamically resolved value that must be redacted from upstream output. */
  getSecretValues(): string[] {
    return this.redactor.values();
  }

  getRedactor(): SecretRedactor {
    return this.redactor;
  }

  addHealthListener(listener: (health: UpstreamHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  addLifecycleListener(listener: (event: UpstreamLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
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
      this.redactProcessOutput(error instanceof Error ? error.message : String(error))
    );
  }

  /** Manually restarts a profile and resets any exhausted automatic-recovery budget. */
  async restart(profile: string, _upstreamName?: string): Promise<UpstreamSession> {
    void _upstreamName;
    this.assertOpen();
    const existing = this.manualRestarts.get(profile);
    if (existing) return existing;

    this.cancelAutomaticRestart(profile, false);
    this.resetRecoveryBudget(profile);
    const restart = this.restartProfile(profile);
    this.manualRestarts.set(profile, restart);
    void restart.then(
      () => {
        if (this.manualRestarts.get(profile) === restart) this.manualRestarts.delete(profile);
      },
      () => {
        if (this.manualRestarts.get(profile) === restart) this.manualRestarts.delete(profile);
      }
    );
    return restart;
  }

  /** Stops every known profile and waits for active startup and restart work to settle. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const profiles = new Set([
      ...this.sessions.keys(),
      ...this.starts.keys(),
      ...this.manualRestarts.keys(),
      ...this.automaticRestarts.keys(),
      ...this.health.keys()
    ]);
    for (const profile of profiles) {
      this.cancelAutomaticRestart(profile, true);
      this.clearIdleTimer(profile);
      this.clearStabilityTimer(profile);
    }
    await Promise.all(Array.from(profiles, (profile) => this.stopProfile(profile, "shutdown", true)));
    await Promise.allSettled([...this.starts.values(), ...this.manualRestarts.values()]);
  }

  /** Stops one profile without closing the manager itself. */
  async closeProfile(profile: string): Promise<void> {
    this.cancelAutomaticRestart(profile, true);
    await this.stopProfile(profile, "manual", true);
  }

  /** Lists upstream tools and records a redacted capability outcome for health reporting. */
  async listTools(profile: string, _upstreamName?: string): Promise<Tool[]> {
    void _upstreamName;
    try {
      const tools = (await (await this.get(profile)).listTools()).tools;
      this.recordCapabilitySuccess(profile, "tools");
      return tools;
    } catch (error) {
      const failure = new MiftahError("UPSTREAM_TOOL_LIST_FAILED", `UPSTREAM_TOOL_LIST_FAILED: unable to list tools for '${profile}'`, {
        cause: this.redactProcessOutput(error instanceof Error ? error.message : String(error))
      });
      this.recordCapabilityFailure(profile, "tools", failure);
      throw failure;
    }
  }

  private async restartProfile(profile: string): Promise<UpstreamSession> {
    await this.stopProfile(profile, "restart", false);
    const cancelledStart = this.starts.get(profile);
    if (cancelledStart) {
      await withTimeout(
        cancelledStart.then(
          () => undefined,
          () => undefined
        ),
        this.options.shutdownTimeoutMs,
        "UPSTREAM_SHUTDOWN_TIMEOUT",
        `UPSTREAM_SHUTDOWN_TIMEOUT: cancelled startup cleanup timed out after ${this.options.shutdownTimeoutMs}ms`
      );
    }
    return this.startOnce(profile, "manual");
  }

  private startOnce(profile: string, source: StartSource): Promise<UpstreamSession> {
    this.assertOpen();
    const pending = this.starts.get(profile);
    if (pending) return pending;
    const start = this.startAfterPendingTeardown(profile, source);
    this.starts.set(profile, start);
    void start.then(
      () => {
        if (this.starts.get(profile) === start) this.starts.delete(profile);
      },
      () => {
        if (this.starts.get(profile) === start) this.starts.delete(profile);
      }
    );
    return start;
  }

  private async startAfterPendingTeardown(profile: string, source: StartSource): Promise<UpstreamSession> {
    // Preserve the established clean idle-handoff behavior: only a forced or timed-out
    // cleanup blocks a replacement. Every gate, including a clean handoff, still holds capacity.
    if (this.hasBlockingTeardown(profile)) {
      throw new MiftahError(
        "UPSTREAM_SHUTDOWN_TIMEOUT",
        `UPSTREAM_SHUTDOWN_TIMEOUT: previous upstream process cleanup is still pending for '${profile}'`
      );
    }
    return this.start(profile, source);
  }

  private async start(profile: string, source: StartSource): Promise<UpstreamSession> {
    const profileConfig = this.profiles[profile];
    if (!profileConfig) {
      throw new MiftahError("PROFILE_NOT_FOUND", `PROFILE_NOT_FOUND: profile '${profile}' does not exist`);
    }
    if (this.upstream.transport === "stdio" && !this.upstream.command) {
      throw new MiftahError("UPSTREAM_START_FAILED", "UPSTREAM_START_FAILED: stdio upstream requires a command");
    }

    const generation = this.generation(profile);
    this.incrementStartEpoch(profile);
    const token = ++this.nextToken;
    let transport: Transport | undefined;
    let streamableTransport: StreamableHTTPClientTransport | undefined;
    let stdioTransport: ContainedStdioClientTransport | undefined;
    let oauthProvider: ManagedOAuthClientProvider | undefined;
    let startingAttempt: StartingAttempt | undefined;
    let transportClosed = createCloseSignal();
    let reserved = false;

    const trackTransportClose = (managedTransport: Transport): TransportCloseSignal => {
      const closeSignal = createCloseSignal();
      managedTransport.onclose = () => {
        closeSignal.resolve();
        // A bounded close may already have returned while this verified close
        // callback was flowing through the progress-preserving wrapper. Settle
        // any deferred local teardown synchronously at this boundary so a
        // caller cannot observe a dead process tree while its limiter slot is
        // still held by a later promise microtask.
        this.completeClosedDeferredTeardowns(profile);
        this.handleTransportClosed(profile, token, generation);
      };
      return closeSignal;
    };

    try {
      reserved = this.limiter.acquire(profile, this.upstreamName);
      this.setProcessState(profile, "starting", { resetCapabilities: true, pid: null });
      const { environment, headers, args, suppressStderr } = await this.resolveProfileOptions(
        profile,
        profileConfig,
        profileConfig.args ?? this.upstream.args ?? []
      );
      this.assertCurrentStartup(profile, generation);
      const stdioCommand = this.upstream.transport === "stdio"
        ? await resolveWindowsStdioCommand(this.upstream.command!, args, { environment })
        : undefined;
      this.assertCurrentStartup(profile, generation);
      try {
        oauthProvider = await this.options.oauthProvider?.(profile, this.upstreamName);
      } catch (error) {
        throw this.oauthAuthorizationFailure(error);
      }
      this.assertCurrentStartup(profile, generation);
      if (oauthProvider !== undefined && this.upstream.transport !== "streamable-http") {
        throw new MiftahError(
          "OAUTH_CONNECTION_INVALID",
          "OAUTH_CONNECTION_INVALID: OAuth requires a Streamable HTTP upstream"
        );
      }

      if (this.upstream.transport === "stdio") {
        if (stdioCommand === undefined) {
          throw new MiftahError("UPSTREAM_START_FAILED", "UPSTREAM_START_FAILED: stdio upstream requires a direct executable");
        }
        stdioTransport = await createContainedStdioClientTransport({
          command: stdioCommand.command,
          args: [...stdioCommand.args],
          env: environment,
          ...(profileConfig.cwd ?? this.upstream.cwd ? { cwd: profileConfig.cwd ?? this.upstream.cwd } : {}),
          stderr: "pipe"
        });
        this.assertCurrentStartup(profile, generation);
        transport = stdioTransport;
        this.attachStderr(profile, stdioTransport.stderr, suppressStderr);
      } else {
        if (!this.upstream.url) {
          throw new MiftahError("UPSTREAM_START_FAILED", "UPSTREAM_START_FAILED: remote upstream requires a url");
        }
        if (this.upstream.transport === "sse") {
          const options = {
            ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
            fetch: this.options.remoteFetch ?? fetchSsePostWithStatusOnly
          };
          transport = new SSEClientTransport(new URL(this.upstream.url), options);
        } else {
          const options = {
            ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
            ...(oauthProvider === undefined ? {} : { authProvider: oauthProvider }),
            ...(this.options.remoteFetch === undefined ? {} : { fetch: this.options.remoteFetch })
          };
          streamableTransport = new StreamableHTTPClientTransport(new URL(this.upstream.url), options);
          transport = streamableTransport;
        }
      }

      transport = new ProgressPreservingTransport(transport);
      transportClosed = trackTransportClose(transport);
      let client = new Client({ name: "miftah", version: MIFTAH_VERSION });
      startingAttempt = {
        transport,
        transportClosed,
        generation,
        pid: null,
        ...(oauthProvider === undefined ? {} : { oauthProvider })
      };
      this.startingAttempts.set(profile, startingAttempt);
      let connection = client.connect(transport);
      startingAttempt.pid = stdioTransport?.pid ?? null;
      void connection.catch(() => undefined);
      try {
        await this.awaitConnection(connection, transportClosed);
      } catch (error) {
        if (!(error instanceof UnauthorizedError) || oauthProvider === undefined || streamableTransport === undefined) {
          throw oauthProvider === undefined ? error : this.oauthAuthorizationFailure(error);
        }
        try {
          const authorizationCode = await oauthProvider.waitForAuthorizationCode();
          await withTimeout(
            streamableTransport.finishAuth(authorizationCode),
            this.options.startupTimeoutMs,
            "OAUTH_AUTHORIZATION_FAILED",
            `OAUTH_AUTHORIZATION_FAILED: OAuth authorization could not be completed`
          );
        } catch (authorizationError) {
          throw this.oauthAuthorizationFailure(authorizationError);
        }
        await this.forceCloseTransport(transport, null);

        streamableTransport = new StreamableHTTPClientTransport(new URL(this.upstream.url!), {
          ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
          authProvider: oauthProvider,
          ...(this.options.remoteFetch === undefined ? {} : { fetch: this.options.remoteFetch })
        });
        transport = new ProgressPreservingTransport(streamableTransport);
        transportClosed = trackTransportClose(transport);
        client = new Client({ name: "miftah", version: MIFTAH_VERSION });
        startingAttempt = { transport, transportClosed, generation, pid: null, oauthProvider };
        this.startingAttempts.set(profile, startingAttempt);
        connection = client.connect(transport);
        void connection.catch(() => undefined);
        try {
          await this.awaitConnection(connection, transportClosed);
        } catch (connectionError) {
          throw this.oauthAuthorizationFailure(connectionError);
        }
      }

      if (oauthProvider !== undefined) {
        try {
          await oauthProvider.close();
        } catch (error) {
          throw this.oauthAuthorizationFailure(error);
        }
      }
      const pid = stdioTransport?.pid ?? null;
      if (!this.isCurrent(profile, generation)) {
        throw new MiftahError("UPSTREAM_START_FAILED", `UPSTREAM_START_FAILED: startup for '${profile}' was cancelled`);
      }

      const upstreamTransport = this.upstream.transport;
      const mapRequestError =
        upstreamTransport === "stdio" ? undefined : (error: unknown) => asRemoteError(profile, upstreamTransport, error);
      const session = new UpstreamSession(
        profile,
        generation,
        client,
        () => client.close(),
        {
          begin: () => this.beginOperation(profile, token, entry),
          end: () => this.endOperation(profile, token, entry)
        },
        mapRequestError
      );
      const entry: ManagedSession = {
        session,
        transport,
        transportClosed,
        pid,
        token,
        generation,
        ...(oauthProvider === undefined ? {} : { oauthProvider }),
        inFlight: 0,
        closing: false
      };
      this.sessions.set(profile, entry);
      if (this.startingAttempts.get(profile) === startingAttempt) this.startingAttempts.delete(profile);
      this.setProcessState(profile, "running", { pid });
      this.scheduleIdleShutdown(profile, entry);
      if (source === "automatic") this.scheduleStabilityWindow(profile, entry);
      this.publishLifecycle({
        type: source === "demand" ? "start" : "restart",
        profile,
        upstreamName: this.upstreamName,
        status: "success"
      });
      return session;
    } catch (error) {
      const pid = stdioTransport?.pid ?? null;
      let teardownPending = this.hasBlockingTeardown(profile);
      if (transport) {
        const teardownLease = this.beginTeardown(
          profile,
          pid === null ? [] : [transportClosed],
          "shutdown"
        );
        const reaped = await this.terminateTransport(transport, pid, transportClosed);
        if (teardownLease?.ownsTeardown) {
          const { teardown } = teardownLease;
          if (reaped || this.teardownIsComplete(teardown)) {
            this.completeTeardown(profile, teardown);
          } else {
            teardown.blocksReplacement = true;
            this.deferTeardown(profile, teardown);
          }
        }
        teardownPending = this.hasBlockingTeardown(profile);
      }
      await oauthProvider?.close().catch(() => undefined);
      if (this.startingAttempts.get(profile) === startingAttempt) this.startingAttempts.delete(profile);
      const current = this.isCurrent(profile, generation);
      const failure = current
        ? this.asStartFailure(profile, error)
        : new MiftahError("UPSTREAM_START_FAILED", `UPSTREAM_START_FAILED: startup for '${profile}' was cancelled`);
      if (current) {
        this.setProcessState(profile, "failed", { error: failure.message, resetCapabilities: true, pid: null });
        this.publishLifecycle({
          type: source === "demand" ? "start-failure" : "restart-failure",
          profile,
          upstreamName: this.upstreamName,
          status: "failure",
          errorCode: failure.code
        });
      }
      if (!teardownPending && (source !== "automatic" || !this.canAutomaticallyRetry(profile))) {
        this.releaseProfileCapacity(profile);
      } else if (!teardownPending && !reserved) {
        this.limiter.acquire(profile, this.upstreamName);
      }
      throw failure;
    }
  }

  private awaitConnection(connection: Promise<void>, transportClosed: TransportCloseSignal): Promise<void> {
    const closedDuringStartup = transportClosed.promise.then(
      () =>
        new Promise<never>((_resolve, reject) => {
          // A server can send an initialization error and immediately close.
          // Let the protocol dispatch that response before classifying a pure
          // transport close as a cancelled startup.
          setImmediate(() => {
            reject(
              new MiftahError(
                "UPSTREAM_START_FAILED",
                "UPSTREAM_START_FAILED: upstream transport closed during initialization"
              )
            );
          });
        })
    );
    return withTimeout(
      Promise.race([connection, closedDuringStartup]),
      this.options.startupTimeoutMs,
      "UPSTREAM_START_FAILED",
      `UPSTREAM_START_FAILED: startup timed out after ${this.options.startupTimeoutMs}ms`
    );
  }

  private oauthAuthorizationFailure(error: unknown): MiftahError {
    if (error instanceof MiftahError) return error;
    return new MiftahError(
      "OAUTH_AUTHORIZATION_FAILED",
      "OAUTH_AUTHORIZATION_FAILED: OAuth authorization could not be completed"
    );
  }

  /** Resolves per-profile process settings and retains credential values for later diagnostic redaction. */
  private async resolveProfileOptions(profileName: string, profile: ProfileConfig, args: string[]): Promise<{
    environment: Record<string, string>;
    headers: Record<string, string>;
    args: string[];
    suppressStderr: boolean;
  }> {
    const resolvedEnvironment = resolveProcessEnvironment(this.upstream.env, profile.env);
    const upstreamHeaders = this.upstream.headers
      ? expandEnvironmentReferencesWithSecretValues(this.upstream.headers)
      : undefined;
    const profileHeaders = profile.headers ? expandEnvironmentReferencesWithSecretValues(profile.headers) : undefined;
    const baseEnvironment = resolvedEnvironment.environment;
    let isolationEnvironment: Record<string, string> | undefined;
    let suppressStderr = false;
    if (profile.isolation !== undefined) {
      if (this.options.isolation === undefined) {
        throw new MiftahError(
          "UPSTREAM_START_FAILED",
          "UPSTREAM_START_FAILED: profile runtime isolation could not be prepared"
        );
      }
      const preparedIsolation = await this.options.isolation.prepare(
        profileName,
        this.upstreamName,
        profile.isolation,
        this.upstream.transport,
        this.upstream.command,
        args,
        baseEnvironment
      );
      isolationEnvironment = preparedIsolation.environment;
      suppressStderr = preparedIsolation.suppressStderr;
      args = preparedIsolation.args;
    }
    const environment = mergeEnvironment(baseEnvironment, isolationEnvironment);
    const headers = mergeHeaders(upstreamHeaders?.values, profileHeaders?.values);
    for (const value of [
      ...resolvedEnvironment.secretValues,
      ...(upstreamHeaders?.secretValues ?? []),
      ...(profileHeaders?.secretValues ?? [])
    ]) {
      this.redactor.add(value);
    }
    for (const [key, value] of Object.entries({ ...environment, ...headers })) {
      if (credentialKeyPattern.test(key) && value.length > 0) {
        this.redactor.add(value);
      }
    }
    return { environment, headers, args, suppressStderr };
  }

  /** Emits process stderr only after applying static and dynamically resolved secret redaction. */
  private attachStderr(profile: string, stderr: Stream | null, suppressOutput = false): void {
    if (suppressOutput) {
      let emitted = false;
      stderr?.on("data", () => {
        if (emitted) return;
        emitted = true;
        this.options.onStderr?.(profile, "[REDACTED]\n");
      });
      return;
    }
    const streamRedactor = this.redactor.createTextStream();
    const emit = (value: string): void => {
      if (value.length > 0) this.options.onStderr?.(profile, value);
    };
    stderr?.on("data", (chunk: Buffer) => {
      emit(streamRedactor.write(chunk.toString("utf8")));
    });
    stderr?.once("end", () => emit(streamRedactor.flush()));
    stderr?.once("close", () => emit(streamRedactor.flush()));
  }

  /** Redacts process-originated text using static and dynamically resolved secret values. */
  private redactProcessOutput(value: string): string {
    return this.redactor.redactText(value);
  }

  /** Handles an unexpected close only when it belongs to the current live session generation. */
  private handleTransportClosed(profile: string, token: number, generation: number): void {
    const entry = this.sessions.get(profile);
    if (!entry || entry.token !== token || entry.generation !== generation || entry.closing) return;

    this.sessions.delete(profile);
    void entry.oauthProvider?.close().catch(() => undefined);
    this.clearIdleTimer(profile);
    this.clearStabilityTimer(profile);
    if (!this.isCurrent(profile, generation)) return;

    this.setProcessState(profile, "failed", {
      error: "UPSTREAM_START_FAILED: upstream process closed unexpectedly",
      resetCapabilities: true,
      pid: null
    });
    this.publishLifecycle({
      type: "crash",
      profile,
      upstreamName: this.upstreamName,
      status: "failure",
      errorCode: "UPSTREAM_START_FAILED"
    });
    if (this.options.restartOnCrash) {
      this.scheduleAutomaticRestart(profile, generation);
    } else {
      this.releaseProfileCapacity(profile);
    }
  }

  /** Schedules one bounded automatic retry while retaining the profile's capacity reservation. */
  private scheduleAutomaticRestart(profile: string, generation: number): void {
    if (!this.isCurrent(profile, generation) || !this.options.restartOnCrash || this.manualRestarts.has(profile)) return;
    if (this.automaticRestarts.has(profile)) return;

    const nextAttempt = (this.consecutiveRestartAttempts.get(profile) ?? 0) + 1;
    if (nextAttempt > this.options.maxRestarts) {
      this.restartExhausted.add(profile);
      this.clearStabilityTimer(profile);
      this.setProcessState(profile, "failed", {
        error: `UPSTREAM_RESTART_LIMIT_EXCEEDED: automatic restart limit (${this.options.maxRestarts}) reached for '${profile}'`,
        resetCapabilities: true,
        pid: null,
        restartLimitReached: true
      });
      this.publishLifecycle({
        type: "restart-failure",
        profile,
        upstreamName: this.upstreamName,
        status: "failure",
        errorCode: "UPSTREAM_RESTART_LIMIT_EXCEEDED"
      });
      this.releaseProfileCapacity(profile);
      return;
    }

    this.consecutiveRestartAttempts.set(profile, nextAttempt);
    this.automaticRestartCounts.set(profile, (this.automaticRestartCounts.get(profile) ?? 0) + 1);
    const delayMs = this.restartDelay(nextAttempt);
    const nextRestartAt = new Date(Date.now() + delayMs).toISOString();
    this.setProcessState(profile, "failed", {
      error: `UPSTREAM_START_FAILED: upstream process closed unexpectedly; automatic restart ${nextAttempt}/${this.options.maxRestarts} scheduled`,
      resetCapabilities: true,
      pid: null,
      nextRestartAt
    });

    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const scheduled: ScheduledRestart = {
      generation,
      timer: setTimeout(() => {
        void this.runAutomaticRestart(profile, scheduled);
      }, delayMs),
      promise,
      resolve
    };
    this.automaticRestarts.set(profile, scheduled);
  }

  /** Runs the scheduled retry and chains another one only while this lifecycle generation remains current. */
  private async runAutomaticRestart(profile: string, scheduled: ScheduledRestart): Promise<void> {
    if (this.automaticRestarts.get(profile) !== scheduled) {
      scheduled.resolve();
      return;
    }
    this.automaticRestarts.delete(profile);
    try {
      if (this.isCurrent(profile, scheduled.generation)) {
        await this.startOnce(profile, "automatic");
      }
    } catch {
      if (this.isCurrent(profile, scheduled.generation)) {
        this.scheduleAutomaticRestart(profile, scheduled.generation);
      }
    } finally {
      scheduled.resolve();
    }
  }

  private restartDelay(attempt: number): number {
    const baseDelay = Math.min(maximumRestartDelayMs, initialRestartDelayMs * 2 ** (attempt - 1));
    const jitter = baseDelay * restartJitterFraction;
    return Math.max(1, Math.round(baseDelay - jitter + Math.random() * jitter * 2));
  }

  /** Clears the consecutive-crash budget only after an automatically recovered session remains stable. */
  private scheduleStabilityWindow(profile: string, entry: ManagedSession): void {
    this.clearStabilityTimer(profile);
    const timer = setTimeout(() => {
      const current = this.sessions.get(profile);
      if (!current || current.token !== entry.token || current.generation !== entry.generation || current.closing) return;
      this.consecutiveRestartAttempts.delete(profile);
    }, restartStabilityWindowMs);
    this.stabilityTimers.set(profile, timer);
  }

  private cancelAutomaticRestart(profile: string, releaseReservation: boolean): void {
    const scheduled = this.automaticRestarts.get(profile);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.automaticRestarts.delete(profile);
      scheduled.resolve();
    }
    if (releaseReservation && !this.sessions.has(profile) && !this.starts.has(profile)) {
      this.releaseProfileCapacity(profile);
    }
  }

  private resetRecoveryBudget(profile: string): void {
    this.restartExhausted.delete(profile);
    this.consecutiveRestartAttempts.delete(profile);
    this.clearStabilityTimer(profile);
  }

  private canAutomaticallyRetry(profile: string): boolean {
    return (
      this.options.restartOnCrash &&
      !this.restartExhausted.has(profile) &&
      (this.consecutiveRestartAttempts.get(profile) ?? 0) < this.options.maxRestarts
    );
  }

  private assertRestartAvailable(profile: string): void {
    if (!this.restartExhausted.has(profile)) return;
    throw new MiftahError(
      "UPSTREAM_RESTART_LIMIT_EXCEEDED",
      `UPSTREAM_RESTART_LIMIT_EXCEEDED: automatic recovery for '${profile}' is exhausted; use miftah_restart_profile to retry`
    );
  }

  /** Stops a profile, cancels an in-progress start, and avoids stale lifecycle state after a replacement begins. */
  private async stopProfile(profile: string, reason: UpstreamStopReason, releaseReservation: boolean): Promise<void> {
    const startingAttempt = this.startingAttempts.get(profile);
    const entry = this.sessions.get(profile);
    // A repeated stop with no current transport must not release capacity that an
    // already-closing child still owns. A replacement transport gets its own gate.
    if (!entry && !startingAttempt && this.hasPendingTeardown(profile)) return;

    const startEpoch = this.startEpoch(profile);
    this.incrementGeneration(profile);
    this.clearIdleTimer(profile);
    this.clearStabilityTimer(profile);
    this.sessions.delete(profile);
    let shutdownFailure: ShutdownFailureReason | undefined;
    const localCloseSignals: TransportCloseSignal[] = [];
    if (entry && entry.pid !== null) localCloseSignals.push(entry.transportClosed);
    if (startingAttempt && startingAttempt.pid !== null) localCloseSignals.push(startingAttempt.transportClosed);
    const teardownLease = this.beginTeardown(profile, localCloseSignals, reason);
    const teardown = teardownLease?.teardown;

    if (entry) {
      entry.closing = true;
      const closed = await this.closeSession(entry);
      shutdownFailure = closed.failure;
    }
    if (startingAttempt) {
      await this.terminateTransport(
        startingAttempt.transport,
        startingAttempt.pid,
        startingAttempt.transportClosed
      );
      await startingAttempt.oauthProvider?.close().catch(() => undefined);
    }
    const teardownPending = teardown !== undefined && !this.teardownIsComplete(teardown);
    if (teardownPending && teardownLease?.ownsTeardown) {
      teardown.blocksReplacement = true;
      this.deferTeardown(profile, teardown);
    }
    if (teardownPending) {
      shutdownFailure = "shutdown-timeout";
    } else if (teardownLease?.ownsTeardown && teardown !== undefined) {
      this.completeTeardown(profile, teardown);
    }
    if (this.startEpoch(profile) !== startEpoch) {
      if (!this.sessions.has(profile) && !this.starts.has(profile)) this.releaseProfileCapacity(profile);
      return;
    }
    if (teardownPending) {
      this.setProcessState(profile, "failed", {
        pid: null,
        error: `UPSTREAM_SHUTDOWN_TIMEOUT: upstream process cleanup is still pending for '${profile}'`,
        resetCapabilities: true
      });
      const failureCode = "UPSTREAM_SHUTDOWN_TIMEOUT";
      if (reason === "restart") {
        this.publishLifecycle({
          type: "restart-failure",
          profile,
          upstreamName: this.upstreamName,
          status: "failure",
          errorCode: failureCode
        });
      } else {
        this.publishLifecycle({
          type: reason === "idle" ? "idle" : "shutdown",
          profile,
          upstreamName: this.upstreamName,
          status: "failure",
          errorCode: failureCode
        });
      }
      return;
    }
    if (releaseReservation) this.releaseProfileCapacity(profile);
    this.setProcessState(profile, "stopped", {
      pid: null,
      resetCapabilities: true,
      lastStopReason: shutdownFailure ?? reason
    });
    const failureCode =
      shutdownFailure === "shutdown-timeout" ? "UPSTREAM_SHUTDOWN_TIMEOUT" : "UPSTREAM_SHUTDOWN_FAILED";
    if (reason === "restart" && shutdownFailure !== undefined) {
      this.publishLifecycle({
        type: "restart-failure",
        profile,
        upstreamName: this.upstreamName,
        status: "failure",
        errorCode: failureCode
      });
    } else if (reason !== "restart") {
      const failed = shutdownFailure !== undefined;
      this.publishLifecycle({
        type: reason === "idle" ? "idle" : "shutdown",
        profile,
        upstreamName: this.upstreamName,
        status: failed ? "failure" : "success",
        ...(failed ? { errorCode: failureCode } : {})
      });
    }
  }

  /** Stops a session and confirms a local child has exited before its capacity can be reused. */
  private async closeSession(entry: ManagedSession): Promise<{ failure?: ShutdownFailureReason; reaped: boolean }> {
    const close = this.closeManagedSession(entry);
    void close.catch(() => undefined);
    let failure: ShutdownFailureReason | undefined;
    try {
      await withTimeout(
        close,
        this.options.shutdownTimeoutMs,
        "UPSTREAM_SHUTDOWN_TIMEOUT",
        `UPSTREAM_SHUTDOWN_TIMEOUT: shutdown timed out after ${this.options.shutdownTimeoutMs}ms`
      );
    } catch (error) {
      failure = error instanceof MiftahError && error.code === "UPSTREAM_SHUTDOWN_TIMEOUT"
        ? "shutdown-timeout"
        : "shutdown-error";
    }
    // A timed-out remote DELETE still owns an in-flight HTTP request. Closing the
    // client transport aborts that request without turning remote cleanup into a
    // local-child capacity gate.
    if (entry.pid === null) {
      if (failure !== undefined) await this.forceCloseTransport(entry.transport, null);
      return { failure, reaped: true };
    }
    if (entry.transportClosed.isClosed()) return { failure, reaped: true };

    // The SDK can return from its own SIGKILL path before the child emits close.
    // Force the known PID once more, then use Miftah's existing shutdown bound to
    // decide whether it is safe to recycle this profile's capacity.
    await this.forceCloseTransport(entry.transport, entry.pid);
    try {
      await withTimeout(
        entry.transportClosed.promise,
        this.options.shutdownTimeoutMs,
        "UPSTREAM_SHUTDOWN_TIMEOUT",
        `UPSTREAM_SHUTDOWN_TIMEOUT: process cleanup timed out after ${this.options.shutdownTimeoutMs}ms`
      );
      return { failure, reaped: true };
    } catch {
      return { failure: "shutdown-timeout", reaped: false };
    }
  }

  private async terminateTransport(
    transport: Transport,
    pid: number | null,
    transportClosed?: TransportCloseSignal
  ): Promise<boolean> {
    const underlying = unwrapProgressPreservingTransport(transport);
    if (underlying instanceof StreamableHTTPClientTransport && underlying.sessionId) {
      await withTimeout(
        underlying.terminateSession(),
        this.options.shutdownTimeoutMs,
        "UPSTREAM_SHUTDOWN_TIMEOUT",
        `UPSTREAM_SHUTDOWN_TIMEOUT: remote session termination timed out after ${this.options.shutdownTimeoutMs}ms`
      ).catch(() => undefined);
    }
    await this.forceCloseTransport(transport, pid);
    if (pid === null || transportClosed === undefined || transportClosed.isClosed()) return true;
    try {
      await withTimeout(
        transportClosed.promise,
        this.options.shutdownTimeoutMs,
        "UPSTREAM_SHUTDOWN_TIMEOUT",
        `UPSTREAM_SHUTDOWN_TIMEOUT: process cleanup timed out after ${this.options.shutdownTimeoutMs}ms`
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Installs the local-child cleanup gate before any shutdown operation can await. */
  private beginTeardown(
    profile: string,
    signals: readonly TransportCloseSignal[],
    reason: UpstreamStopReason
  ): TeardownLease | undefined {
    if (signals.length === 0) return undefined;
    const closeSignals = [...new Set(signals)];
    const teardown: PendingTeardown = {
      signals: closeSignals,
      reason,
      blocksReplacement: false
    };
    const teardowns = this.pendingTeardowns.get(profile) ?? new Set<PendingTeardown>();
    const existing = [...teardowns].find((candidate) =>
      closeSignals.every((signal) => candidate.signals.includes(signal))
    );
    if (existing) return { teardown: existing, ownsTeardown: false };
    teardowns.add(teardown);
    this.pendingTeardowns.set(profile, teardowns);
    return { teardown, ownsTeardown: true };
  }

  /** Returns whether any local-child cleanup gate still owns this profile's capacity reservation. */
  private hasPendingTeardown(profile: string): boolean {
    return (this.pendingTeardowns.get(profile)?.size ?? 0) > 0;
  }

  /** Returns whether a timed-out local cleanup makes another process for this profile unsafe to start. */
  private hasBlockingTeardown(profile: string): boolean {
    return [...(this.pendingTeardowns.get(profile) ?? [])].some((teardown) => teardown.blocksReplacement);
  }

  /** Returns whether all local children protected by this cleanup gate have emitted close. */
  private teardownIsComplete(teardown: PendingTeardown): boolean {
    return teardown.signals.every((signal) => signal.isClosed());
  }

  /** Removes an owned cleanup gate after its local children have been confirmed reaped. */
  private completeTeardown(profile: string, teardown: PendingTeardown): boolean {
    const teardowns = this.pendingTeardowns.get(profile);
    if (teardowns === undefined || !teardowns.delete(teardown)) return false;
    if (teardowns.size === 0) this.pendingTeardowns.delete(profile);
    return true;
  }

  /** Releases capacity only when no local child cleanup gate remains for the profile. */
  private releaseProfileCapacity(profile: string): void {
    if (this.hasPendingTeardown(profile)) return;
    this.limiter.release(profile, this.upstreamName);
  }

  /** Holds profile capacity until every timed-out local transport has actually closed. */
  private deferTeardown(profile: string, teardown: PendingTeardown): void {
    void Promise.all(teardown.signals.map((signal) => signal.promise)).then(() => {
      this.completeDeferredTeardown(profile, teardown);
    });
  }

  /** Completes one deferred teardown only after every protected local transport has closed. */
  private completeDeferredTeardown(profile: string, teardown: PendingTeardown): void {
    if (!this.completeTeardown(profile, teardown)) return;
    const activeReplacement = this.sessions.has(profile) || this.starts.has(profile);
    if (!activeReplacement) this.releaseProfileCapacity(profile);
    if (this.closed || activeReplacement || this.hasPendingTeardown(profile)) return;
    this.setProcessState(profile, "stopped", {
      pid: null,
      resetCapabilities: true,
      lastStopReason: teardown.reason
    });
  }

  /** Completes already-verified deferred teardowns before another event-loop turn can acquire capacity. */
  private completeClosedDeferredTeardowns(profile: string): void {
    for (const teardown of [...(this.pendingTeardowns.get(profile) ?? [])]) {
      if (!teardown.blocksReplacement || !this.teardownIsComplete(teardown)) continue;
      this.completeDeferredTeardown(profile, teardown);
    }
  }

  /** Forcibly closes a transport without exceeding the configured shutdown bound. */
  private async forceCloseTransport(transport: Transport, pid: number | null): Promise<void> {
    const underlying = unwrapProgressPreservingTransport(transport);
    if (underlying instanceof ContainedStdioClientTransport) {
      let closedGracefully = false;
      const gracefulTimeoutMs = Math.min(this.options.shutdownTimeoutMs, forcedGracefulCloseTimeoutMs);
      await withTimeout(
        Promise.resolve().then(() => transport.close()),
        gracefulTimeoutMs,
        "UPSTREAM_SHUTDOWN_TIMEOUT",
        `UPSTREAM_SHUTDOWN_TIMEOUT: forced transport close timed out after ${gracefulTimeoutMs}ms`
      ).then(
        () => {
          closedGracefully = true;
        },
        () => undefined
      );
      if (!closedGracefully) {
        await withTimeout(
          underlying.forceTerminate(),
          this.options.shutdownTimeoutMs,
          "UPSTREAM_SHUTDOWN_TIMEOUT",
          `UPSTREAM_SHUTDOWN_TIMEOUT: process-tree cleanup timed out after ${this.options.shutdownTimeoutMs}ms`
        ).catch(() => undefined);
      }
      return;
    }
    if (pid !== null) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    }
    await withTimeout(
      Promise.resolve().then(() => transport.close()),
      this.options.shutdownTimeoutMs,
      "UPSTREAM_SHUTDOWN_TIMEOUT",
      `UPSTREAM_SHUTDOWN_TIMEOUT: forced transport close timed out after ${this.options.shutdownTimeoutMs}ms`
    ).catch(() => undefined);
  }

  /** Deletes a remote Streamable HTTP session before closing its local client transport. */
  private async closeManagedSession(entry: ManagedSession): Promise<void> {
    let terminationError: unknown;
    const underlying = unwrapProgressPreservingTransport(entry.transport);
    if (underlying instanceof StreamableHTTPClientTransport && underlying.sessionId) {
      try {
        await underlying.terminateSession();
      } catch (error) {
        terminationError = error;
      }
    }
    try {
      await entry.session.close();
    } catch (error) {
      if (terminationError === undefined) throw error;
    } finally {
      await entry.oauthProvider?.close().catch(() => undefined);
    }
    if (terminationError !== undefined) throw terminationError;
  }

  /** Prevents an idle timer from closing a session after the activity callback has admitted an operation. */
  private beginOperation(profile: string, token: number, entry: ManagedSession | undefined): void {
    const current = this.sessions.get(profile);
    if (!entry || current !== entry || entry.token !== token || entry.closing) {
      throw new MiftahError("UPSTREAM_CALL_FAILED", `UPSTREAM_CALL_FAILED: profile '${profile}' is no longer available`);
    }
    entry.inFlight += 1;
    this.clearIdleTimer(profile);
  }

  /** Re-arms idle shutdown only after the final in-flight operation completes. */
  private endOperation(profile: string, token: number, entry: ManagedSession | undefined): void {
    const current = this.sessions.get(profile);
    if (!entry || current !== entry || entry.token !== token) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    if (entry.inFlight === 0 && !entry.closing) this.scheduleIdleShutdown(profile, entry);
  }

  private scheduleIdleShutdown(profile: string, entry: ManagedSession): void {
    this.clearIdleTimer(profile);
    if (this.options.idleTimeoutMs === undefined || entry.inFlight > 0 || entry.closing || this.closed) return;
    const timer = setTimeout(() => {
      void this.closeIdleSession(profile, entry);
    }, this.options.idleTimeoutMs);
    this.idleTimers.set(profile, timer);
  }

  private async closeIdleSession(profile: string, entry: ManagedSession): Promise<void> {
    if (this.sessions.get(profile) !== entry || entry.inFlight > 0 || entry.closing || this.closed) return;
    await this.stopProfile(profile, "idle", true);
  }

  private clearIdleTimer(profile: string): void {
    const timer = this.idleTimers.get(profile);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(profile);
  }

  private clearStabilityTimer(profile: string): void {
    const timer = this.stabilityTimers.get(profile);
    if (timer) clearTimeout(timer);
    this.stabilityTimers.delete(profile);
  }

  private generation(profile: string): number {
    return this.generations.get(profile) ?? 0;
  }

  private incrementGeneration(profile: string): void {
    this.generations.set(profile, this.generation(profile) + 1);
  }

  private startEpoch(profile: string): number {
    return this.startEpochs.get(profile) ?? 0;
  }

  private incrementStartEpoch(profile: string): void {
    this.startEpochs.set(profile, this.startEpoch(profile) + 1);
  }

  private isCurrent(profile: string, generation: number): boolean {
    return !this.closed && this.generation(profile) === generation;
  }

  /** Prevents a closed manager from spawning a process after an async startup dependency settles. */
  private assertCurrentStartup(profile: string, generation: number): void {
    if (this.isCurrent(profile, generation)) return;
    throw new MiftahError("UPSTREAM_START_FAILED", `UPSTREAM_START_FAILED: startup for '${profile}' was cancelled`);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new MiftahError("UPSTREAM_START_FAILED", "UPSTREAM_START_FAILED: upstream manager is closed");
    }
  }

  private asStartFailure(profile: string, error: unknown): MiftahError {
    if (error instanceof MiftahError) return error;
    if (this.upstream.transport !== "stdio") {
      const remoteError = asRemoteError(profile, this.upstream.transport, error);
      if (remoteError) return remoteError;
    }
    return new MiftahError("UPSTREAM_INIT_FAILED", `UPSTREAM_INIT_FAILED: could not initialize profile '${profile}'`, {
      cause: this.redactProcessOutput(error instanceof Error ? error.message : String(error))
    });
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
        capabilities,
        lastStopReason: current.lastStopReason,
        nextRestartAt: current.nextRestartAt,
        restartLimitReached: current.restartLimitReached
      })
    );
  }

  private setProcessState(
    profile: string,
    processState: UpstreamProcessState,
    options: {
      pid?: number | null;
      error?: string;
      resetCapabilities?: boolean;
      lastStopReason?: UpstreamStopReason;
      nextRestartAt?: string;
      restartLimitReached?: boolean;
    } = {}
  ): void {
    if (processState === "failed" && options.error !== undefined) {
      this.processErrors.set(profile, options.error);
    } else if (processState !== "failed") {
      this.processErrors.delete(profile);
    }
    const current = this.health.get(profile);
    this.publishHealth(
      this.healthEntry(profile, processState, {
        pid: options.pid === undefined ? current?.pid : options.pid,
        capabilities: options.resetCapabilities ? this.initialCapabilities() : current?.capabilities,
        lastStopReason: processState === "stopped" ? options.lastStopReason : undefined,
        nextRestartAt: processState === "failed" ? options.nextRestartAt : undefined,
        restartLimitReached: processState === "failed" ? options.restartLimitReached : undefined
      })
    );
  }

  private healthEntry(
    profile: string,
    processState: UpstreamProcessState,
    options: {
      pid?: number | null;
      capabilities?: Record<UpstreamCapability, UpstreamCapabilityHealth>;
      lastStopReason?: UpstreamStopReason;
      nextRestartAt?: string;
      restartLimitReached?: boolean;
    } = {}
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
      restartCount: this.automaticRestartCounts.get(profile) ?? 0,
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(error === undefined ? {} : { error }),
      ...(options.lastStopReason === undefined ? {} : { lastStopReason: options.lastStopReason }),
      ...(options.nextRestartAt === undefined ? {} : { nextRestartAt: options.nextRestartAt }),
      ...(options.restartLimitReached === undefined ? {} : { restartLimitReached: options.restartLimitReached }),
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

/**
 * Resolves with the promise value or fails when the timeout elapses.
 *
 * @param promise - The asynchronous operation to bound.
 * @param timeoutMs - The maximum time to wait in milliseconds.
 * @param code - The error code used when the timeout elapses.
 * @param message - The error message used when the timeout elapses.
 * @returns The resolved value of `promise`.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: "UPSTREAM_START_FAILED" | "UPSTREAM_SHUTDOWN_TIMEOUT" | "OAUTH_AUTHORIZATION_FAILED",
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new MiftahError(code, message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
