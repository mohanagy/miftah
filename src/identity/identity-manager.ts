import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { IdentityConfig, IdentityFingerprint, MiftahConfig, RiskLevel, ToolingConfig } from "../config/types.js";
import { classifyRisk } from "../policy/risk-classifier.js";
import type { UpstreamRequestOptions, UpstreamSession } from "../upstream/upstream-session.js";
import { MiftahError } from "../utils/errors.js";
import type { IdentityStatus } from "./identity-types.js";

const maxIdentityFieldLength = 256;
const maxIdentityResponseLength = 4_096;

export interface IdentityBindingRecord {
  readonly version: 1;
  readonly profile: string;
  readonly upstream: string | null;
  readonly configurationFingerprint: string;
  readonly evidence: IdentityFingerprint;
  readonly verifiedAt: string;
}

/** Persistent boundary for bounded, non-secret identity evidence. */
export interface IdentityBindingStore {
  load(): Promise<readonly unknown[]>;
  save(records: readonly IdentityBindingRecord[]): Promise<void>;
}

export interface IdentityManagerOptions {
  readonly bindingStore?: IdentityBindingStore;
}

export interface IdentityVerificationOptions {
  readonly force?: boolean;
  readonly request?: UpstreamRequestOptions;
}

interface PendingVerification {
  readonly controller: AbortController;
  readonly consumers: Set<PendingVerificationConsumer>;
  promise: Promise<IdentityStatus>;
  settled: boolean;
}

interface PendingVerificationConsumer {
  readonly onprogress?: UpstreamRequestOptions["onprogress"];
}

/** Verifies configured, non-secret upstream account fingerprints. */
export class IdentityManager {
  private readonly statuses = new Map<string, IdentityStatus>();
  private readonly cache = new Map<string, Map<string, IdentityStatus>>();
  private readonly inFlight = new Map<string, Map<string, PendingVerification>>();
  private readonly epochs = new Map<string, number>();
  private readonly bindings = new Map<string, IdentityBindingRecord>();
  private bindingStoreUnavailable = false;
  private initialization?: Promise<void>;

  constructor(
    private readonly config: MiftahConfig,
    private readonly options: IdentityManagerOptions = {}
  ) {}

  /** Loads only evidence that still matches an exact configured identity declaration. */
  async initialize(): Promise<void> {
    if (this.options.bindingStore === undefined) return;
    this.initialization ??= this.loadBindings();
    await this.initialization;
  }

  status(profile: string, upstreamName?: string): IdentityStatus {
    const effectiveUpstream = this.effectiveUpstreamName(upstreamName);
    const key = statusKey(profile, effectiveUpstream);
    const identity = this.identityConfig(profile, effectiveUpstream);
    const current = this.statuses.get(key);
    if (current && identity && current.status === "verified" && !isFresh(current, identity.maxAgeMs)) {
      return this.withBindingState({ ...structuredClone(current), status: "expired" }, key, identity, "expired");
    }
    return structuredClone(current ?? this.initialStatus(profile, upstreamName));
  }

  requiresVerification(profile: string, upstreamName: string | undefined, risk: RiskLevel): boolean {
    if (risk !== "write" && risk !== "destructive") return false;
    return (
      this.identityConfig(profile, this.effectiveUpstreamName(upstreamName))?.requiredForRisk?.some(
        (requiredRisk) => requiredRisk === risk
      ) === true
    );
  }

  /** Returns an opt-in selection boundary only when multiple configured accounts can be chosen. */
  selectionModeForRisk(
    profile: string,
    upstreamName: string | undefined,
    risk: RiskLevel
  ): IdentityConfig["selectionMode"] | undefined {
    if (Object.keys(this.config.profiles).length <= 1 || (risk !== "write" && risk !== "destructive")) return undefined;
    const identity = this.identityConfig(profile, this.effectiveUpstreamName(upstreamName));
    return identity?.requiredForRisk?.some((requiredRisk) => requiredRisk === risk) === true
      ? identity.selectionMode
      : undefined;
  }

  /** Records a safe non-cacheable failure when no live session could be acquired. */
  recordAcquisitionFailure(profile: string, upstreamName?: string): IdentityStatus {
    const effectiveUpstream = this.effectiveUpstreamName(upstreamName);
    const identity = this.identityConfig(profile, effectiveUpstream);
    if (!identity) return this.status(profile, effectiveUpstream);

    const status: IdentityStatus = {
      status: "failed",
      profile,
      upstream: effectiveUpstream ?? "default",
      expected: structuredClone(identity.expected),
      errorCode: "IDENTITY_VERIFICATION_FAILED"
    };
    const key = statusKey(profile, effectiveUpstream);
    const safeStatus = this.withBindingState(status, key, identity, "unavailable");
    this.statuses.set(key, safeStatus);
    return structuredClone(safeStatus);
  }

  /** Invalidates status and cache entries after an upstream lifecycle replacement. */
  invalidate(profile: string, upstreamName?: string): void {
    const key = statusKey(profile, this.effectiveUpstreamName(upstreamName));
    this.epochs.set(key, this.epoch(key) + 1);
    this.statuses.delete(key);
    this.cache.delete(key);
    this.inFlight.delete(key);
  }

  async verify(
    profile: string,
    upstreamName: string | undefined,
    session: UpstreamSession,
    options: IdentityVerificationOptions = {}
  ): Promise<IdentityStatus> {
    await this.initialize();
    const effectiveUpstream = this.effectiveUpstreamName(upstreamName);
    const identity = this.identityConfig(profile, effectiveUpstream);
    if (!identity) return this.status(profile, effectiveUpstream);
    if (options.request?.signal?.aborted) throw identityVerificationCancelled();

    const targetKey = statusKey(profile, effectiveUpstream);
    const epoch = this.epoch(targetKey);
    const sessionKey = `${session.generation}\u0000${epoch}`;
    const cached = this.cache.get(targetKey)?.get(sessionKey);
    if (!options.force && cached && isFresh(cached, identity.maxAgeMs)) return structuredClone(cached);

    const current = this.inFlight.get(targetKey)?.get(sessionKey);
    const pending =
      current !== undefined && !current.controller.signal.aborted && !current.settled
        ? current
        : this.createPending(targetKey, sessionKey, epoch, profile, effectiveUpstream, identity, session);
    if (this.inFlight.get(targetKey)?.get(sessionKey) !== pending) {
      let targetInFlight = this.inFlight.get(targetKey);
      if (!targetInFlight) {
        targetInFlight = new Map();
        this.inFlight.set(targetKey, targetInFlight);
      }
      targetInFlight.set(sessionKey, pending);
    }
    return structuredClone(await this.awaitPending(pending, options.request));
  }

  async requireVerified(
    profile: string,
    upstreamName: string | undefined,
    session: UpstreamSession,
    options: IdentityVerificationOptions = {}
  ): Promise<IdentityStatus> {
    const status = await this.verify(profile, upstreamName, session, options);
    if (status.status === "verified") return status;

    const code =
      status.status === "unconfigured"
        ? "IDENTITY_NOT_CONFIGURED"
        : status.errorCode ?? "IDENTITY_VERIFICATION_FAILED";
    throw new MiftahError(code, `${code}: identity verification did not complete for profile '${profile}'`, {
      profile,
      upstream: status.upstream,
      ...(status.expected ? { expected: status.expected } : {}),
      ...(status.actual ? { actual: status.actual } : {})
    });
  }

  private initialStatus(profile: string, upstreamName?: string): IdentityStatus {
    const identity = this.identityConfig(profile, upstreamName);
    const status: IdentityStatus = {
      status: identity ? "not-verified" : "unconfigured",
      profile,
      upstream: upstreamName ?? "default",
      ...(identity ? { expected: structuredClone(identity.expected) } : {})
    };
    return this.withBindingState(
      status,
      statusKey(profile, upstreamName),
      identity,
      identity === undefined ? "unavailable" : undefined
    );
  }

  private async loadBindings(): Promise<void> {
    try {
      const records = await this.options.bindingStore!.load();
      if (!Array.isArray(records)) throw new Error("Identity binding records must be an array");
      for (const value of records) {
        const record = this.validBindingRecord(value);
        if (record !== undefined) {
          this.bindings.set(statusKey(record.profile, storedUpstream(record.upstream)), record);
        }
      }
    } catch {
      this.bindingStoreUnavailable = true;
    }
  }

  private validBindingRecord(value: unknown): IdentityBindingRecord | undefined {
    if (!isRecord(value)) return undefined;
    if (
      value.version !== 1 ||
      typeof value.profile !== "string" ||
      (value.upstream !== null && typeof value.upstream !== "string") ||
      typeof value.configurationFingerprint !== "string" ||
      !isRecord(value.evidence) ||
      typeof value.verifiedAt !== "string" ||
      !validTimestamp(value.verifiedAt)
    ) {
      return undefined;
    }
    const upstreamName = storedUpstream(value.upstream);
    const identity = this.identityConfig(value.profile, upstreamName);
    if (identity === undefined || value.configurationFingerprint !== configurationFingerprint(identity)) return undefined;
    const evidence = parseStoredEvidence(value.evidence, identity.expected);
    if (evidence === undefined || !matches(identity.expected, evidence)) return undefined;
    return {
      version: 1,
      profile: value.profile,
      upstream: value.upstream,
      configurationFingerprint: value.configurationFingerprint,
      evidence,
      verifiedAt: value.verifiedAt
    };
  }

  private identityConfig(profile: string, upstreamName?: string): IdentityConfig | undefined {
    const profileConfig = this.config.profiles[profile];
    if (!profileConfig) return undefined;
    return upstreamName === undefined ? profileConfig.identity : profileConfig.upstreams?.[upstreamName]?.identity ?? profileConfig.identity;
  }

  private effectiveUpstreamName(upstreamName?: string): string | undefined {
    return upstreamName === "default" && this.config.upstreams === undefined ? undefined : upstreamName;
  }

  private epoch(key: string): number {
    return this.epochs.get(key) ?? 0;
  }

  private createPending(
    targetKey: string,
    sessionKey: string,
    epoch: number,
    profile: string,
    upstreamName: string | undefined,
    identity: IdentityConfig,
    session: UpstreamSession
  ): PendingVerification {
    const pending: PendingVerification = {
      controller: new AbortController(),
      consumers: new Set(),
      promise: Promise.resolve(undefined as never),
      settled: false
    };
    pending.promise = Promise.resolve()
      .then(() => this.probe(profile, upstreamName, identity, session, this.pendingRequestOptions(pending)))
      .then((result) => this.applyBindingResult(targetKey, profile, upstreamName, identity, result))
      .then((result) => {
        if (this.epoch(targetKey) === epoch && this.inFlight.get(targetKey)?.get(sessionKey) === pending) {
          let targetCache = this.cache.get(targetKey);
          if (!targetCache) {
            targetCache = new Map();
            this.cache.set(targetKey, targetCache);
          }
          targetCache.set(sessionKey, result);
          this.statuses.set(targetKey, result);
        }
        return result;
      })
      .finally(() => {
        pending.settled = true;
        const activeInFlight = this.inFlight.get(targetKey);
        if (activeInFlight?.get(sessionKey) === pending) {
          activeInFlight.delete(sessionKey);
          if (activeInFlight.size === 0) this.inFlight.delete(targetKey);
        }
      });
    // All callers may cancel before the shared upstream request settles.
    // Keep that completion observed so its rejection cannot become unhandled.
    void pending.promise.catch(() => undefined);
    return pending;
  }

  private async applyBindingResult(
    key: string,
    profile: string,
    upstreamName: string | undefined,
    identity: IdentityConfig,
    result: IdentityStatus
  ): Promise<IdentityStatus> {
    if (this.options.bindingStore === undefined) return result;
    if (this.bindingStoreUnavailable) {
      return this.withBindingState(
        { ...result, status: "failed", errorCode: "IDENTITY_BINDING_UNAVAILABLE" },
        key,
        identity,
        "unavailable"
      );
    }
    if (result.status === "mismatch") return this.withBindingState(result, key, identity, "changed");
    if (result.status !== "verified" || result.actual === undefined || result.verifiedAt === undefined) {
      return this.withBindingState(result, key, identity, "unavailable");
    }

    const existing = this.bindings.get(key);
    const record: IdentityBindingRecord = {
      version: 1,
      profile,
      upstream: storedUpstreamName(upstreamName),
      configurationFingerprint: configurationFingerprint(identity),
      evidence: structuredClone(result.actual),
      verifiedAt: result.verifiedAt
    };
    this.bindings.set(key, record);
    try {
      await this.options.bindingStore.save([...this.bindings.values()].map((binding) => structuredClone(binding)));
    } catch {
      if (existing === undefined) this.bindings.delete(key);
      else this.bindings.set(key, existing);
      this.bindingStoreUnavailable = true;
      return this.withBindingState(
        { ...result, status: "failed", errorCode: "IDENTITY_BINDING_UNAVAILABLE" },
        key,
        identity,
        "unavailable"
      );
    }
    return this.withBindingState(result, key, identity, "verified");
  }

  private withBindingState(
    status: IdentityStatus,
    key: string,
    identity: IdentityConfig | undefined,
    forcedState?: IdentityStatus["bindingState"]
  ): IdentityStatus {
    if (this.options.bindingStore === undefined) return status;
    const binding = this.bindings.get(key);
    const bindingState =
      forcedState ??
      (this.bindingStoreUnavailable
        ? "unavailable"
        : binding === undefined
          ? "unverified"
          : isFresh({ ...status, verifiedAt: binding.verifiedAt }, identity?.maxAgeMs ?? 0)
            ? "verified"
            : "expired");
    return {
      ...status,
      bindingState,
      ...(binding === undefined
        ? {}
        : { bound: structuredClone(binding.evidence), boundAt: binding.verifiedAt })
    };
  }

  private async awaitPending(
    pending: PendingVerification,
    options?: UpstreamRequestOptions
  ): Promise<IdentityStatus> {
    if (options?.signal?.aborted) throw identityVerificationCancelled();
    const consumer: PendingVerificationConsumer = { onprogress: options?.onprogress };
    pending.consumers.add(consumer);
    const signal = options?.signal;
    let abort: (() => void) | undefined;
    const cancelled =
      signal === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            abort = () => {
              pending.consumers.delete(consumer);
              this.abortPendingIfUnused(pending);
              reject(identityVerificationCancelled());
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

  private abortPendingIfUnused(pending: PendingVerification): void {
    if (!pending.settled && pending.consumers.size === 0) pending.controller.abort();
  }

  private pendingRequestOptions(pending: PendingVerification): UpstreamRequestOptions {
    return {
      signal: pending.controller.signal,
      onprogress: (progress) => {
        for (const consumer of pending.consumers) consumer.onprogress?.(progress);
      }
    };
  }

  private async probe(
    profile: string,
    upstreamName: string | undefined,
    identity: IdentityConfig,
    session: UpstreamSession,
    options?: UpstreamRequestOptions
  ): Promise<IdentityStatus> {
    const base = {
      profile,
      upstream: upstreamName ?? "default",
      expected: structuredClone(identity.expected),
      verifiedAt: new Date().toISOString()
    };

    try {
      const tool = (await session.listTools(options)).tools.find((candidate) => candidate.name === identity.probe.tool);
      if (!tool || !isSafeProbeTool(tool, identity.probe.tool, this.config.tooling?.toolRiskOverrides)) {
        return { ...base, status: "unsupported", errorCode: "IDENTITY_PROBE_UNSUPPORTED" };
      }
      const response = await session.callTool({ name: identity.probe.tool, arguments: {} }, options);
      if (response.isError === true) {
        return { ...base, status: "failed", errorCode: "IDENTITY_VERIFICATION_FAILED" };
      }
      const actual = parseIdentityResponse(response.content, identity);
      if (!actual) return { ...base, status: "failed", errorCode: "IDENTITY_VERIFICATION_FAILED" };
      const observed = expectedFingerprint(identity.expected, actual);
      if (!matches(identity.expected, observed)) {
        return { ...base, status: "mismatch", actual: observed, errorCode: "IDENTITY_MISMATCH" };
      }
      return { ...base, status: "verified", actual: observed };
    } catch {
      if (options?.signal?.aborted) throw identityVerificationCancelled();
      return { ...base, status: "failed", errorCode: "IDENTITY_VERIFICATION_FAILED" };
    }
  }
}

function identityVerificationCancelled(): Error {
  return new Error("Identity verification cancelled");
}

function statusKey(profile: string, upstreamName?: string): string {
  return JSON.stringify([profile, upstreamName]);
}

function storedUpstreamName(upstreamName?: string): string | null {
  return upstreamName ?? null;
}

function storedUpstream(upstreamName: string | null): string | undefined {
  return upstreamName ?? undefined;
}

function configurationFingerprint(identity: IdentityConfig): string {
  const expected = Object.fromEntries(
    (["provider", "login", "organization", "host"] as const)
      .filter((field) => identity.expected[field] !== undefined)
      .map((field) => [field, identity.expected[field]])
  );
  const probe = {
    tool: identity.probe.tool,
    resultFormat: identity.probe.resultFormat,
    ...(identity.probe.provider === undefined ? {} : { provider: identity.probe.provider })
  };
  return createHash("sha256")
    .update(JSON.stringify({ expected, probe }), "utf8")
    .digest("hex");
}

function parseStoredEvidence(
  value: Record<string, unknown>,
  expected: IdentityFingerprint
): IdentityFingerprint | undefined {
  if (!Object.keys(value).every((field) => ["provider", "login", "organization", "host"].includes(field))) {
    return undefined;
  }
  const evidence: IdentityFingerprint = {};
  for (const field of Object.keys(expected) as Array<keyof IdentityFingerprint>) {
    const stored = value[field];
    if (typeof stored !== "string") return undefined;
    const normalized = boundedIdentityField(stored);
    if (normalized === undefined || normalized !== stored) return undefined;
    evidence[field] = normalized;
  }
  return Object.keys(evidence).length === Object.keys(value).length ? evidence : undefined;
}

function validTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isSafeProbeTool(
  tool: Tool,
  name: string,
  overrides?: ToolingConfig["toolRiskOverrides"]
): boolean {
  if (classifyRisk(name, overrides ?? {}) !== "read") return false;
  return isEmptyObjectSafeSchema(tool.inputSchema);
}

function isEmptyObjectSafeSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (!Object.keys(schema).every((key) => ["type", "properties", "required", "minProperties", "additionalProperties"].includes(key))) {
    return false;
  }
  if (schema.type !== undefined && schema.type !== "object") return false;
  if (schema.properties !== undefined && !isRecord(schema.properties)) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 0)) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return false;
  return schema.minProperties === undefined || schema.minProperties === 0;
}

function parseIdentityResponse(
  content: readonly { type: string; text?: string }[],
  identity: IdentityConfig
): IdentityFingerprint | undefined {
  if (content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string") return undefined;
  if (content[0].text.length > maxIdentityResponseLength) return undefined;
  if (identity.probe.resultFormat === "text") {
    const login = boundedIdentityField(content[0].text);
    if (!login) return undefined;
    return { ...(identity.probe.provider ? { provider: identity.probe.provider } : {}), login };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content[0].text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const result: IdentityFingerprint = {};
  for (const field of ["provider", "login", "organization", "host"] as const) {
    const value = parsed[field];
    const normalized = typeof value === "string" ? boundedIdentityField(value) : undefined;
    if (normalized) result[field] = normalized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function expectedFingerprint(expected: IdentityFingerprint, actual: IdentityFingerprint): IdentityFingerprint {
  const result: IdentityFingerprint = {};
  for (const field of Object.keys(expected) as Array<keyof IdentityFingerprint>) {
    const value = actual[field];
    if (value !== undefined) result[field] = value;
  }
  return result;
}

function matches(expected: IdentityFingerprint, actual: IdentityFingerprint): boolean {
  return (Object.keys(expected) as Array<keyof IdentityFingerprint>).every((field) => expected[field] === actual[field]);
}

function boundedIdentityField(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxIdentityFieldLength ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFresh(status: IdentityStatus, maxAgeMs: number): boolean {
  if (!status.verifiedAt) return false;
  const verifiedAt = Date.parse(status.verifiedAt);
  const elapsed = Date.now() - verifiedAt;
  return Number.isFinite(verifiedAt) && elapsed >= 0 && elapsed < maxAgeMs;
}
