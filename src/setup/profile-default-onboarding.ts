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

export interface DefaultProfileChangeRequest {
  readonly configPath: string;
  /** One existing configuration profile to make durable across new sessions. */
  readonly profile: string;
}

export interface DefaultProfileChangePlan {
  readonly changed: boolean;
  readonly profile: string;
  readonly config: MiftahConfig;
  readonly actions: readonly string[];
}

/** Public command results deliberately omit the candidate configuration. */
export type DefaultProfileChangeReport = Omit<DefaultProfileChangePlan, "config"> & {
  readonly write: boolean;
  /** Exact original bytes retained before a real configuration replacement. */
  readonly backupPath?: string;
};

export interface DefaultProfileChangeAuditSink {
  ensureWritable(): Promise<void>;
  /** Records durable intent before the selected configuration is changed. */
  intent(event: { readonly profile: string }): Promise<void>;
  /** Records only a completed durable default-profile change. */
  record(event: { readonly profile: string; readonly status: "success" }): Promise<void>;
}

export interface DefaultProfileChangeDependencies {
  /** A source snapshot already verified by an embedding such as Console. */
  readonly trustedSource?: ConfigMigrationSource;
  /** Console callers provide their own redacted local lifecycle journal. */
  readonly audit?: DefaultProfileChangeAuditSink;
}

function sourceInput(source: ConfigMigrationSource): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes));
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", "CONFIG_INVALID_JSON: configuration is not valid JSON");
  }
}

function profileNotFound(): never {
  throw new MiftahError(
    "PROFILE_NOT_FOUND",
    "PROFILE_NOT_FOUND: choose an existing configured profile before changing the durable default"
  );
}

/**
 * Creates a non-secret plan to change only the durable default profile. It
 * never starts an upstream, authorizes OAuth, or changes any profile data.
 */
export function planDefaultProfileChange(input: unknown, options: DefaultProfileChangeRequest): DefaultProfileChangePlan {
  const migrated = planConfigMigration(input);
  const config = structuredClone(migrated.config) as MiftahConfig;
  if (!Object.hasOwn(config.profiles, options.profile)) profileNotFound();

  const defaultChanged = config.defaultProfile !== options.profile;
  config.defaultProfile = options.profile;
  validateConfig(config);

  return {
    changed: migrated.changed || defaultChanged,
    profile: options.profile,
    config,
    actions: [
      ...migrated.actions,
      defaultChanged
        ? `Set durable default profile to '${options.profile}'.`
        : `Durable default profile is already '${options.profile}'.`
    ]
  };
}

class ConfiguredDefaultProfileAuditSink implements DefaultProfileChangeAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/default-profile-set-intent",
      name: "profile",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/default-profile-set",
      name: "profile",
      profile: event.profile,
      status: event.status
    });
  }
}

function configuredAuditSink(config: MiftahConfig, configPath: string): DefaultProfileChangeAuditSink | undefined {
  if (config.audit?.enabled === false || config.audit?.path === undefined) return undefined;
  const logger = new AuditLogger(resolvePath(config.audit.path, dirname(configPath)), {
    includeArguments: config.audit.includeArguments,
    failureMode: config.audit.failureMode,
    rotation: config.audit.rotation,
    integrity: config.audit.integrity
  });
  return new ConfiguredDefaultProfileAuditSink(new AuditTrail(config.name, logger));
}

function serializedConfig(config: MiftahConfig): Buffer {
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

function publicReport(
  plan: DefaultProfileChangePlan,
  write: boolean,
  backupPath?: string
): DefaultProfileChangeReport {
  return {
    changed: plan.changed,
    profile: plan.profile,
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
 * Performs one fail-closed, guarded durable-default replacement. Provider
 * credential and token-cache ownership is untouched because profile content is
 * retained exactly from the trusted source configuration.
 */
export async function runDefaultProfileChange(
  options: DefaultProfileChangeRequest,
  dependencies: DefaultProfileChangeDependencies = {}
): Promise<DefaultProfileChangeReport> {
  const configPath = resolvePath(options.configPath);
  const source = dependencies.trustedSource ?? await readConfigMigrationSource(configPath);
  const plan = planDefaultProfileChange(sourceInput(source), { ...options, configPath });
  if (!plan.changed) return publicReport(plan, false);

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
