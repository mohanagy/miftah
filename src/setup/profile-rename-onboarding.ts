import { dirname } from "node:path";
import { AuditLogger } from "../audit/audit-logger.js";
import { AuditTrail } from "../audit/audit-trail.js";
import {
  applyConfigReplacement,
  readConfigMigrationSource,
  restoreConfigReplacementWithoutPublishingBackup,
  type ConfigMigrationSource
} from "../cli/migrate-config.js";
import { assertSafeProviderAdapterAccountProfileName, ProviderAdapterAccountProfileError } from "../config/provider-adapters.js";
import { planConfigMigration } from "../config/migrate-config.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig } from "../config/types.js";
import { validateConfig } from "../config/validate-config.js";
import { MiftahError } from "../utils/errors.js";

export interface ProfileRenameRequest {
  readonly configPath: string;
  /** Existing configured profile identifier to rename. */
  readonly profile: string;
  /** New safe profile identifier; this is never a credential or a state-directory path. */
  readonly newProfile: string;
}

export interface ProfileRenamePlan {
  readonly changed: true;
  readonly profile: string;
  readonly newProfile: string;
  readonly config: MiftahConfig;
  readonly actions: readonly string[];
}

/** Public results deliberately omit the candidate configuration and profile contents. */
export type ProfileRenameReport = Omit<ProfileRenamePlan, "config"> & {
  readonly write: true;
  /** Exact original bytes retained before the guarded replacement. */
  readonly backupPath?: string;
};

export interface ProfileRenameAuditSink {
  ensureWritable(): Promise<void>;
  /** Records durable intent before the selected profile key is replaced. */
  intent(event: { readonly profile: string; readonly newProfile: string }): Promise<void>;
  /** Records only a completed durable profile rename. */
  record(event: { readonly profile: string; readonly newProfile: string; readonly status: "success" }): Promise<void>;
}

export interface ProfileRenameDependencies {
  /** A source snapshot already verified by an embedding such as Console. */
  readonly trustedSource?: ConfigMigrationSource;
  /** Console callers provide their own redacted local lifecycle journal. */
  readonly audit?: ProfileRenameAuditSink;
}

function sourceInput(source: ConfigMigrationSource): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes));
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", "CONFIG_INVALID_JSON: configuration is not valid JSON");
  }
}

function inputInvalid(message: string): never {
  throw new MiftahError("PROFILE_RENAME_INPUT_INVALID", `PROFILE_RENAME_INPUT_INVALID: ${message}`);
}

function assertProfileRenameInput(options: ProfileRenameRequest): void {
  if (typeof options.profile !== "string" || options.profile.length === 0) {
    inputInvalid("choose an existing configured profile");
  }
  if (typeof options.newProfile !== "string") inputInvalid("choose a distinct safe profile name");
  try {
    assertSafeProviderAdapterAccountProfileName(options.newProfile);
  } catch (error) {
    if (error instanceof ProviderAdapterAccountProfileError) inputInvalid("choose a distinct safe profile name");
    throw error;
  }
  if (options.newProfile === options.profile) inputInvalid("choose a distinct safe profile name");
}

function profileNotFound(): never {
  throw new MiftahError(
    "PROFILE_NOT_FOUND",
    "PROFILE_NOT_FOUND: choose an existing configured profile before renaming it"
  );
}

function profileAlreadyExists(): never {
  throw new MiftahError(
    "PROFILE_ALREADY_EXISTS",
    "PROFILE_ALREADY_EXISTS: choose a profile name that is not already configured"
  );
}

function nativeOAuthBoundProfile(): never {
  throw new MiftahError(
    "PROFILE_RENAME_OAUTH_CONNECTION",
    "PROFILE_RENAME_OAUTH_CONNECTION: Miftah refuses to rename a profile with a configured native OAuth binding because its OS-vault credential is bound to the current profile name"
  );
}

function hasNativeOAuthBinding(config: MiftahConfig, profile: string): boolean {
  return config.version === "3" && Object.values(config.oauth?.connections ?? {}).some((connection) => connection.profile === profile);
}

function renameDurableReferences(config: MiftahConfig, profile: string, newProfile: string): void {
  if (config.defaultProfile === profile) config.defaultProfile = newProfile;
  for (const rule of config.routing?.rules ?? []) {
    if (rule.profile === profile) rule.profile = newProfile;
  }
  if (config.security?.lockToProfile === profile) config.security.lockToProfile = newProfile;
  for (const plugin of config.plugins?.allowlist ?? []) {
    if (plugin.kind !== "routing-matcher") continue;
    for (const [binding, target] of Object.entries(plugin.bindings)) {
      if (target === profile) plugin.bindings[binding] = newProfile;
    }
  }
}

/**
 * Creates a non-secret plan to rename a profile and every configuration-owned
 * profile reference. Native OAuth-bound profiles are refused because their
 * credential-vault key is intentionally bound to the current profile name.
 */
export function planProfileRename(input: unknown, options: ProfileRenameRequest): ProfileRenamePlan {
  assertProfileRenameInput(options);
  const migrated = planConfigMigration(input);
  const config = structuredClone(migrated.config) as MiftahConfig;
  const profile = config.profiles[options.profile];
  if (profile === undefined) profileNotFound();
  if (Object.hasOwn(config.profiles, options.newProfile)) profileAlreadyExists();
  if (hasNativeOAuthBinding(config, options.profile)) nativeOAuthBoundProfile();

  delete config.profiles[options.profile];
  config.profiles[options.newProfile] = profile;
  renameDurableReferences(config, options.profile, options.newProfile);
  validateConfig(config);

  return {
    changed: true,
    profile: options.profile,
    newProfile: options.newProfile,
    config,
    actions: [
      ...migrated.actions,
      `Renamed profile '${options.profile}' to '${options.newProfile}'.`
    ]
  };
}

class ConfiguredProfileRenameAuditSink implements ProfileRenameAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string; readonly newProfile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/profile-rename-intent",
      name: event.newProfile,
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly newProfile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/profile-rename",
      name: event.newProfile,
      profile: event.profile,
      status: event.status
    });
  }
}

function configuredAuditSink(config: MiftahConfig, configPath: string): ProfileRenameAuditSink | undefined {
  if (config.audit?.enabled === false || config.audit?.path === undefined) return undefined;
  const logger = new AuditLogger(resolvePath(config.audit.path, dirname(configPath)), {
    includeArguments: config.audit.includeArguments,
    failureMode: config.audit.failureMode,
    rotation: config.audit.rotation,
    integrity: config.audit.integrity
  });
  return new ConfiguredProfileRenameAuditSink(new AuditTrail(config.name, logger));
}

function serializedConfig(config: MiftahConfig): Buffer {
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

function publicReport(plan: ProfileRenamePlan, backupPath?: string): ProfileRenameReport {
  return {
    changed: true,
    profile: plan.profile,
    newProfile: plan.newProfile,
    actions: plan.actions,
    write: true,
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
 * Performs one fail-closed guarded profile rename. It modifies only the
 * selected configuration file and its configuration-owned references; no
 * provider cache, OS-vault credential, identity record, profile state, or
 * active client session is read, moved, copied, deleted, or otherwise changed.
 */
export async function runProfileRename(
  options: ProfileRenameRequest,
  dependencies: ProfileRenameDependencies = {}
): Promise<ProfileRenameReport> {
  const configPath = resolvePath(options.configPath);
  const source = dependencies.trustedSource ?? await readConfigMigrationSource(configPath);
  const plan = planProfileRename(sourceInput(source), { ...options, configPath });
  const audit = dependencies.audit ?? configuredAuditSink(plan.config, configPath);
  await audit?.ensureWritable();
  await audit?.intent({ profile: plan.profile, newProfile: plan.newProfile });
  const backupPath = await applyConfigReplacement(configPath, source, plan.config);
  try {
    await audit?.record({ profile: plan.profile, newProfile: plan.newProfile, status: "success" });
  } catch {
    try {
      await restoreAfterAuditFailure(configPath, source, plan.config);
    } catch {
      throw auditFailureWithUnconfirmedRecovery(backupPath);
    }
    throw auditFailureAfterRestoration(backupPath);
  }
  return publicReport(plan, backupPath);
}
