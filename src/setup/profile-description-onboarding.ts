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

export interface ProfileDescriptionChangeRequest {
  readonly configPath: string;
  /** One existing account profile whose non-secret label will be changed. */
  readonly profile: string;
  /** A trimmed human-facing label; use clearDescription to remove one explicitly. */
  readonly description?: string;
  /** Explicitly removes the existing non-secret profile description. */
  readonly clearDescription?: true;
}

export interface ProfileDescriptionChangePlan {
  readonly changed: boolean;
  readonly profile: string;
  readonly cleared: boolean;
  readonly config: MiftahConfig;
  readonly actions: readonly string[];
}

/** Public command results deliberately omit the candidate configuration and description value. */
export type ProfileDescriptionChangeReport = Omit<ProfileDescriptionChangePlan, "config"> & {
  readonly write: boolean;
  /** Exact original bytes retained before a real configuration replacement. */
  readonly backupPath?: string;
};

export interface ProfileDescriptionChangeAuditSink {
  ensureWritable(): Promise<void>;
  /** Records durable intent before the selected profile label is changed. */
  intent(event: { readonly profile: string; readonly cleared: boolean }): Promise<void>;
  /** Records only a completed durable profile-label change. */
  record(event: { readonly profile: string; readonly cleared: boolean; readonly status: "success" }): Promise<void>;
}

export interface ProfileDescriptionChangeDependencies {
  /** A source snapshot already verified by an embedding such as Console. */
  readonly trustedSource?: ConfigMigrationSource;
  /** Console callers provide their own redacted local lifecycle journal. */
  readonly audit?: ProfileDescriptionChangeAuditSink;
}

function sourceInput(source: ConfigMigrationSource): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes));
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", "CONFIG_INVALID_JSON: configuration is not valid JSON");
  }
}

function inputInvalid(message: string): never {
  throw new MiftahError("PROFILE_DESCRIPTION_INPUT_INVALID", `PROFILE_DESCRIPTION_INPUT_INVALID: ${message}`);
}

function assertProfile(profile: unknown): asserts profile is string {
  if (typeof profile !== "string" || profile.length === 0) {
    inputInvalid("choose an existing configured profile");
  }
}

function assertDescriptionChange(options: ProfileDescriptionChangeRequest): asserts options is ProfileDescriptionChangeRequest & {
  readonly description: string;
  readonly clearDescription?: undefined;
} | ProfileDescriptionChangeRequest & {
  readonly description?: undefined;
  readonly clearDescription: true;
} {
  const clearRequested = options.clearDescription === true;
  if (options.clearDescription !== undefined && !clearRequested) {
    inputInvalid("use clear-description only to explicitly remove a profile description");
  }
  if (clearRequested === (options.description !== undefined)) {
    inputInvalid("provide one trimmed profile description or explicitly clear it");
  }
  if (clearRequested) return;
  const description = options.description;
  if (
    typeof description !== "string" ||
    description.length === 0 ||
    description.length > 1_024 ||
    description.trim() !== description ||
    Array.from(description).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    inputInvalid("choose a trimmed profile description without control characters");
  }
}

function profileNotFound(): never {
  throw new MiftahError(
    "PROFILE_NOT_FOUND",
    "PROFILE_NOT_FOUND: choose an existing configured profile before changing its description"
  );
}

/**
 * Creates a non-secret plan to change only one profile description. It never
 * starts an upstream, authorizes OAuth, resolves a credential, or changes
 * routing, default selection, or profile ownership.
 */
export function planProfileDescriptionChange(
  input: unknown,
  options: ProfileDescriptionChangeRequest
): ProfileDescriptionChangePlan {
  assertProfile(options.profile);
  assertDescriptionChange(options);

  const migrated = planConfigMigration(input);
  const config = structuredClone(migrated.config) as MiftahConfig;
  const profile = config.profiles[options.profile];
  if (profile === undefined) profileNotFound();

  const cleared = options.clearDescription === true;
  const descriptionChanged = cleared
    ? profile.description !== undefined
    : profile.description !== options.description;
  if (cleared) {
    delete profile.description;
  } else {
    profile.description = options.description;
  }
  validateConfig(config);

  return {
    changed: migrated.changed || descriptionChanged,
    profile: options.profile,
    cleared,
    config,
    actions: [
      ...migrated.actions,
      cleared
        ? descriptionChanged
          ? `Cleared profile description for '${options.profile}'.`
          : `Profile description is already clear for '${options.profile}'.`
        : descriptionChanged
          ? `Set profile description for '${options.profile}'.`
          : `Profile description for '${options.profile}' is already current.`
    ]
  };
}

class ConfiguredProfileDescriptionAuditSink implements ProfileDescriptionChangeAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string; readonly cleared: boolean }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/profile-description-set-intent",
      name: event.cleared ? "profile description clear" : "profile description set",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly cleared: boolean; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/profile-description-set",
      name: event.cleared ? "profile description clear" : "profile description set",
      profile: event.profile,
      status: event.status
    });
  }
}

function configuredAuditSink(config: MiftahConfig, configPath: string): ProfileDescriptionChangeAuditSink | undefined {
  if (config.audit?.enabled === false || config.audit?.path === undefined) return undefined;
  const logger = new AuditLogger(resolvePath(config.audit.path, dirname(configPath)), {
    includeArguments: config.audit.includeArguments,
    failureMode: config.audit.failureMode,
    rotation: config.audit.rotation,
    integrity: config.audit.integrity
  });
  return new ConfiguredProfileDescriptionAuditSink(new AuditTrail(config.name, logger));
}

function serializedConfig(config: MiftahConfig): Buffer {
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

function publicReport(
  plan: ProfileDescriptionChangePlan,
  write: boolean,
  backupPath?: string
): ProfileDescriptionChangeReport {
  return {
    changed: plan.changed,
    profile: plan.profile,
    cleared: plan.cleared,
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
 * Performs one fail-closed, guarded profile-description replacement. Existing
 * OAuth, routing, durable-default, credential, and token-cache ownership is
 * retained exactly from the trusted source configuration.
 */
export async function runProfileDescriptionChange(
  options: ProfileDescriptionChangeRequest,
  dependencies: ProfileDescriptionChangeDependencies = {}
): Promise<ProfileDescriptionChangeReport> {
  const configPath = resolvePath(options.configPath);
  const source = dependencies.trustedSource ?? await readConfigMigrationSource(configPath);
  const plan = planProfileDescriptionChange(sourceInput(source), { ...options, configPath });
  if (!plan.changed) return publicReport(plan, false);

  const audit = dependencies.audit ?? configuredAuditSink(plan.config, configPath);
  await audit?.ensureWritable();
  await audit?.intent({ profile: plan.profile, cleared: plan.cleared });
  const backupPath = await applyConfigReplacement(configPath, source, plan.config);
  try {
    await audit?.record({ profile: plan.profile, cleared: plan.cleared, status: "success" });
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
