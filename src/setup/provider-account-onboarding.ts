import { dirname } from "node:path";
import { AuditLogger } from "../audit/audit-logger.js";
import { AuditTrail } from "../audit/audit-trail.js";
import {
  applyConfigReplacement,
  readConfigMigrationSource,
  restoreConfigReplacementWithoutPublishingBackup,
  type ConfigMigrationSource
} from "../cli/migrate-config.js";
import {
  buildProviderAdapterAccountProfile,
  getProviderAdapterForAccountProvisioning,
  ProviderAdapterAccountProfileError
} from "../config/provider-adapters.js";
import { planConfigMigration } from "../config/migrate-config.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig } from "../config/types.js";
import { validateConfig } from "../config/validate-config.js";
import { MiftahError } from "../utils/errors.js";

export interface ProviderAccountAdditionRequest {
  readonly profile: string;
  readonly description?: string;
  /** A non-secret provider credential-file path. The upstream retains its token cache. */
  readonly credentialFile: string;
  /** Changes only the durable default; running MCP clients must still restart. */
  readonly makeDefault?: boolean;
}

export interface ProviderAccountAdditionPlan {
  readonly adapter: string;
  readonly profile: string;
  readonly config: MiftahConfig;
  readonly actions: readonly string[];
}

export interface ProviderAccountAdditionCommandOptions extends ProviderAccountAdditionRequest {
  readonly configPath: string;
}

export interface ProviderAccountAdditionReport extends ProviderAccountAdditionPlan {
  readonly changed: true;
  readonly write: true;
  /** A byte-exact recovery copy created when migration rewrote the selected configuration. */
  readonly backupPath?: string;
}

export interface ProviderAccountAdditionAuditSink {
  ensureWritable(): Promise<void>;
  /** Records the durable intent before Miftah mutates the selected configuration. */
  intent(event: { readonly profile: string }): Promise<void>;
  record(event: { readonly profile: string; readonly status: "success" }): Promise<void>;
}

export interface ProviderAccountAdditionDependencies {
  /** Source captured by a caller that already verified and opened the exact configuration file. */
  readonly trustedSource?: ConfigMigrationSource;
  /** Console callers use their own redacted local lifecycle journal. */
  readonly audit?: ProviderAccountAdditionAuditSink;
}

function sourceInput(source: ConfigMigrationSource): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes));
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", "CONFIG_INVALID_JSON: configuration is not valid JSON");
  }
}

function providerAccountAdditionUnavailable(): never {
  throw new MiftahError(
    "PROVIDER_ACCOUNT_ADDITION_UNSUPPORTED",
    "PROVIDER_ACCOUNT_ADDITION_UNSUPPORTED: this configuration does not support reviewed provider-owned account addition"
  );
}

/**
 * Plans one additional provider-owned account from a fully trusted existing
 * adapter configuration. It never reads a provider token cache or writes any
 * file; callers own the guarded transaction.
 */
export function planProviderAccountAddition(
  input: unknown,
  options: ProviderAccountAdditionCommandOptions
): ProviderAccountAdditionPlan {
  const migrated = planConfigMigration(input);
  const config = structuredClone(migrated.config) as MiftahConfig;
  const adapter = getProviderAdapterForAccountProvisioning(config);
  if (adapter?.accountProvisioning === undefined) {
    providerAccountAdditionUnavailable();
  }
  if (Object.hasOwn(config.profiles, options.profile)) {
    throw new MiftahError("PROFILE_ALREADY_EXISTS", "PROFILE_ALREADY_EXISTS: account profile already exists");
  }

  // Validate the new profile name and durable-default choice before its name
  // can become part of an adapter-owned state-directory path.
  const candidate = structuredClone(config) as MiftahConfig;
  candidate.profiles[options.profile] = {};
  if (options.makeDefault === true) candidate.defaultProfile = options.profile;
  validateConfig(candidate);

  let profile;
  try {
    profile = buildProviderAdapterAccountProfile(adapter, {
      configurationName: candidate.name,
      configurationPath: resolvePath(options.configPath),
      profile: options.profile,
      ...(options.description === undefined ? {} : { description: options.description }),
      credentialFile: options.credentialFile
    });
  } catch (error) {
    if (error instanceof ProviderAdapterAccountProfileError) {
      throw new MiftahError(
        "PROVIDER_ACCOUNT_INPUT_INVALID",
        "PROVIDER_ACCOUNT_INPUT_INVALID: choose an absolute literal credential-file path"
      );
    }
    throw error;
  }
  const stateDirectory = profile.env?.[adapter.accountProvisioning.stateDirectory.environment];
  if (
    typeof stateDirectory !== "string" ||
    Object.values(config.profiles).some(
      (existing) => existing.env?.[adapter.accountProvisioning!.stateDirectory.environment] === stateDirectory
    )
  ) {
    providerAccountAdditionUnavailable();
  }
  candidate.profiles[options.profile] = profile;
  validateConfig(candidate);

  return {
    adapter: adapter.displayName,
    profile: options.profile,
    config: candidate,
    actions: [
      ...migrated.actions,
      `Created provider-owned account profile '${options.profile}'.`,
      ...(options.makeDefault === true ? [`Set durable default profile to '${options.profile}'.`] : [])
    ]
  };
}

class ConfiguredProviderAccountAuditSink implements ProviderAccountAdditionAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/provider-profile-add-intent",
      name: "profile",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/provider-profile-add",
      name: "profile",
      profile: event.profile,
      status: event.status
    });
  }
}

function configuredAuditSink(config: MiftahConfig, configPath: string): ProviderAccountAdditionAuditSink | undefined {
  if (config.audit?.enabled === false || config.audit?.path === undefined) return undefined;
  const logger = new AuditLogger(resolvePath(config.audit.path, dirname(configPath)), {
    includeArguments: config.audit.includeArguments,
    failureMode: config.audit.failureMode,
    rotation: config.audit.rotation,
    integrity: config.audit.integrity
  });
  return new ConfiguredProviderAccountAuditSink(new AuditTrail(config.name, logger));
}

function serializedConfig(config: MiftahConfig): Buffer {
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

async function restoreAfterAuditFailure(
  configPath: string,
  source: ConfigMigrationSource,
  candidate: MiftahConfig
): Promise<void> {
  const replacement = await readConfigMigrationSource(configPath);
  // Refuse to overwrite an externally changed candidate. The durable intent
  // record remains available for reconciliation when recovery cannot proceed.
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

/** Performs one fail-closed, guarded account-profile replacement with a recovery backup when needed. */
export async function runProviderAccountAddition(
  options: ProviderAccountAdditionCommandOptions,
  dependencies: ProviderAccountAdditionDependencies = {}
): Promise<ProviderAccountAdditionReport> {
  const configPath = resolvePath(options.configPath);
  const source = dependencies.trustedSource ?? await readConfigMigrationSource(configPath);
  const plan = planProviderAccountAddition(sourceInput(source), { ...options, configPath });
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
  return {
    changed: true,
    write: true,
    ...plan,
    ...(backupPath === undefined ? {} : { backupPath })
  };
}
