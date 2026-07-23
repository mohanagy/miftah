import { connectionCredentialKey, type OAuthConnectionBinding, type OAuthIdentityState } from "./connection-types.js";
import type {
  OAuthConnectionLifecycleAuditEvent,
  OAuthConnectionLifecycleAuditSink
} from "./audit.js";
import { OAuthConnectionRegistry, type OAuthConnectionRecord } from "./connection-registry.js";
import { OAuthLocalLockUnavailableError, withOAuthLocalLock } from "./local-lock.js";
import { type OAuthCredential, type OAuthCredentialStore } from "./secure-credential-store.js";
import { MiftahError } from "../utils/errors.js";

const defaultRefreshTimeoutMs = 30_000;
const defaultRefreshSkewMs = 60_000;
const maximumRefreshTimeoutMs = 120_000;
const maximumRefreshSkewMs = 300_000;
// A holder can legitimately execute the longest permitted refresh before committing its vault and
// metadata transaction. This is a lock bound, not a retry-based correctness mechanism.
const connectionTransactionLockWaitMilliseconds = maximumRefreshTimeoutMs + 5_000;

/**
 * The future authorization engine supplies this port after it has obtained a refresh-capable
 * credential. This core deliberately has no browser, metadata-discovery, or HTTP implementation.
 */
export interface OAuthCredentialRefresher {
  refresh(binding: OAuthConnectionBinding, credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
}

export interface OAuthConnectionLifecycleOptions {
  readonly registry: OAuthConnectionRegistry;
  readonly store: OAuthCredentialStore;
  readonly refresher?: OAuthCredentialRefresher;
  /** Optional journal sink that records only redacted lifecycle and identity state. */
  readonly audit?: OAuthConnectionLifecycleAuditSink;
  readonly now?: () => Date;
  readonly refreshTimeoutMs?: number;
  readonly refreshSkewMs?: number;
}

interface RefreshFlight {
  readonly controller: AbortController;
  readonly generation: number;
  readonly promise: Promise<OAuthCredential>;
  readonly consumers: Set<symbol>;
  settled: boolean;
}

type PreparedCredential =
  | { readonly kind: "ready"; readonly credential: OAuthCredential }
  | { readonly kind: "refresh"; readonly generation: number };

function isTerminalCredentialState(state: OAuthConnectionRecord["credentialState"]): boolean {
  return state === "disconnected" || state === "reauth-required" || state === "unsupported";
}

function invalidLifecycle(): never {
  throw new MiftahError("OAUTH_CONNECTION_INVALID", "OAUTH_CONNECTION_INVALID: OAuth connection lifecycle options are invalid");
}

function refreshCancelled(): MiftahError {
  return new MiftahError("OAUTH_REFRESH_CANCELLED", "OAUTH_REFRESH_CANCELLED: OAuth credential refresh was cancelled");
}

function refreshTimedOut(): MiftahError {
  return new MiftahError("OAUTH_REFRESH_TIMEOUT", "OAUTH_REFRESH_TIMEOUT: OAuth credential refresh timed out");
}

function reauthenticationRequired(): MiftahError {
  return new MiftahError("OAUTH_REAUTH_REQUIRED", "OAUTH_REAUTH_REQUIRED: OAuth connection requires reauthentication");
}

function authorizationNotEnabled(): MiftahError {
  return new MiftahError(
    "OAUTH_AUTHORIZATION_NOT_ENABLED",
    "OAUTH_AUTHORIZATION_NOT_ENABLED: OAuth authorization is not enabled in this Miftah release"
  );
}

function positiveDuration(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) invalidLifecycle();
  return result;
}

function expiryTime(credential: OAuthCredential): number | undefined {
  if (credential.expiresAt === undefined) return undefined;
  const value = Date.parse(credential.expiresAt);
  if (!Number.isFinite(value)) invalidLifecycle();
  return value;
}

/**
 * Coordinates one exact binding's vault credential state. Refreshes are single-flight only for
 * the full binding key, and caller cancellation cannot interrupt another caller's refresh.
 */
export class OAuthConnectionLifecycle {
  private readonly refreshes = new Map<string, RefreshFlight>();
  private readonly generations = new Map<string, number>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly refreshTimeoutMs: number;
  private readonly refreshSkewMs: number;

  constructor(private readonly options: OAuthConnectionLifecycleOptions) {
    this.now = options.now ?? (() => new Date());
    this.refreshTimeoutMs = positiveDuration(options.refreshTimeoutMs, defaultRefreshTimeoutMs, maximumRefreshTimeoutMs);
    this.refreshSkewMs = positiveDuration(options.refreshSkewMs, defaultRefreshSkewMs, maximumRefreshSkewMs);
  }

  async register(binding: OAuthConnectionBinding): Promise<OAuthConnectionRecord> {
    return this.mutateBinding(binding, async () => {
      const record = await this.options.registry.create(binding);
      this.recordAudit("register", binding, record, "success");
      return record;
    });
  }

  async connect(binding: OAuthConnectionBinding, credential: OAuthCredential): Promise<OAuthConnectionRecord> {
    const generation = this.advanceGeneration(binding);
    this.abortRefresh(binding);
    return this.withBindingLock(binding, () =>
      this.mutateBinding(binding, async () => {
        let vaultSaved = false;
        if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
        try {
          await this.options.registry.create(binding);
          await this.options.store.save(binding, credential);
          vaultSaved = true;
          if (!this.isCurrentGeneration(binding, generation)) {
            await this.options.store.delete(binding);
            throw refreshCancelled();
          }
          const record = await this.options.registry.setCredentialState(
            binding.connectionRef,
            binding,
            this.credentialState(credential),
            credential.expiresAt
          );
          if (!this.isCurrentGeneration(binding, generation)) {
            await this.options.store.delete(binding);
            throw refreshCancelled();
          }
          this.recordAudit("connect", binding, record, "success");
          return record;
        } catch (error) {
          if (vaultSaved && this.isCurrentGeneration(binding, generation)) await this.options.store.delete(binding);
          throw error;
        }
      })
    );
  }

  async credential(binding: OAuthConnectionBinding, options: { readonly signal?: AbortSignal } = {}): Promise<OAuthCredential> {
    const generation = this.currentGeneration(binding);
    const prepared = await this.withBindingLock(binding, () =>
      this.mutateBinding(binding, async (): Promise<PreparedCredential> => {
        if (options.signal?.aborted || !this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
        const record = await this.options.registry.get(binding.connectionRef, binding);
        if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
        const credential = await this.options.store.load(binding);
        if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
        if (credential === undefined) {
          const record = await this.options.registry.setCredentialState(binding.connectionRef, binding, "reauth-required");
          if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
          this.recordAudit("reauth-required", binding, record, "failure", "OAUTH_REAUTH_REQUIRED");
          throw reauthenticationRequired();
        }

        // Metadata is authoritative for terminal connection state. A failed compensation can leave
        // an orphaned vault entry behind; it must never turn a disconnected connection back on.
        if (isTerminalCredentialState(record.credentialState)) {
          throw reauthenticationRequired();
        }

        if (!this.needsRefresh(credential)) {
          await this.options.registry.setCredentialState(binding.connectionRef, binding, "connected", credential.expiresAt);
          if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
          return { kind: "ready", credential };
        }

        await this.options.registry.setCredentialState(
          binding.connectionRef,
          binding,
          this.credentialState(credential),
          credential.expiresAt
        );
        if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
        return { kind: "refresh", generation };
      })
    );

    if (prepared.kind === "ready") return prepared.credential;
    if (!this.isCurrentGeneration(binding, prepared.generation)) throw refreshCancelled();
    if (this.options.refresher === undefined) throw authorizationNotEnabled();
    return this.joinRefresh(binding, prepared.generation, options.signal);
  }

  async disconnect(binding: OAuthConnectionBinding): Promise<OAuthConnectionRecord> {
    this.advanceGeneration(binding);
    this.abortRefresh(binding);
    return this.withBindingLock(binding, () =>
      this.mutateBinding(binding, async () => {
        await this.options.registry.get(binding.connectionRef, binding);
        const record = await this.options.registry.setCredentialState(binding.connectionRef, binding, "disconnected");
        await this.options.store.delete(binding);
        this.recordAudit("disconnect", binding, record, "success");
        return record;
      })
    );
  }

  async status(binding: OAuthConnectionBinding): Promise<OAuthConnectionRecord> {
    return this.mutateBinding(binding, async () => {
      const record = await this.options.registry.get(binding.connectionRef, binding);
      if (isTerminalCredentialState(record.credentialState) || record.expiresAt === undefined) return record;
      const expiresAt = Date.parse(record.expiresAt);
      if (!Number.isFinite(expiresAt)) invalidLifecycle();
      const state = this.deriveExpiryState(expiresAt, this.currentTime());
      if (state === record.credentialState) return record;
      const updated = await this.options.registry.setCredentialState(
        binding.connectionRef,
        binding,
        state,
        record.expiresAt
      );
      this.recordAudit("status", binding, updated, "success");
      return updated;
    });
  }

  async setIdentityState(binding: OAuthConnectionBinding, state: OAuthIdentityState): Promise<OAuthConnectionRecord> {
    return this.mutateBinding(binding, async () => {
      const record = await this.options.registry.setIdentityState(binding.connectionRef, binding, state);
      this.recordAudit("identity", binding, record, "success");
      return record;
    });
  }

  private needsRefresh(credential: OAuthCredential): boolean {
    const expiresAt = expiryTime(credential);
    if (expiresAt === undefined) return false;
    return expiresAt <= this.currentTime() + this.refreshSkewMs;
  }

  private credentialState(credential: OAuthCredential): "connected" | "expiring" | "expired" {
    return this.deriveExpiryState(expiryTime(credential), this.currentTime());
  }

  private deriveExpiryState(
    expiresAt: number | undefined,
    now: number
  ): "connected" | "expiring" | "expired" {
    if (expiresAt === undefined) return "connected";
    if (expiresAt <= now) return "expired";
    if (expiresAt <= now + this.refreshSkewMs) return "expiring";
    return "connected";
  }

  private currentTime(): number {
    const value = this.now();
    if (!(value instanceof Date)) invalidLifecycle();
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) invalidLifecycle();
    return timestamp;
  }

  private joinRefresh(
    binding: OAuthConnectionBinding,
    generation: number,
    signal: AbortSignal | undefined
  ): Promise<OAuthCredential> {
    const key = connectionCredentialKey(binding);
    let flight = this.refreshes.get(key);
    if (flight === undefined || flight.generation !== generation) {
      flight?.controller.abort();
      const controller = new AbortController();
      const promise = this.refresh(binding, generation, controller);
      flight = { controller, generation, promise, consumers: new Set<symbol>(), settled: false };
      this.refreshes.set(key, flight);
      void promise.then(
        () => this.finishRefresh(key, flight as RefreshFlight),
        () => this.finishRefresh(key, flight as RefreshFlight)
      );
    }
    return this.consumeRefresh(flight, signal);
  }

  private consumeRefresh(flight: RefreshFlight, signal: AbortSignal | undefined): Promise<OAuthCredential> {
    if (signal?.aborted) return Promise.reject(refreshCancelled());
    const consumer = Symbol("oauth-refresh-consumer");
    flight.consumers.add(consumer);
    return new Promise<OAuthCredential>((resolve, reject) => {
      let complete = false;
      const release = (): void => {
        if (complete) return;
        complete = true;
        signal?.removeEventListener("abort", abort);
        flight.consumers.delete(consumer);
        if (!flight.settled && flight.consumers.size === 0 && !flight.controller.signal.aborted) {
          flight.controller.abort();
        }
      };
      const abort = (): void => {
        release();
        reject(refreshCancelled());
      };
      signal?.addEventListener("abort", abort, { once: true });
      flight.promise.then(
        (credential) => {
          if (complete) return;
          release();
          resolve(credential);
        },
        (error: unknown) => {
          if (complete) return;
          release();
          reject(error);
        }
      );
      if (signal?.aborted) abort();
    });
  }

  private async refresh(
    binding: OAuthConnectionBinding,
    generation: number,
    controller: AbortController
  ): Promise<OAuthCredential> {
    return this.withBindingLock(binding, async () => {
      const refresher = this.options.refresher;
      if (refresher === undefined) throw authorizationNotEnabled();

      let refreshStarted = true;
      let timedOut = false;
      try {
        if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
        const record = await this.options.registry.get(binding.connectionRef, binding);
        if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
        if (isTerminalCredentialState(record.credentialState)) {
          refreshStarted = false;
          if (record.credentialState === "disconnected") throw refreshCancelled();
          throw reauthenticationRequired();
        }
        const currentCredential = await this.options.store.load(binding);
        if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
        if (currentCredential === undefined) {
          refreshStarted = false;
          if (record.credentialState === "disconnected") throw refreshCancelled();
          const failed = await this.options.registry.setCredentialState(binding.connectionRef, binding, "reauth-required");
          this.recordAudit("reauth-required", binding, failed, "failure", "OAUTH_REAUTH_REQUIRED");
          throw reauthenticationRequired();
        }
        if (!this.needsRefresh(currentCredential)) return currentCredential;

        const refreshed = await this.refreshBeforeDeadline(refresher, binding, currentCredential, controller, () => {
          timedOut = true;
        });
        refreshStarted = false;
        if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
        return this.persistRefreshedCredential(binding, this.mergeRefreshedCredential(currentCredential, refreshed), generation);
      } catch (error) {
        if (timedOut) {
          if (this.isCurrentGeneration(binding, generation)) {
            await this.terminalFailure(binding, generation, "OAUTH_REFRESH_TIMEOUT");
          }
          throw refreshTimedOut();
        }
        if (controller.signal.aborted || !this.isCurrentGeneration(binding, generation)) {
          throw refreshCancelled();
        }
        if (refreshStarted) {
          await this.terminalFailure(binding, generation, "OAUTH_REAUTH_REQUIRED");
          throw reauthenticationRequired();
        }
        if (error instanceof MiftahError) {
          if (error.code === "OAUTH_CREDENTIAL_INVALID") {
            await this.terminalFailure(binding, generation, "OAUTH_REAUTH_REQUIRED");
          }
          throw error;
        }
        await this.terminalFailure(binding, generation, "OAUTH_REAUTH_REQUIRED");
        throw reauthenticationRequired();
      }
    });
  }

  private async refreshBeforeDeadline(
    refresher: OAuthCredentialRefresher,
    binding: OAuthConnectionBinding,
    credential: OAuthCredential,
    controller: AbortController,
    onTimeout: () => void
  ): Promise<OAuthCredential> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        onTimeout();
        controller.abort();
        reject(refreshTimedOut());
      }, this.refreshTimeoutMs);
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        removeAbortListener = undefined;
        reject(refreshCancelled());
      };
      if (controller.signal.aborted) {
        abort();
        return;
      }
      controller.signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", abort);
    });

    try {
      return await Promise.race([
        Promise.resolve().then(() => refresher.refresh(binding, credential, controller.signal)),
        deadline,
        cancellation
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeAbortListener?.();
    }
  }

  private async persistRefreshedCredential(
    binding: OAuthConnectionBinding,
    credential: OAuthCredential,
    generation: number
  ): Promise<OAuthCredential> {
    return this.mutateBinding(binding, async () => {
      let vaultSaved = false;
      if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
      try {
        await this.options.registry.setCredentialState(binding.connectionRef, binding, "reauth-required");
        if (!this.isCurrentGeneration(binding, generation)) throw refreshCancelled();
        await this.options.store.save(binding, credential);
        vaultSaved = true;
        if (!this.isCurrentGeneration(binding, generation)) {
          await this.options.store.delete(binding);
          throw refreshCancelled();
        }
        const record = await this.options.registry.setCredentialState(binding.connectionRef, binding, "connected", credential.expiresAt);
        if (!this.isCurrentGeneration(binding, generation)) {
          await this.options.store.delete(binding);
          throw refreshCancelled();
        }
        this.recordAudit("refresh", binding, record, "success");
        return credential;
      } catch (error) {
        if (vaultSaved && this.isCurrentGeneration(binding, generation)) await this.options.store.delete(binding);
        throw error;
      }
    });
  }

  private async terminalFailure(
    binding: OAuthConnectionBinding,
    generation: number,
    errorCode: "OAUTH_REFRESH_TIMEOUT" | "OAUTH_REAUTH_REQUIRED"
  ): Promise<void> {
    await this.mutateBinding(binding, async () => {
      if (!this.isCurrentGeneration(binding, generation)) return;
      const record = await this.options.registry.setCredentialState(binding.connectionRef, binding, "reauth-required");
      if (!this.isCurrentGeneration(binding, generation)) return;
      this.recordAudit("reauth-required", binding, record, "failure", errorCode);
      await this.options.store.delete(binding);
    });
  }

  private mergeRefreshedCredential(previous: OAuthCredential, refreshed: OAuthCredential): OAuthCredential {
    return {
      accessToken: refreshed.accessToken,
      ...(refreshed.refreshToken === undefined && previous.refreshToken !== undefined
        ? { refreshToken: previous.refreshToken }
        : refreshed.refreshToken === undefined
          ? {}
          : { refreshToken: refreshed.refreshToken }),
      ...(refreshed.expiresAt === undefined ? {} : { expiresAt: refreshed.expiresAt }),
      ...(refreshed.scopes === undefined && previous.scopes !== undefined
        ? { scopes: previous.scopes }
        : refreshed.scopes === undefined
          ? {}
          : { scopes: refreshed.scopes }),
      ...(refreshed.clientId === undefined && previous.clientId !== undefined
        ? { clientId: previous.clientId }
        : refreshed.clientId === undefined
          ? {}
          : { clientId: refreshed.clientId }),
      ...(refreshed.clientSecret === undefined && previous.clientSecret !== undefined
        ? { clientSecret: previous.clientSecret }
        : refreshed.clientSecret === undefined
          ? {}
          : { clientSecret: refreshed.clientSecret })
    };
  }

  /** Lifecycle audit is observational; a post-commit journal failure cannot turn a usable state into a false failure. */
  private recordAudit(
    action: OAuthConnectionLifecycleAuditEvent["action"],
    binding: OAuthConnectionBinding,
    record: OAuthConnectionRecord,
    status: OAuthConnectionLifecycleAuditEvent["status"],
    errorCode?: string
  ): void {
    if (this.options.audit === undefined) return;
    try {
      void this.options.audit.record({
        action,
        profile: binding.profile,
        upstream: binding.upstream,
        credentialState: record.credentialState,
        identityState: record.identityState,
        status,
        ...(errorCode === undefined ? {} : { errorCode })
      }).catch(() => undefined);
    } catch {
      // The standard AuditTrail uses the same best-effort lifecycle semantics and retains its own health state.
    }
  }

  private async withBindingLock<Value>(binding: OAuthConnectionBinding, operation: () => Promise<Value>): Promise<Value> {
    try {
      return await withOAuthLocalLock(
        "connection-lifecycle",
        connectionCredentialKey(binding),
        connectionTransactionLockWaitMilliseconds,
        operation
      );
    } catch (error) {
      if (error instanceof OAuthLocalLockUnavailableError) {
        throw new MiftahError(
          "OAUTH_CONNECTION_STORE_UNAVAILABLE",
          "OAUTH_CONNECTION_STORE_UNAVAILABLE: OAuth connection lifecycle coordination is unavailable"
        );
      }
      throw error;
    }
  }

  private currentGeneration(binding: OAuthConnectionBinding): number {
    return this.generations.get(connectionCredentialKey(binding)) ?? 0;
  }

  private advanceGeneration(binding: OAuthConnectionBinding): number {
    const key = connectionCredentialKey(binding);
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  private isCurrentGeneration(binding: OAuthConnectionBinding, expected: number): boolean {
    return this.currentGeneration(binding) === expected;
  }

  private abortRefresh(binding: OAuthConnectionBinding): void {
    this.refreshes.get(connectionCredentialKey(binding))?.controller.abort();
  }

  private finishRefresh(key: string, flight: RefreshFlight): void {
    flight.settled = true;
    if (this.refreshes.get(key) === flight) this.refreshes.delete(key);
  }

  private async mutateBinding<Value>(binding: OAuthConnectionBinding, operation: () => Promise<Value>): Promise<Value> {
    const key = connectionCredentialKey(binding);
    const previous = this.mutations.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const complete = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => complete);
    this.mutations.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.mutations.get(key) === tail) this.mutations.delete(key);
    }
  }
}
