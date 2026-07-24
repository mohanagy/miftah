import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AuditLogger } from "../audit/audit-logger.js";
import { AuditTrail } from "../audit/audit-trail.js";
import { loadConfig } from "../config/load-config.js";
import { getProviderAdapterForProfileTarget } from "../config/provider-adapters.js";
import type { MiftahConfig } from "../config/types.js";
import { identityStatusForAudit, type IdentityStatus } from "../identity/identity-types.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { evaluatePolicyEnforcement } from "../mcp/server/operation-pipeline.js";
import { createRuntimeFromLoadedConfig } from "../runtime/create-runtime.js";
import { SecretRedactor } from "../secrets/redact.js";
import { MiftahError, type MiftahErrorCode } from "../utils/errors.js";

export type ProfileReadinessStatus = "ready" | "unsupported" | "blocked" | "confirmation-required" | "identity-failed";

export interface ProfileReadinessReport {
  readonly status: ProfileReadinessStatus;
  readonly profile: string;
  readonly upstream: string;
  readonly adapter?: string;
  readonly safeRead: {
    readonly status: "passed" | "unavailable" | "blocked" | "confirmation-required";
    readonly tool?: string;
    readonly errorCode?: string;
  };
  readonly identity: {
    readonly status: "verified" | "unavailable" | "failed" | "not-checked";
    readonly errorCode?: MiftahErrorCode;
  };
}

export interface ProfileReadinessTarget {
  readonly profile: string;
  readonly upstream?: string;
  readonly signal?: AbortSignal;
}

interface ResolvedTarget {
  readonly profile: string;
  readonly upstream: string;
}

/** Loads one CLI configuration once, then performs a provider-declared first-success check from the loaded bytes. */
export async function runProfileReadiness(
  configPath: string,
  target: ProfileReadinessTarget
): Promise<ProfileReadinessReport> {
  return runProfileReadinessFromLoadedConfig(configPath, await loadConfig(configPath), target);
}

/**
 * Runs the same profile readiness flow from configuration a trusted caller has already opened.
 * Console callers use this form so a selected configuration is never reopened by pathname.
 */
export async function runProfileReadinessFromLoadedConfig(
  configPath: string,
  config: MiftahConfig,
  target: ProfileReadinessTarget
): Promise<ProfileReadinessReport> {
  throwIfAborted(target.signal);
  const resolvedTarget = resolveTarget(config, target);
  const adapter = getProviderAdapterForProfileTarget(config, resolvedTarget.profile, resolvedTarget.upstream);
  const probe = adapter?.diagnostics.safeReadProbe;
  if (adapter === undefined || probe === undefined) {
    return recordUnsupportedReadiness(config, resolvedTarget);
  }
  const trustedAdapter = adapter;
  const safeReadProbe = probe;

  // Do not resolve a secret provider, load a plugin, or construct a runtime before fail-closed audit readiness.
  // The selected target is passed into runtime resolution so another profile's unavailable credentials cannot block it.
  const audit = configuredAuditTrail(config, new SecretRedactor());
  try {
    await audit.ensureWritable();
  } catch (error) {
    throw safeReadinessError(error);
  }
  throwIfAborted(target.signal);
  const auditScope = audit.beginOperation({
    operation: "setup/profile-readiness",
    name: safeReadProbe.name,
    sourceProfile: resolvedTarget.profile,
    profile: resolvedTarget.profile
  });
  auditScope.update({
    upstream: resolvedTarget.upstream,
    routingReason: "setup-profile",
    routingSource: "setup-profile"
  });

  // Policy evaluation depends only on validated configuration. Run it before runtime resolution so a
  // denied or confirmation-required probe cannot load a plugin or resolve even the selected secret.
  const profileConfig = config.profiles[resolvedTarget.profile]!;
  const policy = new PolicyEngine(config.policies, config.tooling?.toolRiskOverrides ?? {}, {
    unknownRisk: config.tooling?.unknownToolRisk
  });
  const decision = policy.evaluate(profileConfig.policy, safeReadProbe.name, { providerAdapterSafeRead: true });
  auditScope.update({
    policyName: profileConfig.policy ?? "default",
    policyDecision: decision.action,
    risk: decision.risk,
    riskSource: decision.riskSource,
    riskConfidence: decision.riskConfidence
  });
  const enforcement = evaluatePolicyEnforcement({
    policyName: safeReadProbe.name,
    route: { profile: resolvedTarget.profile, reason: "setup-profile" },
    decision,
    profile: resolvedTarget.profile,
    requireExplicitRuleForDestructive: config.security?.requireExplicitProfileForDestructive
  });
  if (decision.risk !== "read" || enforcement.status === "blocked") {
    await auditScope.finish({ status: "blocked", errorCode: "POLICY_BLOCKED" });
    return {
      status: "blocked",
      profile: resolvedTarget.profile,
      upstream: resolvedTarget.upstream,
      adapter: trustedAdapter.displayName,
      safeRead: { status: "blocked", tool: safeReadProbe.name, errorCode: "POLICY_BLOCKED" },
      identity: { status: "not-checked" }
    };
  }
  if (decision.action === "confirm") {
    await auditScope.finish({ status: "confirmation-required", errorCode: "POLICY_CONFIRMATION_REQUIRED" });
    return {
      status: "confirmation-required",
      profile: resolvedTarget.profile,
      upstream: resolvedTarget.upstream,
      adapter: trustedAdapter.displayName,
      safeRead: { status: "confirmation-required", tool: safeReadProbe.name, errorCode: "POLICY_CONFIRMATION_REQUIRED" },
      identity: { status: "not-checked" }
    };
  }

  let runtime: Awaited<ReturnType<typeof createRuntimeFromLoadedConfig>> | undefined;
  let abortClose: Promise<void> | undefined;
  let abortListener: (() => void) | undefined;
  let report: ProfileReadinessReport | undefined;
  let operationError: MiftahError | undefined;
  try {
    report = await executeReadiness();
  } catch (error) {
    operationError = target.signal?.aborted ? readinessCancelledError() : safeReadinessError(error);
    if (!auditScope.isFinalized) {
      await auditScope.finish({ status: "failure", errorCode: operationError.code });
    }
  }
  if (abortListener !== undefined) target.signal?.removeEventListener("abort", abortListener);

  let cleanupError: MiftahError | undefined;
  try {
    if (abortClose !== undefined) {
      await abortClose;
    } else {
      await runtime?.manager.close();
    }
  } catch (error) {
    cleanupError = safeReadinessError(error);
  }

  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (report === undefined) {
    throw new MiftahError("UPSTREAM_CALL_FAILED", "UPSTREAM_CALL_FAILED: profile readiness did not produce a result");
  }
  return report;

  async function executeReadiness(): Promise<ProfileReadinessReport> {
    runtime = await createRuntimeFromLoadedConfig(configPath, config, resolutionScope(config, resolvedTarget), {
      dependencyMode: "profile-readiness",
      signal: target.signal
    });
    const closeRuntimeForAbort = () => {
      if (abortClose !== undefined || runtime === undefined) return;
      abortClose = runtime.manager.close();
      // The handler cannot await; the original promise is still observed after the operation settles.
      void abortClose.catch(() => undefined);
    };
    abortListener = closeRuntimeForAbort;
    target.signal?.addEventListener("abort", abortListener, { once: true });
    if (target.signal?.aborted) closeRuntimeForAbort();
    throwIfAborted(target.signal);
    throwIfAborted(target.signal);
    const session = await runtime.manager.get(resolvedTarget.profile, resolvedTarget.upstream);
    throwIfAborted(target.signal);
    const tool = (await session.listTools({ signal: target.signal })).tools.find((candidate) => candidate.name === safeReadProbe.name);
    if (tool === undefined) {
      await auditScope.finish({ status: "blocked", errorCode: "TOOL_NOT_FOUND" });
      return unavailableProbeReport(resolvedTarget, trustedAdapter.displayName, safeReadProbe.name, "TOOL_NOT_FOUND");
    }
    if (!acceptsEmptyObject(tool) || annotationsContradictSafeRead(tool)) {
      await auditScope.finish({ status: "blocked", errorCode: "TOOL_SCHEMA_MISMATCH" });
      return unavailableProbeReport(resolvedTarget, trustedAdapter.displayName, safeReadProbe.name, "TOOL_SCHEMA_MISMATCH");
    }

    const identity = await verifyIdentity(runtime, resolvedTarget, session, target.signal);
    auditScope.update({ identity: runtime.redactor.redactForAudit(identityStatusForAudit(identity.status)) });
    if (identity.report.status === "failed") {
      await auditScope.finish({ status: "failure", errorCode: identity.report.errorCode });
      return {
        status: "identity-failed",
        profile: resolvedTarget.profile,
        upstream: resolvedTarget.upstream,
        adapter: trustedAdapter.displayName,
        safeRead: { status: "unavailable", tool: safeReadProbe.name },
        identity: identity.report
      };
    }

    throwIfAborted(target.signal);
    const result = await session.callTool({ name: safeReadProbe.name, arguments: {} }, { signal: target.signal });
    if (result.isError === true) {
      throw new MiftahError(
        "UPSTREAM_CALL_FAILED",
        "UPSTREAM_CALL_FAILED: the declared safe profile readiness call did not complete"
      );
    }

    await auditScope.finish({ status: "success" });
    return {
      status: "ready",
      profile: resolvedTarget.profile,
      upstream: resolvedTarget.upstream,
      adapter: trustedAdapter.displayName,
      safeRead: { status: "passed", tool: safeReadProbe.name },
      identity: identity.report
    };
  }
}

function resolutionScope(config: MiftahConfig, target: ResolvedTarget) {
  return config.upstreams === undefined
    ? { profile: target.profile }
    : { profile: target.profile, upstreamName: target.upstream };
}

function resolveTarget(config: MiftahConfig, target: ProfileReadinessTarget): ResolvedTarget {
  if (!Object.hasOwn(config.profiles, target.profile)) {
    throw new MiftahError("PROFILE_NOT_FOUND", `PROFILE_NOT_FOUND: profile '${target.profile}' does not exist`);
  }
  if (config.upstreams === undefined) {
    if (target.upstream !== undefined && target.upstream !== "default") {
      throw new MiftahError("UPSTREAM_NOT_FOUND", "UPSTREAM_NOT_FOUND: the selected upstream does not exist");
    }
    return { profile: target.profile, upstream: "default" };
  }
  if (target.upstream !== undefined) {
    if (!Object.hasOwn(config.upstreams, target.upstream)) {
      throw new MiftahError("UPSTREAM_NOT_FOUND", "UPSTREAM_NOT_FOUND: the selected upstream does not exist");
    }
    return { profile: target.profile, upstream: target.upstream };
  }
  const upstreams = Object.keys(config.upstreams);
  if (upstreams.length !== 1) {
    throw new MiftahError(
      "UPSTREAM_SELECTION_AMBIGUOUS",
      "UPSTREAM_SELECTION_AMBIGUOUS: select one upstream for the profile readiness check"
    );
  }
  return { profile: target.profile, upstream: upstreams[0]! };
}

async function recordUnsupportedReadiness(
  config: MiftahConfig,
  target: ResolvedTarget
): Promise<ProfileReadinessReport> {
  const audit = configuredAuditTrail(config, new SecretRedactor());
  const scope = audit.beginOperation({
    operation: "setup/profile-readiness",
    name: "provider-adapter",
    sourceProfile: target.profile,
    profile: target.profile
  });
  await audit.ensureWritable();
  scope.update({ upstream: target.upstream, routingReason: "setup-profile", routingSource: "setup-profile" });
  await scope.finish({ status: "blocked", errorCode: "PROFILE_READINESS_UNSUPPORTED" });
  return {
    status: "unsupported",
    profile: target.profile,
    upstream: target.upstream,
    safeRead: { status: "unavailable", errorCode: "PROFILE_READINESS_UNSUPPORTED" },
    identity: { status: "not-checked" }
  };
}

function unavailableProbeReport(
  target: ResolvedTarget,
  adapter: string,
  tool: string,
  errorCode: "TOOL_NOT_FOUND" | "TOOL_SCHEMA_MISMATCH"
): ProfileReadinessReport {
  return {
    status: "unsupported",
    profile: target.profile,
    upstream: target.upstream,
    adapter,
    safeRead: { status: "unavailable", tool, errorCode },
    identity: { status: "not-checked" }
  };
}

function configuredAuditTrail(config: MiftahConfig, redactor: SecretRedactor): AuditTrail {
  const logger = config.audit?.enabled !== false && config.audit?.path
    ? new AuditLogger(config.audit.path, {
        includeArguments: config.audit.includeArguments,
        redactor,
        failureMode: config.audit.failureMode,
        rotation: config.audit.rotation,
        integrity: config.audit.integrity
      })
    : undefined;
  return new AuditTrail(config.name, logger);
}

async function verifyIdentity(
  runtime: Awaited<ReturnType<typeof createRuntimeFromLoadedConfig>>,
  target: ResolvedTarget,
  session: Awaited<ReturnType<typeof runtime.manager.get>>,
  signal: AbortSignal | undefined
): Promise<{
  readonly status: IdentityStatus;
  readonly report: ProfileReadinessReport["identity"];
}> {
  const current = runtime.identities.status(target.profile, target.upstream);
  if (current.status === "unconfigured") {
    return { status: current, report: { status: "unavailable" } };
  }
  const status = await runtime.identities.verify(target.profile, target.upstream, session, {
    force: true,
    request: { signal }
  });
  if (status.status === "verified") return { status, report: { status: "verified" } };
  return {
    status,
    report: { status: "failed", errorCode: status.errorCode ?? "IDENTITY_VERIFICATION_FAILED" }
  };
}

function acceptsEmptyObject(tool: Tool): boolean {
  return acceptsEmptySchema(tool.inputSchema);
}

function acceptsEmptySchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type !== undefined && schema.type !== "object") return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0)) return false;
  if (schema.minProperties !== undefined && schema.minProperties !== 0) return false;
  return Object.entries(schema).every(([key, value]) =>
    ["$schema", "$id", "title", "description", "type", "properties", "additionalProperties", "required", "minProperties"].includes(key) ||
      (key === "allOf" && Array.isArray(value) && value.every((entry) => acceptsEmptySchema(entry)))
  );
}

function annotationsContradictSafeRead(tool: Tool): boolean {
  const annotations = tool.annotations;
  return (
    (annotations?.readOnlyHint !== undefined && annotations.readOnlyHint !== true) ||
    (annotations?.destructiveHint !== undefined && annotations.destructiveHint !== false)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeReadinessError(error: unknown): MiftahError {
  if (error instanceof MiftahError) {
    return new MiftahError(error.code, `${error.code}: profile readiness did not complete`);
  }
  return new MiftahError(
    "UPSTREAM_CALL_FAILED",
    "UPSTREAM_CALL_FAILED: the declared safe profile readiness call did not complete"
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw readinessCancelledError();
}

function readinessCancelledError(): MiftahError {
  return new MiftahError("UPSTREAM_CALL_FAILED", "UPSTREAM_CALL_FAILED: profile readiness was cancelled");
}
