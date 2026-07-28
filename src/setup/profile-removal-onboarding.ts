import { dirname } from "node:path";
import { AuditLogger } from "../audit/audit-logger.js";
import { AuditTrail } from "../audit/audit-trail.js";
import {
  applyConfigReplacement,
  readConfigMigrationSource,
  restoreConfigReplacementWithoutPublishingBackup,
  type ConfigMigrationSource
} from "../cli/migrate-config.js";
import { planConfigMigration } from "../config/migrate-config.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig } from "../config/types.js";
import { validateConfig } from "../config/validate-config.js";
import { MiftahError } from "../utils/errors.js";

export interface ProfileRemovalRequest {
  readonly configPath: string;
  /** One configured profile to remove from the selected Miftah configuration. */
  readonly profile: string;
  /** Required when durable configuration references currently target the removed profile. */
  readonly replacementProfile?: string;
}

export interface ProfileRemovalPlan {
  readonly changed: boolean;
  readonly profile: string;
  readonly replacementProfile?: string;
  readonly config: MiftahConfig;
  readonly actions: readonly string[];
}

/** Public command results deliberately omit candidate configuration and profile contents. */
export type ProfileRemovalReport = Omit<ProfileRemovalPlan, "config"> & {
  readonly write: boolean;
  /** Exact original bytes retained before a real configuration replacement. */
  readonly backupPath?: string;
};

export interface ProfileRemovalAuditSink {
  ensureWritable(): Promise<void>;
  /** Records durable intent before the selected profile is removed. */
  intent(event: { readonly profile: string }): Promise<void>;
  /** Records only a completed durable profile removal. */
  record(event: { readonly profile: string; readonly status: "success" }): Promise<void>;
}

export interface ProfileRemovalDependencies {
  /** A source snapshot already verified by an embedding such as Console. */
  readonly trustedSource?: ConfigMigrationSource;
  /** Console callers provide their own redacted local lifecycle journal. */
  readonly audit?: ProfileRemovalAuditSink;
}

function sourceInput(source: ConfigMigrationSource): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes));
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", "CONFIG_INVALID_JSON: configuration is not valid JSON");
  }
}

function inputInvalid(message: string): never {
  throw new MiftahError("PROFILE_REMOVAL_INPUT_INVALID", `PROFILE_REMOVAL_INPUT_INVALID: ${message}`);
}

function assertProfileRemovalInput(options: ProfileRemovalRequest): void {
  if (typeof options.profile !== "string" || options.profile.length === 0) {
    inputInvalid("choose an existing configured profile");
  }
  if (options.replacementProfile !== undefined && (
    typeof options.replacementProfile !== "string" || options.replacementProfile.length === 0
  )) {
    inputInvalid("choose an existing replacement profile or omit it when no durable reference needs reassignment");
  }
}

function profileNotFound(): never {
  throw new MiftahError(
    "PROFILE_NOT_FOUND",
    "PROFILE_NOT_FOUND: choose an existing configured profile before removing it"
  );
}

function lastProfile(): never {
  throw new MiftahError(
    "PROFILE_LAST_PROFILE",
    "PROFILE_LAST_PROFILE: Miftah refuses to remove the last configured profile"
  );
}

function nativeOAuthBoundProfile(): never {
  throw new MiftahError(
    "PROFILE_REMOVAL_OAUTH_CONNECTION",
    "PROFILE_REMOVAL_OAUTH_CONNECTION: Miftah refuses to remove a profile with a configured native OAuth binding because configuration and OS-vault deletion require one atomic lifecycle"
  );
}

function replacementRequired(): never {
  throw new MiftahError(
    "PROFILE_REPLACEMENT_REQUIRED",
    "PROFILE_REPLACEMENT_REQUIRED: choose a different existing replacement profile before removing durable profile references"
  );
}

function replacementInvalid(): never {
  throw new MiftahError(
    "PROFILE_REPLACEMENT_INVALID",
    "PROFILE_REPLACEMENT_INVALID: choose a different existing replacement profile"
  );
}

function hasNativeOAuthBinding(config: MiftahConfig, profile: string): boolean {
  return config.version === "3" && Object.values(config.oauth?.connections ?? {}).some((connection) => connection.profile === profile);
}

function hasDurableReference(config: MiftahConfig, profile: string): boolean {
  if (config.defaultProfile === profile) return true;
  if (config.routing?.rules?.some((rule) => rule.profile === profile) === true) return true;
  if (config.security?.lockToProfile === profile) return true;
  return config.plugins?.allowlist.some((plugin) => (
    plugin.kind === "routing-matcher" && Object.values(plugin.bindings).some((binding) => binding === profile)
  )) === true;
}

function reassignDurableReferences(config: MiftahConfig, profile: string, replacementProfile: string): void {
  if (config.defaultProfile === profile) config.defaultProfile = replacementProfile;
  for (const rule of config.routing?.rules ?? []) {
    if (rule.profile === profile) rule.profile = replacementProfile;
  }
  if (config.security?.lockToProfile === profile) config.security.lockToProfile = replacementProfile;
  for (const plugin of config.plugins?.allowlist ?? []) {
    if (plugin.kind !== "routing-matcher") continue;
    for (const [binding, target] of Object.entries(plugin.bindings)) {
      if (target === profile) plugin.bindings[binding] = replacementProfile;
    }
  }
}

/**
 * Creates a non-secret plan to remove one selected profile. It only reassigns
 * configuration-owned references after an explicit replacement choice; it
 * never resolves or deletes credentials, provider caches, or OS-vault state.
 */
export function planProfileRemoval(input: unknown, options: ProfileRemovalRequest): ProfileRemovalPlan {
  assertProfileRemovalInput(options);
  const migrated = planConfigMigration(input);
  const config = structuredClone(migrated.config) as MiftahConfig;
  if (!Object.hasOwn(config.profiles, options.profile)) profileNotFound();
  if (Object.keys(config.profiles).length <= 1) lastProfile();
  if (hasNativeOAuthBinding(config, options.profile)) nativeOAuthBoundProfile();

  const referenced = hasDurableReference(config, options.profile);
  const replacementProfile = options.replacementProfile;
  if (referenced && replacementProfile === undefined) replacementRequired();
  if (replacementProfile !== undefined && (
    replacementProfile === options.profile || !Object.hasOwn(config.profiles, replacementProfile)
  )) {
    replacementInvalid();
  }

  if (referenced) {
    // The required check above narrows this for runtime code as well as TypeScript.
    if (replacementProfile === undefined) replacementRequired();
    reassignDurableReferences(config, options.profile, replacementProfile);
  }
  delete config.profiles[options.profile];
  validateConfig(config);

  return {
    changed: true,
    profile: options.profile,
    replacementProfile,
    config,
    actions: [
      ...migrated.actions,
      ...(referenced && replacementProfile !== undefined
        ? [`Reassigned durable profile references from '${options.profile}' to '${replacementProfile}'.`]
        : []),
      `Removed profile '${options.profile}'.`
    ]
  };
}

class ConfiguredProfileRemovalAuditSink implements ProfileRemovalAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/profile-remove-intent",
      name: "profile",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/profile-remove",
      name: "profile",
      profile: event.profile,
      status: event.status
    });
  }
}

function configuredAuditSink(config: MiftahConfig, configPath: string): ProfileRemovalAuditSink | undefined {
  if (config.audit?.enabled === false || config.audit?.path === undefined) return undefined;
  const logger = new AuditLogger(resolvePath(config.audit.path, dirname(configPath)), {
    includeArguments: config.audit.includeArguments,
    failureMode: config.audit.failureMode,
    rotation: config.audit.rotation,
    integrity: config.audit.integrity
  });
  return new ConfiguredProfileRemovalAuditSink(new AuditTrail(config.name, logger));
}

function serializedConfig(config: MiftahConfig): Buffer {
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

function publicReport(plan: ProfileRemovalPlan, write: boolean, backupPath?: string): ProfileRemovalReport {
  return {
    changed: plan.changed,
    profile: plan.profile,
    ...(plan.replacementProfile === undefined ? {} : { replacementProfile: plan.replacementProfile }),
    actions: plan.actions,
    write,
    ...(backupPath === undefined ? {} : { backupPath })
  };
}

async function restoreAfterAuditFailure(
  configPath: string,
  source: ConfigMigrationSource,
  candidate: MiftahConfig
): Promise<void> {
  const replacement = await readConfigMigrationSource(configPath);
  if (!replacement.originalBytes.equals(serializedConfig(candidate))) {
    throw new MiftahError(
      "AUDIT_WRITE_FAILED",
      "AUDIT_WRITE_FAILED: required audit finalization failed and configuration recovery could not be confirmed"
    );
  }
  await restoreConfigReplacementWithoutPublishingBackup(configPath, replacement, source);
}

function auditFailureAfterRestoration(backupPath: string): MiftahError {
  return new MiftahError(
    "AUDIT_WRITE_FAILED",
    `AUDIT_WRITE_FAILED: required audit finalization failed; configuration was restored and the original configuration backup was retained at '${backupPath}'`,
    { backupPaths: [backupPath] }
  );
}

function auditFailureWithUnconfirmedRecovery(backupPath: string): MiftahError {
  return new MiftahError(
    "AUDIT_WRITE_FAILED",
    `AUDIT_WRITE_FAILED: required audit finalization failed and configuration recovery could not be confirmed; the original configuration backup was retained at '${backupPath}'`,
    { backupPaths: [backupPath] }
  );
}

/**
 * Performs one fail-closed, guarded profile removal. It preserves underlying
 * credential, provider-cache, token-cache, and profile-state ownership; only
 * the selected configuration profile and its explicit configuration references change.
 */
export async function runProfileRemoval(
  options: ProfileRemovalRequest,
  dependencies: ProfileRemovalDependencies = {}
): Promise<ProfileRemovalReport> {
  const configPath = resolvePath(options.configPath);
  const source = dependencies.trustedSource ?? await readConfigMigrationSource(configPath);
  const plan = planProfileRemoval(sourceInput(source), { ...options, configPath });
  const audit = dependencies.audit ?? configuredAuditSink(plan.config, configPath);
  await audit?.ensureWritable();
  await audit?.intent({ profile: plan.profile });
  const backupPath = await applyConfigReplacement(configPath, source, plan.config);
  try {
    await audit?.record({ profile: plan.profile, status: "success" });
  } catch {
    try {
      await restoreAfterAuditFailure(configPath, source, plan.config);
    } catch {
      throw auditFailureWithUnconfirmedRecovery(backupPath);
    }
    throw auditFailureAfterRestoration(backupPath);
  }
  return publicReport(plan, true, backupPath);
}
