import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { IdentityConfig, IdentityFingerprint, MiftahConfig, RiskLevel, ToolingConfig } from "../config/types.js";
import { classifyRisk } from "../policy/risk-classifier.js";
import type { UpstreamSession } from "../upstream/upstream-session.js";
import { MiftahError } from "../utils/errors.js";
import type { IdentityStatus } from "./identity-types.js";

const maxIdentityFieldLength = 256;
const maxIdentityResponseLength = 4_096;

/** Verifies configured, non-secret upstream account fingerprints. */
export class IdentityManager {
  private readonly statuses = new Map<string, IdentityStatus>();
  private readonly cache = new Map<string, Map<string, IdentityStatus>>();
  private readonly inFlight = new Map<string, Map<string, Promise<IdentityStatus>>>();
  private readonly epochs = new Map<string, number>();

  constructor(private readonly config: MiftahConfig) {}

  status(profile: string, upstreamName?: string): IdentityStatus {
    const effectiveUpstream = this.effectiveUpstreamName(upstreamName);
    const key = statusKey(profile, effectiveUpstream);
    const identity = this.identityConfig(profile, effectiveUpstream);
    const current = this.statuses.get(key);
    if (current && identity && current.status === "verified" && !isFresh(current, identity.maxAgeMs)) {
      return { ...structuredClone(current), status: "expired" };
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
    this.statuses.set(statusKey(profile, effectiveUpstream), status);
    return structuredClone(status);
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
    options: { force?: boolean } = {}
  ): Promise<IdentityStatus> {
    const effectiveUpstream = this.effectiveUpstreamName(upstreamName);
    const identity = this.identityConfig(profile, effectiveUpstream);
    if (!identity) return this.status(profile, effectiveUpstream);

    const targetKey = statusKey(profile, effectiveUpstream);
    const epoch = this.epoch(targetKey);
    const sessionKey = `${session.generation}\u0000${epoch}`;
    const cached = this.cache.get(targetKey)?.get(sessionKey);
    if (!options.force && cached && isFresh(cached, identity.maxAgeMs)) return structuredClone(cached);

    const current = this.inFlight.get(targetKey)?.get(sessionKey);
    if (current) return structuredClone(await current);

    const verification = this.probe(profile, effectiveUpstream, identity, session);
    let targetInFlight = this.inFlight.get(targetKey);
    if (!targetInFlight) {
      targetInFlight = new Map();
      this.inFlight.set(targetKey, targetInFlight);
    }
    targetInFlight.set(sessionKey, verification);
    try {
      const result = await verification;
      if (this.epoch(targetKey) === epoch) {
        let targetCache = this.cache.get(targetKey);
        if (!targetCache) {
          targetCache = new Map();
          this.cache.set(targetKey, targetCache);
        }
        targetCache.set(sessionKey, result);
        this.statuses.set(targetKey, result);
      }
      return structuredClone(result);
    } finally {
      const activeInFlight = this.inFlight.get(targetKey);
      if (activeInFlight?.get(sessionKey) === verification) {
        activeInFlight.delete(sessionKey);
        if (activeInFlight.size === 0) this.inFlight.delete(targetKey);
      }
    }
  }

  async requireVerified(profile: string, upstreamName: string | undefined, session: UpstreamSession): Promise<IdentityStatus> {
    const status = await this.verify(profile, upstreamName, session);
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
    return {
      status: identity ? "not-verified" : "unconfigured",
      profile,
      upstream: upstreamName ?? "default",
      ...(identity ? { expected: structuredClone(identity.expected) } : {})
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

  private async probe(
    profile: string,
    upstreamName: string | undefined,
    identity: IdentityConfig,
    session: UpstreamSession
  ): Promise<IdentityStatus> {
    const base = {
      profile,
      upstream: upstreamName ?? "default",
      expected: structuredClone(identity.expected),
      verifiedAt: new Date().toISOString()
    };

    try {
      const tool = (await session.listTools()).tools.find((candidate) => candidate.name === identity.probe.tool);
      if (!tool || !isSafeProbeTool(tool, identity.probe.tool, this.config.tooling?.toolRiskOverrides)) {
        return { ...base, status: "unsupported", errorCode: "IDENTITY_PROBE_UNSUPPORTED" };
      }
      const response = await session.callTool({ name: identity.probe.tool, arguments: {} });
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
      return { ...base, status: "failed", errorCode: "IDENTITY_VERIFICATION_FAILED" };
    }
  }
}

function statusKey(profile: string, upstreamName?: string): string {
  return JSON.stringify([profile, upstreamName]);
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
